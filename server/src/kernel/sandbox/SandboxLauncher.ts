/**
 * SandboxLauncher — arapuca Process-Level Sandbox Integration
 *
 * The integration layer between the run lifecycle and arapuca. Resolves the
 * run's allowed path set (deny-by-default), probes the host for arapuca, and
 * generates a wrapper script so the vendor CLI runs inside an arapuca-narrowed
 * process transparently.
 *
 * ## Flow
 * 1. `probeArapuca()` — confirms the arapuca binary + platform capability. The
 *    binary is resolved as c3-managed install first (see `arapuca-dist.ts`),
 *    host PATH second; a missing managed install triggers a background download
 *    that never delays this run. A failure hard-fails a sandbox-enabled run
 *    (never a silent host fallback).
 * 2. `launchSandbox(workspaceRoot, worktree)` — resolves the allowed path set
 *    (workspace root ro, worktree rw, specsBase rw, extraMounts) and mints a
 *    per-run temp dir. Returns paths + tmpDir + a `cleanup()`.
 * 3. `createSandboxWrapper(paths, vendor, tmpDir, opts)` — writes a POSIX
 *    shell script that `exec`s `<arapucaBin> run -v …:ro -v …:rw -- <cli> "$@"`. The
 *    path is passed to the vendor SDK as `pathToClaudeCodeExecutable` /
 *    `codexPathOverride`. The SDK spawns it as a normal subprocess. arapuca is env
 *    deny-by-default: it drops the parent env (keeping only the vars it manages,
 *    HOME/PATH) and forwards ONLY what the wrapper passes as `--env KEY=VALUE`.
 *    WHICH variables, data root and extra mounts a vendor needs is not decided
 *    here — it comes from the per-vendor strategy in `vendor-auth.ts`; this module
 *    only merges that profile with the common allow set and renders the arapuca
 *    command. `opts.systemAuth` carries the resolved agent's auth mode into the
 *    strategy; host proxy variables and the gh config dir are detected here
 *    (vendor-neutral).
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
  statSync,
  accessSync,
  constants as fsConstants,
} from 'node:fs'
import { homedir } from 'node:os'
import { join, delimiter, sep, isAbsolute } from 'node:path'
import { getProjectSandbox } from '../../kernel/config/index.js'
import { ensureManagedArapuca, resolveManagedArapuca } from './arapuca-dist.js'
import {
  getSpecsBase,
  relayCodexHome,
  getSandboxClaudeConfigDir,
} from '../../kernel/config/workspace-path.js'
import { SandboxLaunchError } from './errors.js'
import { readHostFacts, resolveSandboxAuthProfile } from './vendor-auth.js'
import type { SandboxAuthProfile } from './vendor-auth.js'
import type { SysExtraMount, SessionKind, VendorId } from '@ccc/shared/protocol'
import type {
  ResolvedMount,
  ResolvedSandboxPaths,
  ArapucaProbeResult,
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

// The typed launch failure lives in `errors.ts` so the auth-strategy registry can
// throw it too without a module cycle; re-exported here, the historical entry
// point for every importer.
export { SandboxLaunchError } from './errors.js'

// ─── arapuca Probe ───────────────────────────────────────────────────────────

/**
 * Cached probe result. arapuca availability is stable within a process with ONE
 * exception: a background managed install can complete and switch `current`
 * mid-process, which invalidates a cache that had settled on the host PATH.
 */
let probeCache: ArapucaProbeResult | undefined

/** Binary name looked up on the host PATH. */
const ARAPUCA_BIN = 'arapuca'

/** Suffixes treated as executable on Windows when PATHEXT is unset. */
const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD'

/**
 * File names to try for `bin` in each PATH directory. POSIX installs the bare
 * name; a Windows install ships `arapuca.exe` (the same file name the managed
 * artifact uses), and PATHEXT decides which suffixes count as executable there.
 * Exported for tests, which must cover Windows resolution from any host.
 */
export function binaryCandidates(
  bin: string,
  plat: NodeJS.Platform = process.platform,
  pathExt: string | undefined = process.env.PATHEXT,
): string[] {
  if (plat !== 'win32') return [bin]
  const exts = (pathExt?.trim() ? pathExt : DEFAULT_PATHEXT)
    .split(';')
    .map((ext) => ext.trim())
    .filter(Boolean)
  // The bare name stays last: an extension-less file is still spawnable when it
  // is what the user actually installed.
  return [...exts.map((ext) => `${bin}${ext.toLowerCase()}`), bin]
}

/**
 * Find an executable named `bin` on the host PATH. Returns the absolute path or
 * null when not found / not executable.
 */
function findOnPath(bin: string): string | null {
  const pathEnv = process.env.PATH ?? ''
  const names = binaryCandidates(bin)
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue
    for (const name of names) {
      const candidate = join(dir, name)
      try {
        accessSync(candidate, fsConstants.X_OK)
        return candidate
      } catch {
        // not here — keep scanning
      }
    }
  }
  return null
}

/**
 * Probe for arapuca + platform capability. Cached.
 *
 * Binary resolution is a two-link chain, tried in order:
 * 1. **c3-managed** — the checksum-verified install under `~/.c3/sandbox/arapuca/`
 *    pinned to the version this c3 build was validated against.
 * 2. **host PATH** — the user's own arapuca, whatever version that is.
 *
 * When the managed install is missing or untrustworthy, a background download is
 * kicked off (single-flight) and this call **immediately** continues to the PATH
 * scan: the current run is never delayed by, and never waits for, an install. If
 * that install later succeeds it invalidates this cache, so the NEXT probe picks
 * the managed binary while runs already launched keep the path they were given.
 *
 * Current scope is directory ro/rw MAC, which all three platforms support
 * (Linux Landlock / macOS Seatbelt / Windows AppContainer), so the platform
 * gate only rejects unknown platforms. Neither link yielding a binary is still
 * `arapuca-missing` — a hard fail, never a host-native fallback; the UI turns
 * the code into a localized "install arapuca" hint.
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
  // 1. The c3-managed, checksum-verified install wins when it is intact.
  const managed = resolveManagedArapuca()
  if (managed) {
    probeCache = { ok: true, path: managed, source: 'managed' }
    return probeCache
  }
  // Missing / broken / wrong-version managed install: repair it in the
  // background and fall through to PATH for THIS probe. A success invalidates
  // the cache below so the next probe upgrades to the managed binary.
  ensureManagedArapuca({ onInstalled: invalidateArapucaProbe })
  // 2. The host's own arapuca.
  const bin = findOnPath(ARAPUCA_BIN)
  probeCache = bin
    ? { ok: true, path: bin, source: 'host-path' }
    : { ok: false, uiCode: 'arapuca-missing' }
  return probeCache
}

/**
 * Drop the cached probe so the next call re-resolves. Called when a background
 * managed install completes — the cache may hold a host-PATH result that the
 * freshly installed, version-pinned binary should now supersede.
 */
export function invalidateArapucaProbe(): void {
  probeCache = undefined
}

/** Test-only: drop the cached probe so the next call re-resolves. */
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

// ─── gh CLI config dir (vendor-neutral system allowance) ─────────────────────

/**
 * The host `gh` CLI config dir candidate, following gh's OWN precedence:
 * `GH_CONFIG_DIR` → `$XDG_CONFIG_HOME/gh` → `<home>/.config/gh`. The first
 * applicable entry is the single candidate — there is no fallback scan, so the
 * sandbox allows exactly the dir gh itself would read.
 *
 * An empty or relative environment value counts as unset and falls through to
 * the next tier: gh resolves its config against its own process cwd, which is
 * not c3's, so a relative value cannot be turned into a trustworthy mount.
 *
 * Windows yields nothing: gh's config location differs there (`%AppData%`), and
 * defining it is explicitly out of scope — a Windows host simply gets no gh
 * allowance rather than a guessed one.
 *
 * Returns the RAW candidate (not canonicalized, existence not checked); the
 * caller decides whether it can become a mount. Exported for table tests.
 */
export function resolveGhConfigDir(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  if (platform === 'win32') return undefined
  const usable = (value: string | undefined): string | undefined => {
    const trimmed = value?.trim()
    return trimmed && isAbsolute(trimmed) ? trimmed : undefined
  }
  const explicit = usable(env.GH_CONFIG_DIR)
  if (explicit) return explicit
  const xdg = usable(env.XDG_CONFIG_HOME)
  if (xdg) return join(xdg, 'gh')
  return join(home, '.config', 'gh')
}

/**
 * The gh config dir this run may mount, canonicalized — or undefined when there
 * is nothing to mount.
 *
 * Unlike the fixed workspace allowances this NEVER creates the directory and
 * never fails the launch: a host without gh configured is a host without the gh
 * capability, not a broken sandbox. A candidate that is not a directory (a
 * stray file at that path) is likewise ignored rather than mounted.
 *
 * Canonicalize is also the symlink-escape guard — the mount authorizes the
 * resolved target, never the link's parent.
 */
function resolveGhConfigMount(): string | undefined {
  const candidate = resolveGhConfigDir()
  if (!candidate) return undefined
  try {
    const canon = realpathSync(candidate)
    return statSync(canon).isDirectory() ? canon : undefined
  } catch {
    return undefined
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
 * The host gh config dir is resolved here too, as a vendor-neutral optional
 * allowance ({@link resolveGhConfigMount}): present when the host actually has
 * one, absent otherwise. It is a SYSTEM grant, so it does not pass through the
 * user-facing `extraMounts` denylist — but it also authorizes nothing beyond the
 * one canonicalized directory it resolved.
 *
 * `arapucaBin` is the absolute binary the wrapper will `exec`; it is threaded in
 * from the probe (managed install or host PATH) rather than re-resolved here,
 * and defaults to the bare name only for callers that resolve paths outside a
 * launch (tests, UI previews).
 *
 * @throws {@link SandboxLaunchError} on reserved-path overlap or denylist hit.
 */
export function resolvePaths(
  workspaceRoot: string,
  executionRoot: string,
  extraMounts: readonly { path: string; readonly?: boolean }[] = [],
  arapucaBin: string = ARAPUCA_BIN,
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
  // The global relay CODEX_HOME (rw). It lives OUTSIDE the execution root (under
  // c3 home), so unlike the per-run temp dir it survives cleanup — codex thread
  // rollouts persist here for the next turn's `resume`. Ensure it exists so it can
  // be canonicalized and written, then treat it as a reserved allowance
  // (extraMounts must not overlap it).
  const sandboxCodexHome = relayCodexHome()
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
  // The host gh config dir (ro) — vendor-neutral, optional. Resolved with gh's own
  // precedence and skipped silently when the host has none: `gh` is a tool the
  // agent may call, not a run prerequisite.
  const canonGhConfigDir = resolveGhConfigMount()
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
    // Omitted entirely when the host has no gh config dir — the wrapper keys the
    // mount AND the gh keychain trigger off this field's presence.
    ...(canonGhConfigDir ? { ghConfigDir: canonGhConfigDir } : {}),
    extra,
    arapucaBin,
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
          : 'no arapuca binary available (c3-managed install not ready and none on PATH)',
    )
  }

  const sbCfg = getProjectSandbox(workspaceRoot)
  // Freeze the probed binary into this launch: the run executes the exact
  // arapuca the probe verified, even if a background install switches `current`
  // while the run is alive.
  const paths = resolvePaths(workspaceRoot, executionRoot, sbCfg?.extraMounts ?? [], probe.path)
  // The per-run temp dir holds ONLY the wrapper script — it is deleted on cleanup.
  // Codex process state (CODEX_HOME) lives in the persistent per-workspace home
  // (`paths.codexHome`, ensured by resolvePaths), NOT here, so thread rollouts
  // survive for the next turn's `resume`.
  const tmpDir = mkdtempSync(join(paths.executionRoot, '.c3-sb-'))

  console.log(
    `[sandbox] arapuca wrapper prepared: bin=${paths.arapucaBin} (${probe.source}) ` +
      `exec(rw)=${paths.executionRoot} ` +
      `root(ro)=${paths.workspaceRoot ?? '(merged into exec)'} ` +
      `specs(rw)=${paths.specsBase} codexHome(rw)=${paths.codexHome} ` +
      `gh(ro)=${paths.ghConfigDir ?? '(none)'} extra=${paths.extra.length}`,
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
   * Whether the agent this run actually resolved and bound authenticates through
   * the vendor's own subscription login (`configMode === 'system'`) rather than
   * an injected credential. MUST come from that bound agent, never from the CLI
   * name, the platform, or the global default agent — a session agent swap, a
   * role agent, or the vendor fork would otherwise mismatch it. What the mode
   * implies (host keychain access, which data root, which variables) is the
   * per-vendor strategy's call, not this module's.
   *
   * Deliberately NOT named `allowKeychain`: it is one of the two INPUTS to that
   * decision, not the decision. A caller that pre-merged the policy here would
   * hide the second input (the vendor-neutral gh trigger) from the wrapper.
   */
  readonly systemAuth: boolean
}

/**
 * Create a wrapper script that runs `vendor`'s CLI inside an arapuca-narrowed
 * process with the resolved allow set.
 *
 * The wrapper `exec`s `<paths.arapucaBin> run -v <path>:ro|rw … -- <cli> "$@"`.
 * The vendor SDK spawns this script as if it were the local CLI; the child
 * process inherits the SDK-provided env (arapuca strips only `LD_*` / `DYLD_*`
 * / `ARAPUCA_*` prefixes), so no env-file is written or needed.
 *
 * This function is vendor-neutral by construction: everything a vendor needs to
 * authenticate and store its state — entry command, data root and its variable,
 * credential variable names, extra mounts, identity variables, keychain access,
 * pre-run dirs — arrives as a resolved {@link SandboxAuthProfile} from the
 * per-vendor strategy registry. What stays here is the part that is the same for
 * every vendor: the common allow set, shell quoting, mount de-duplication and
 * arapuca argument ordering.
 *
 * Two arapuca capability flags ride on top of the allow set (both require arapuca
 * ≥ 0.2.5, the run prerequisite; an older binary fails the run closed rather than
 * falling back to a bare host run):
 *  - `--allow-proxy-env` whenever the HOST carries standard proxy variables
 *    ({@link hostHasProxyEnv}) — a host fact, identical for every vendor.
 *  - `--allow-keychain` when EITHER the resolved profile asks for it (a
 *    subscription login the vendor cannot read from an environment variable) OR
 *    the run resolved a gh config dir (gh's own login lives in the host
 *    credential store). One OR, one flag.
 * Both live in the arapuca argument section (before `--`), never in the vendor
 * CLI's `"$@"`.
 *
 * @param paths  The resolved allow set from {@link launchSandbox}.
 * @param vendor The run's vendor — the strategy registry key, NOT a CLI name.
 * @param tmpDir The per-run temp dir from {@link launchSandbox}.
 * @param opts   Explicit per-run wrapper decisions (see {@link SandboxWrapperOptions}).
 * @returns Absolute path to the executable wrapper script.
 * @throws {@link SandboxLaunchError} when the vendor has no registered auth profile.
 */
export function createSandboxWrapper(
  paths: ResolvedSandboxPaths,
  vendor: VendorId,
  tmpDir: string,
  opts: SandboxWrapperOptions,
): string {
  const profile = resolveSandboxAuthProfile(vendor, {
    paths,
    systemAuth: opts.systemAuth,
    host: readHostFacts(),
  })
  return writeWrapperScript(paths, profile, tmpDir)
}

/**
 * Render a resolved auth profile plus the common allow set into the wrapper
 * script, and write it executable.
 *
 * Split from {@link createSandboxWrapper} so the two responsibilities stay
 * visibly separate: that one resolves WHICH profile applies, this one renders
 * whatever profile it is handed. Nothing below reads the vendor id.
 */
function writeWrapperScript(
  paths: ResolvedSandboxPaths,
  profile: SandboxAuthProfile,
  tmpDir: string,
): string {
  // The common allow set, then the vendor's own paths, then the user's extras.
  // De-duplicated by path (first grant wins) so a profile that names a path the
  // common set already covers cannot emit a conflicting second `-v`.
  //
  // The gh config dir sits AFTER the profile mounts on purpose: it is the only
  // read-only system grant, so letting every stronger rw grant (common set or
  // vendor data root) claim the path first keeps a coincidental overlap from
  // silently downgrading a vendor's own store to ro.
  const mounts: ResolvedMount[] = []
  const seen = new Set<string>()
  for (const mount of [
    { path: paths.executionRoot, readonly: false },
    // Present only when distinct from the execution root (worktree runs); a
    // current-branch run merges it into the single rw execution-root grant.
    ...(paths.workspaceRoot ? [{ path: paths.workspaceRoot, readonly: true }] : []),
    { path: paths.specsBase, readonly: false },
    ...profile.mounts,
    ...(paths.ghConfigDir ? [{ path: paths.ghConfigDir, readonly: true }] : []),
    ...paths.extra,
  ]) {
    if (seen.has(mount.path)) continue
    seen.add(mount.path)
    mounts.push(mount)
  }
  const mountFlags = mounts
    .map((m) => `  -v ${shQuote(`${m.path}:${m.readonly ? 'ro' : 'rw'}`)} \\`)
    .join('\n')

  // Fixed, non-secret values (data roots, login identity) are inlined. Their
  // VALUES are host paths / names, safe to write into the script.
  const literalEnvBlock = profile.literalEnv
    .map(({ name, value }) => `  --env ${shQuote(`${name}=${value}`)} \\\n`)
    .join('')
  // arapuca is env deny-by-default: it drops the parent process env (except the
  // vars it manages itself, HOME/PATH) and forwards ONLY variables passed as
  // `--env KEY=VALUE` (a bare `--env KEY` is rejected as invalid). The driver
  // already places the run's provider credential on the wrapper process env.
  // Forward each as `--env "KEY=$KEY"` where `$KEY` is expanded by /bin/sh AT RUN
  // TIME from the wrapper's own env — so the token VALUE never lands in this
  // script's text on disk, only the variable name and a `$`-reference do. An
  // unset var expands to `KEY=`, which arapuca drops (leaves it unset in the
  // sandbox) rather than erroring — a safe no-op. Emit unquoted `$NAME` so /bin/sh
  // expands it; the whole KEY=VALUE is double-quoted so a value with spaces stays
  // one argv token.
  const forwardEnvBlock = profile.forwardEnv
    .map((name) => `  --env "${name}=$${name}" \\\n`)
    .join('')
  // Host dirs the vendor CLI expects but cannot create under isolation, made
  // before arapuca narrows the process.
  const preRunLines = profile.preRunDirs
    .map((dir) => `mkdir -p ${shQuote(dir)} 2>/dev/null || true\n`)
    .join('')

  // Host proxy passthrough (arapuca ≥ 0.2.5): env is deny-by-default, so on a host
  // that only reaches the provider through a corporate proxy the vendor CLI would
  // fail to connect. One flag hands the standard proxy variables to arapuca, which
  // forwards them itself — c3 emits no per-variable `--env`. A host fact, so the
  // same rule for every vendor; absent on a host with no proxy configured.
  const proxyLine = hostHasProxyEnv() ? '  --allow-proxy-env \\\n' : ''
  // Host credential-store passthrough (arapuca ≥ 0.2.5). TWO independent facts
  // can require it, and the flag is rendered ONCE for their OR:
  //  - the vendor profile — a subscription login the CLI cannot read from an
  //    environment variable (a credential that rides env never widens this);
  //  - gh — the external tool the agent calls inside its session keeps its login
  //    token in the host credential store, so a readable config dir alone is not
  //    enough to make `gh auth status` work.
  // The gh trigger is deliberately independent of the agent's `configMode`, the
  // vendor, `GH_TOKEN`, and the contents of `hosts.yml`: keying it off any of
  // those would mean reading credential files, or building an implicit exclusion
  // between the env-token bridge and the keychain (they are complementary).
  const ghKeychainRequired = paths.ghConfigDir !== undefined
  const keychainLine = profile.allowKeychain || ghKeychainRequired ? '  --allow-keychain \\\n' : ''

  const scriptPath = join(tmpDir, 'wrapper.sh')
  // `--seccomp baseline` opens outbound network (sandbox network model is
  // "fully open" for now; strict — the arapuca default — blocks all network and
  // would fail the vendor CLI's provider calls). macOS has no per-host filter;
  // Linux can later narrow via `--allow-host`. Proxy passthrough does not change
  // that model — it only makes the host's proxy endpoint visible to the CLI.
  // `exec` the ABSOLUTE binary the probe selected (c3-managed install or host
  // PATH hit) — never a bare `arapuca`, whose runtime PATH lookup could resolve
  // to a different, unverified binary than the one the probe validated.
  const script = `#!/bin/sh
# c3 sandbox wrapper — runs the vendor CLI inside an arapuca-narrowed process
${preRunLines}exec ${shQuote(paths.arapucaBin)} run \\
  --seccomp baseline \\
${proxyLine}${keychainLine}  --cwd ${shQuote(paths.executionRoot)} \\
${literalEnvBlock}${forwardEnvBlock}${mountFlags}
  -- ${shQuote(profile.entryCommand)} "$@"
`
  writeFileSync(scriptPath, script, 'utf-8')
  chmodSync(scriptPath, 0o755)
  return scriptPath
}
