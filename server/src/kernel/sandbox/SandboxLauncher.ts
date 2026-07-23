/**
 * SandboxLauncher — arapuca Process-Level Sandbox Integration
 *
 * The integration layer between the run lifecycle and arapuca. Resolves the
 * run's allowed path set (deny-by-default), probes the host for arapuca, and
 * generates a wrapper script so the vendor CLI runs inside an arapuca-narrowed
 * process transparently.
 *
 * ## Flow
 * 1. `probeArapuca()` — confirms the arapuca binary + platform capability. A
 *    failure hard-fails a sandbox-enabled run (never a silent host fallback).
 * 2. `launchSandbox(workspaceRoot, worktree)` — resolves the allowed path set
 *    (workspace root ro, worktree rw, specsBase rw, extraMounts) and mints a
 *    per-run temp dir. Returns paths + tmpDir + a `cleanup()`.
 * 3. `createSandboxWrapper(paths, entryCommand, tmpDir, opts)` — writes a POSIX
 *    shell script that `exec`s `arapuca run -v …:ro -v …:rw -- <cli> "$@"`. The
 *    path is passed to the vendor SDK as `pathToClaudeCodeExecutable` /
 *    `codexPathOverride`. The SDK spawns it as a normal subprocess; the child
 *    inherits the SDK-provided env (arapuca strips only LD_/DYLD_/ARAPUCA_
 *    prefixes) — so no env-file is needed. `opts.allowKeychain` carries the
 *    resolved agent's auth mode; host proxy variables are detected here.
 *
 * Host prerequisite: arapuca ≥ 0.2.5 (`--allow-proxy-env` / `--allow-keychain`).
 * c3 does no version negotiation — an older binary rejects the unknown flag and
 * the run fails closed, as every other sandbox launch failure does.
 *
 * Same-path principle: a host `/abs/path` is the same `/abs/path` the process
 * sees; the wrapper only tags paths ro/rw. There is no container, no bind
 * mount, no path rewrite, no long-lived process to stop — cleanup just removes
 * the temp dir.
 *
 * Layer: kernel/sandbox (inner domain)
 *
 * @module
 */

import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  realpathSync,
  accessSync,
  constants as fsConstants,
} from 'node:fs'
import { homedir } from 'node:os'
import { join, delimiter, sep } from 'node:path'
import { getProjectSandbox } from '../../kernel/config/index.js'
import {
  getSpecsBase,
  getSandboxCodexHome,
  getSandboxClaudeConfigDir,
} from '../../kernel/config/workspace-path.js'
import type { SysExtraMount, SessionKind } from '@ccc/shared/protocol'
import type {
  ResolvedMount,
  ResolvedSandboxPaths,
  ArapucaProbeResult,
  SandboxUiCode,
  WorkspaceSandboxConfig,
} from './types.js'

// ─── System Default Mounts ───────────────────────────────────────────────────

/**
 * The workspace-scoped built-in sandbox allow set — the single source of truth
 * for the fixed allowances derivable from the workspace path: the project
 * directory (ro) and the centralized specs root (rw). Consumed BOTH at launch
 * (folded into {@link resolvePaths}) and by the settings handler for read-only
 * display next to the editable `extraMounts`.
 *
 * The run's execution root (rw) is a per-run fixed allowance and is NOT included
 * here — it is not derivable from the workspace path alone. When the execution
 * root IS the workspace path (a current-branch run), `resolvePaths` collapses
 * the workspace-root ro entry into that single rw grant.
 *
 * Paths are raw (not canonicalized): `resolvePaths` canonicalizes at launch,
 * while the UI shows the intended host paths.
 */
export function sysExtraMounts(workspaceRoot: string): SysExtraMount[] {
  return [
    { key: 'workspaceRoot', path: workspaceRoot, readonly: true },
    { key: 'specs', path: getSpecsBase(workspaceRoot), readonly: false },
  ]
}

// ─── Eligibility ─────────────────────────────────────────────────────────────

/**
 * Decide whether a run enters the sandbox. The entry condition is purely the
 * workspace config's `enabled` master switch AND the run's `sessionKind` being
 * in the workspace `sandboxSessionKinds` allowlist (default `['work']`), gated by
 * the host capability/policy (`sandboxEnabled`, `sandboxAllowed`). It does NOT
 * depend on the run's source (Intent / spec / plain), on whether the run has an
 * isolated worktree, or on the git branch mode — those never appear here, so an
 * Intent run and a plain work run with the same kind decide identically.
 */
export function sandboxEligible(params: {
  /** Host capability/wiring gate from the composition root. */
  readonly sandboxEnabled: boolean
  /** Runtime policy hook result (false suppresses the sandbox). */
  readonly sandboxAllowed: boolean
  /** The workspace's normalized sandbox config (undefined ⇒ not configured). */
  readonly config: WorkspaceSandboxConfig | undefined
  /** The run's session kind. */
  readonly sessionKind: SessionKind
}): boolean {
  if (!params.sandboxEnabled || !params.sandboxAllowed) return false
  if (!params.config?.enabled) return false
  const kinds = params.config.sandboxSessionKinds ?? ['work']
  return kinds.includes(params.sessionKind)
}

// ─── Typed Errors ────────────────────────────────────────────────────────────

/**
 * A sandbox launch failure carrying a stable {@link SandboxUiCode}. Thrown by
 * path resolution (illegal / escaping path) and surfaced by the run lifecycle
 * as a hard-fail — never a silent host fallback.
 */
export class SandboxLaunchError extends Error {
  readonly uiCode: SandboxUiCode
  constructor(uiCode: SandboxUiCode, message: string) {
    super(message)
    this.name = 'SandboxLaunchError'
    this.uiCode = uiCode
  }
}

// ─── arapuca Probe ───────────────────────────────────────────────────────────

/** Cached probe result — arapuca availability does not change within a process. */
let probeCache: ArapucaProbeResult | undefined

/** Binary name looked up on the host PATH. */
const ARAPUCA_BIN = 'arapuca'

/**
 * Find an executable named `bin` on the host PATH. Returns the absolute path or
 * null when not found / not executable.
 */
function findOnPath(bin: string): string | null {
  const pathEnv = process.env.PATH ?? ''
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue
    const candidate = join(dir, bin)
    try {
      accessSync(candidate, fsConstants.X_OK)
      return candidate
    } catch {
      // not here — keep scanning
    }
  }
  return null
}

/**
 * Probe the host for arapuca + platform capability. Cached.
 *
 * Current scope is directory ro/rw MAC, which all three platforms support
 * (Linux Landlock / macOS Seatbelt / Windows AppContainer), so the platform
 * gate only rejects unknown platforms. A missing binary yields
 * `arapuca-missing`; the UI turns the code into a localized "install arapuca"
 * hint.
 */
export function probeArapuca(): ArapucaProbeResult {
  if (probeCache) return probeCache
  const platform = process.platform
  if (platform !== 'linux' && platform !== 'darwin' && platform !== 'win32') {
    probeCache = { ok: false, uiCode: 'platform-unsupported' }
    return probeCache
  }
  // macOS does not permit applying a second Seatbelt profile from a process
  // that is already sandboxed. arapuca's binary probe would succeed, but the
  // later `sandbox-exec` child would immediately fail with EPERM. Detect the
  // host application's explicit sandbox markers before creating a run that can
  // never bind to a native vendor session.
  if (
    platform === 'darwin' &&
    (process.env.CODEX_SANDBOX || process.env.APP_SANDBOX_CONTAINER_ID)
  ) {
    probeCache = { ok: false, uiCode: 'nested-sandbox-unsupported' }
    return probeCache
  }
  const bin = findOnPath(ARAPUCA_BIN)
  probeCache = bin ? { ok: true, path: bin } : { ok: false, uiCode: 'arapuca-missing' }
  return probeCache
}

/** Test-only: drop the cached probe so the next call re-scans PATH. */
export function resetArapucaProbeForTests(): void {
  probeCache = undefined
}

// ─── Path Resolution ─────────────────────────────────────────────────────────

/**
 * Sensitive directories never exposed to the sandbox even if listed in
 * `extraMounts`. Anchored at the current host user's home. The home root itself
 * is denied (mounting all of `$HOME` would defeat deny-by-default), plus known
 * credential stores and `/etc`. Fixed allowances (workspace root / worktree /
 * specsBase) are trusted by construction and not checked against this list.
 */
function denyList(): string[] {
  const home = homedir()
  return [
    home,
    join(home, '.ssh'),
    join(home, '.aws'),
    join(home, '.gnupg'),
    join(home, '.config', 'gh'),
    join(home, '.kube'),
    join(home, '.docker'),
    '/etc',
  ]
}

/** Whether `child` is `parent` or lives underneath it (path-segment aware). */
function isWithin(child: string, parent: string): boolean {
  if (child === parent) return true
  const p = parent.endsWith(sep) ? parent : parent + sep
  return child.startsWith(p)
}

/**
 * Canonicalize a host path (resolving symlinks). Throws {@link SandboxLaunchError}
 * (`path-illegal`) when the path does not exist — a mount target must be real,
 * and canonicalize is the softlink-escape guard (the returned real path is what
 * gets checked against reserved/deny lists).
 */
function canonicalize(path: string, label: string): string {
  try {
    return realpathSync(path)
  } catch {
    throw new SandboxLaunchError('path-illegal', `sandbox path does not exist (${label}): ${path}`)
  }
}

/**
 * Resolve the full allowed path set for a run.
 *
 * Fixed allowances: execution root (rw), workspace root (ro), specsBase (rw).
 * The `executionRoot` is the run's actual code directory — an isolated worktree,
 * or the source workspace for a current-branch / no-isolated-cwd run. When it is
 * the same canonical path as the workspace root, the two collapse into a single
 * rw grant (no conflicting ro/rw pair). The specs root is created if missing (it
 * is a write target for reverse-sync). Supplementary `extraMounts` are
 * canonicalized, checked against the reserved paths (no overlap either
 * direction) and the denylist, and dropped when they point at a non-existent
 * path (skipped, not fatal — unlike a security violation, which throws).
 *
 * @throws {@link SandboxLaunchError} on reserved-path overlap or denylist hit.
 */
export function resolvePaths(
  workspaceRoot: string,
  executionRoot: string,
  extraMounts: readonly { path: string; readonly?: boolean }[] = [],
): ResolvedSandboxPaths {
  const canonExecutionRoot = canonicalize(executionRoot, 'executionRoot')
  // Workspace-scoped fixed allowances from the single source of truth. A rw
  // system mount (the specs root) is a write target: ensure it exists so it can
  // be canonicalized and written.
  const sys = sysExtraMounts(workspaceRoot)
  for (const m of sys) {
    if (!m.readonly) {
      try {
        mkdirSync(m.path, { recursive: true })
      } catch {
        // best-effort; canonicalize below will surface a real failure
      }
    }
  }
  const canonSys = new Map(sys.map((m) => [m.key, canonicalize(m.path, m.key)]))
  const canonWorkspaceRoot = canonSys.get('workspaceRoot')!
  const canonSpecsBase = canonSys.get('specs')!
  // Persistent per-workspace sandbox CODEX_HOME (rw). It lives OUTSIDE the
  // execution root (under c3 home), so unlike the per-run temp dir it survives
  // cleanup — codex thread rollouts persist here for the next turn's `resume`.
  // Ensure it exists so it can be canonicalized and written, then treat it as a
  // reserved allowance (extraMounts must not overlap it).
  const sandboxCodexHome = getSandboxCodexHome(workspaceRoot)
  try {
    mkdirSync(sandboxCodexHome, { recursive: true })
  } catch {
    // best-effort; canonicalize below will surface a real failure
  }
  const canonCodexHome = canonicalize(sandboxCodexHome, 'codexHome')
  // The claude config dir a sandbox claude run uses (rw). It is the HOST claude
  // config dir (so the transcript is host-readable via the SDK), which already
  // exists; ensure + canonicalize + reserve it just like codexHome. Mounted only
  // for a claude run (createSandboxWrapper), but resolved unconditionally so the
  // path set is vendor-neutral.
  const sandboxClaudeConfigDir = getSandboxClaudeConfigDir(workspaceRoot)
  try {
    mkdirSync(sandboxClaudeConfigDir, { recursive: true })
  } catch {
    // best-effort; canonicalize below will surface a real failure
  }
  const canonClaudeConfigDir = canonicalize(sandboxClaudeConfigDir, 'claudeConfigDir')
  // Current-branch (and no-isolated-cwd) runs execute in the workspace itself:
  // the ro workspace-root allowance is merged into the rw execution-root grant.
  const sameRoot = canonWorkspaceRoot === canonExecutionRoot

  const reserved = [canonExecutionRoot, ...canonSys.values(), canonCodexHome, canonClaudeConfigDir]
  // Canonicalize denied dirs (best-effort) so a symlinked system path (e.g. macOS
  // /etc → /private/etc) still matches an extraMount's canonicalized real path.
  const denied = denyList().map((d) => {
    try {
      return realpathSync(d)
    } catch {
      return d
    }
  })
  const seen = new Set<string>(reserved)
  const extra: ResolvedMount[] = []

  for (const mount of extraMounts) {
    let canon: string
    try {
      canon = realpathSync(mount.path)
    } catch {
      // Non-existent supplementary dir: skip (not a security violation).
      console.warn(`[sandbox] extraMount skipped (path does not exist): ${mount.path}`)
      continue
    }
    // Reserved-path overlap (either direction) is illegal — extraMounts must not
    // cover or be covered by execution root / workspace root / specsBase.
    for (const r of reserved) {
      if (isWithin(canon, r) || isWithin(r, canon)) {
        throw new SandboxLaunchError(
          'path-illegal',
          `sandbox extraMount overlaps a reserved path: ${canon}`,
        )
      }
    }
    // Denylist: credential stores / home root / /etc are never exposed.
    for (const d of denied) {
      if (isWithin(canon, d)) {
        throw new SandboxLaunchError(
          'path-illegal',
          `sandbox extraMount targets a denied directory: ${canon}`,
        )
      }
    }
    if (seen.has(canon)) continue
    seen.add(canon)
    extra.push({ path: canon, readonly: mount.readonly !== false })
  }

  return {
    executionRoot: canonExecutionRoot,
    // Omit the ro workspace-root grant when it is the same path as the rw
    // execution root — a single rw mount, never a conflicting ro/rw pair.
    ...(sameRoot ? {} : { workspaceRoot: canonWorkspaceRoot }),
    specsBase: canonSpecsBase,
    codexHome: canonCodexHome,
    claudeConfigDir: canonClaudeConfigDir,
    extra,
  }
}

// ─── Launch ──────────────────────────────────────────────────────────────────

/** Result of a successful sandbox launch. The caller owns `cleanup()`. */
export interface SandboxLaunchResult {
  /** The resolved, canonicalized allowed path set. */
  readonly paths: ResolvedSandboxPaths
  /** Per-run temp dir holding the wrapper script. Removed by `cleanup()`. */
  readonly tmpDir: string
  /** Remove the temp dir. Idempotent; no container to stop. */
  cleanup: () => void
}

/**
 * Prepare an arapuca sandbox for a run whose workspace enabled the sandbox and
 * whose session kind is in the sandbox allowlist.
 *
 * The config is keyed by the workspace (`workspaceRoot`); the read-write code
 * path is the run's `executionRoot` — an isolated worktree, or the source
 * workspace for a current-branch / no-isolated-cwd run. Probing is the caller's
 * first gate (`probeArapuca`), but this also throws if resolution finds an
 * illegal path — both settle the run as a hard-fail.
 *
 * @throws {@link SandboxLaunchError} when probe fails or a path is illegal.
 */
export function launchSandbox(workspaceRoot: string, executionRoot: string): SandboxLaunchResult {
  const probe = probeArapuca()
  if (!probe.ok) {
    throw new SandboxLaunchError(
      probe.uiCode,
      probe.uiCode === 'platform-unsupported'
        ? `sandbox is unsupported on this platform (${process.platform})`
        : probe.uiCode === 'nested-sandbox-unsupported'
          ? 'nested macOS sandbox is unsupported (start c3 outside the parent sandbox)'
          : 'arapuca binary not found on PATH (install it to use the sandbox)',
    )
  }

  const sbCfg = getProjectSandbox(workspaceRoot)
  const paths = resolvePaths(workspaceRoot, executionRoot, sbCfg?.extraMounts ?? [])
  // The per-run temp dir holds ONLY the wrapper script — it is deleted on cleanup.
  // Codex process state (CODEX_HOME) lives in the persistent per-workspace home
  // (`paths.codexHome`, ensured by resolvePaths), NOT here, so thread rollouts
  // survive for the next turn's `resume`.
  const tmpDir = mkdtempSync(join(paths.executionRoot, '.c3-sb-'))

  console.log(
    `[sandbox] arapuca wrapper prepared: exec(rw)=${paths.executionRoot} ` +
      `root(ro)=${paths.workspaceRoot ?? '(merged into exec)'} ` +
      `specs(rw)=${paths.specsBase} codexHome(rw)=${paths.codexHome} extra=${paths.extra.length}`,
  )

  return {
    paths,
    tmpDir,
    cleanup: () => {
      try {
        rmSync(tmpDir, { recursive: true, force: true })
      } catch {
        // temp dir cleanup is best-effort
      }
    },
  }
}

// ─── Wrapper ─────────────────────────────────────────────────────────────────

/** Shell-single-quote a value for safe embedding in the wrapper script. */
function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/**
 * The standard outbound-proxy env names (uppercase + lowercase variants) whose
 * presence on the HOST process env turns on arapuca's `--allow-proxy-env`.
 * Deliberately a fixed list of the conventional names — c3 neither parses the
 * URLs nor forwards arbitrary variables.
 */
const PROXY_ENV_NAMES = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'no_proxy',
] as const

/**
 * Whether the host runs behind a proxy, i.e. any {@link PROXY_ENV_NAMES} key
 * carries a non-empty value. arapuca is env deny-by-default and would otherwise
 * drop these, leaving the vendor CLI unable to reach its provider on a host that
 * itself only connects through the corporate proxy. Zero-config: no workspace
 * switch, no per-variable allowlist, no value redaction — arapuca forwards the
 * standard set itself once `--allow-proxy-env` is passed.
 *
 * An empty value is treated as absent: it grants nothing, and a bare `NO_PROXY=`
 * left over in a shell should not silently widen the sandbox env surface.
 */
function hostHasProxyEnv(): boolean {
  return PROXY_ENV_NAMES.some((name) => (process.env[name] ?? '').trim() !== '')
}

/** Explicit wrapper-generation decisions the caller (the run's launch path) owns. */
export interface SandboxWrapperOptions {
  /**
   * Append `--allow-keychain` so the vendor CLI may reach the host keychain /
   * subscription credential store. MUST be derived from the authentication mode
   * of the agent this run actually resolved and bound (`configMode === 'system'`),
   * never from the CLI name, the platform, or the global default agent — a session
   * agent swap, a role agent, or the vendor fork would otherwise mismatch it.
   */
  readonly allowKeychain: boolean
}

/**
 * Create a wrapper script that runs `entryCommand` inside an arapuca-narrowed
 * process with the resolved allow set.
 *
 * The wrapper `exec`s `arapuca run -v <path>:ro|rw … -- <entryCommand> "$@"`.
 * The vendor SDK spawns this script as if it were the local CLI; the child
 * process inherits the SDK-provided env (arapuca strips only `LD_*` / `DYLD_*`
 * / `ARAPUCA_*` prefixes), so no env-file is written or needed.
 *
 * Two arapuca capability flags ride on top of the allow set (both require arapuca
 * ≥ 0.2.5, the run prerequisite; an older binary fails the run closed rather than
 * falling back to a bare host run):
 *  - `--allow-proxy-env` whenever the HOST carries standard proxy variables
 *    ({@link hostHasProxyEnv}) — same rule for every vendor branch.
 *  - `--allow-keychain` only for a `system`-mode (subscription-auth) agent, per
 *    the caller's explicit {@link SandboxWrapperOptions.allowKeychain}.
 * Both live in the arapuca argument section (before `--`), never in the vendor
 * CLI's `"$@"`.
 *
 * @param paths        The resolved allow set from {@link launchSandbox}.
 * @param entryCommand The host PATH vendor CLI name (`claude` / `codex`).
 * @param tmpDir       The per-run temp dir from {@link launchSandbox}.
 * @param opts         Explicit per-run wrapper decisions (see {@link SandboxWrapperOptions}).
 * @returns Absolute path to the executable wrapper script.
 */
export function createSandboxWrapper(
  paths: ResolvedSandboxPaths,
  entryCommand: string,
  tmpDir: string,
  opts: SandboxWrapperOptions,
): string {
  const isCodex = entryCommand === 'codex'
  const isClaude = entryCommand === 'claude'
  // The vendor transcript/config data root (resolved + ensured by resolvePaths),
  // exported so the CLI writes/reads its native store there and mounted rw since
  // it lives outside the execution root's grant. codex → persistent per-workspace
  // CODEX_HOME (thread rollouts survive cleanup for the next turn's `resume`);
  // claude → the HOST CLAUDE_CONFIG_DIR (transcript stays host-readable). Scoped
  // per vendor so a codex run never mounts the claude dir and vice-versa.
  const dataRoot = isCodex ? paths.codexHome : isClaude ? paths.claudeConfigDir : null
  const dataRootEnvVar = isCodex ? 'CODEX_HOME' : isClaude ? 'CLAUDE_CONFIG_DIR' : null
  // Claude Code hardcodes its per-user runtime dir at /tmp/claude-<uid>
  // (shell-snapshots / IPC). It ignores TMPDIR and arapuca locks TMPDIR, so the
  // dir cannot be redirected — it must be allowed. The host path (`/tmp/...`) is
  // created by the wrapper; the canonical path (macOS `/private/tmp/...`) is the
  // one arapuca matches. It is a shared, per-user dir (not per-run) — allow it,
  // do not clean it. codex never touches it, so it is mounted for claude only.
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0
  const claudeRuntimeHost = `/tmp/claude-${uid}`
  const claudeRuntimeCanon = `${realpathSync('/tmp')}/claude-${uid}`
  const mounts: ResolvedMount[] = [
    { path: paths.executionRoot, readonly: false },
    // Present only when distinct from the execution root (worktree runs); a
    // current-branch run merges it into the single rw execution-root grant.
    ...(paths.workspaceRoot ? [{ path: paths.workspaceRoot, readonly: true }] : []),
    { path: paths.specsBase, readonly: false },
    // The vendor data root (rw), and — for claude only — its /tmp runtime dir.
    ...(dataRoot ? [{ path: dataRoot, readonly: false }] : []),
    ...(isClaude ? [{ path: claudeRuntimeCanon, readonly: false }] : []),
    ...paths.extra,
  ]
  const mountFlags = mounts
    .map((m) => `  -v ${shQuote(`${m.path}:${m.readonly ? 'ro' : 'rw'}`)} \\`)
    .join('\n')

  // arapuca is env deny-by-default: it drops the parent process env (except the
  // vars it manages itself, HOME/PATH) and forwards ONLY variables passed as
  // `--env KEY=VALUE` (a bare `--env KEY` is rejected as invalid). The driver
  // already places the run's provider credential on the wrapper process env
  // (codexExecEnv sets CODEX_API_KEY from the relay token; the claude launch env
  // carries ANTHROPIC_*). Forward each as `--env "KEY=$KEY"` where `$KEY` is
  // expanded by /bin/sh AT RUN TIME from the wrapper's own env — so the token
  // VALUE never lands in this script's text on disk, only the variable name and
  // a `$`-reference do. An unset var expands to `KEY=`, which arapuca drops
  // (leaves it unset in the sandbox) rather than erroring — a safe no-op. Scope
  // the list per vendor so a codex run never leaks ANTHROPIC_* into its sandbox
  // and vice-versa.
  const credentialEnvNames =
    entryCommand === 'codex'
      ? ['CODEX_API_KEY']
      : entryCommand === 'claude'
        ? ['ANTHROPIC_BASE_URL', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']
        : []
  // Emit unquoted `$NAME` so /bin/sh expands it at run time; the whole KEY=VALUE
  // is double-quoted so a value with spaces stays one argv token.
  const credentialEnvBlock = credentialEnvNames
    .map((name) => `  --env "${name}=$${name}" \\\n`)
    .join('')

  // The vendor data-root env line (`CODEX_HOME=…` / `CLAUDE_CONFIG_DIR=…`), or
  // empty for an unknown vendor. Its VALUE is a fixed host path, safe to inline.
  const dataRootEnvLine =
    dataRootEnvVar && dataRoot ? `  --env ${shQuote(`${dataRootEnvVar}=${dataRoot}`)} \\\n` : ''
  // Pre-create claude's /tmp runtime dir (mounted above) before arapuca starts;
  // codex needs no such line.
  const runtimeMkdirLine = isClaude
    ? `mkdir -p ${shQuote(claudeRuntimeHost)} 2>/dev/null || true\n`
    : ''

  // Host proxy passthrough (arapuca ≥ 0.2.5): env is deny-by-default, so on a host
  // that only reaches the provider through a corporate proxy the vendor CLI would
  // fail to connect. One flag hands the standard proxy variables to arapuca, which
  // forwards them itself — c3 emits no per-variable `--env`. Same rule for codex
  // and claude; absent on a host with no proxy configured (behaviour unchanged).
  const proxyLine = hostHasProxyEnv() ? '  --allow-proxy-env \\\n' : ''
  // Subscription (`system`-mode) auth passthrough (arapuca ≥ 0.2.5): the vendor
  // CLI's own login lives in the host keychain / credential store, unreachable
  // under deny-by-default isolation. Strictly bound to the caller's resolved agent
  // mode — a custom (API-key) agent never widens this surface; its credential keeps
  // riding the `--env` block above.
  const keychainLine = opts.allowKeychain ? '  --allow-keychain \\\n' : ''

  const scriptPath = join(tmpDir, 'wrapper.sh')
  // `--seccomp baseline` opens outbound network (sandbox network model is
  // "fully open" for now; strict — the arapuca default — blocks all network and
  // would fail the vendor CLI's provider calls). macOS has no per-host filter;
  // Linux can later narrow via `--allow-host`. Proxy passthrough does not change
  // that model — it only makes the host's proxy endpoint visible to the CLI.
  const script = `#!/bin/sh
# c3 sandbox wrapper — runs the vendor CLI inside an arapuca-narrowed process
${runtimeMkdirLine}exec arapuca run \\
  --seccomp baseline \\
${proxyLine}${keychainLine}  --cwd ${shQuote(paths.executionRoot)} \\
${dataRootEnvLine}${credentialEnvBlock}${mountFlags}
  -- ${shQuote(entryCommand)} "$@"
`
  writeFileSync(scriptPath, script, 'utf-8')
  chmodSync(scriptPath, 0o755)
  return scriptPath
}
