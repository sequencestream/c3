/**
 * Sandbox — Per-Vendor Authentication Strategy
 *
 * The single place where "how does THIS vendor authenticate inside the sandbox"
 * lives. arapuca is deny-by-default for both the filesystem and the environment,
 * so every vendor CLI needs its own answer to four questions: which data root it
 * reads/writes, which environment variables carry (or must NOT carry) its
 * identity, which extra host paths it must see, and whether its login lives in
 * the host keychain rather than in an environment variable.
 *
 * Those answers used to be inlined in the wrapper generator as a chain of
 * `isClaude` / `isCodex` / keychain-mode / system-mode conditionals, so every new
 * vendor quirk edited the one function that assembles the arapuca command. Here
 * each vendor contributes ONE resolver to {@link VENDOR_AUTH_PROFILES}, and the
 * wrapper generator consumes only the resolved {@link SandboxAuthProfile}: it
 * never names a vendor, never infers one from the entry command, and never asks
 * which auth mode is active. Adding a vendor is adding a resolver.
 *
 * A profile is DATA, not shell: it carries variable names, host paths and flags.
 * Secret VALUES never enter it — a credential is declared by name in
 * {@link SandboxAuthProfile.forwardEnv} and expanded by `/bin/sh` at run time, so
 * no token is ever written into the wrapper script on disk.
 *
 * Layer: kernel/sandbox (inner domain)
 *
 * @module
 */

import { existsSync, realpathSync } from 'node:fs'
import { homedir, userInfo } from 'node:os'
import { join } from 'node:path'
import type { VendorId } from '@ccc/shared/protocol'
import { hostCodexHome } from '../config/workspace-path.js'
import { SandboxLaunchError } from './errors.js'
import type { ResolvedMount, ResolvedSandboxPaths } from './types.js'

// ─── Profile Model ───────────────────────────────────────────────────────────

/** An environment variable whose VALUE is a fixed, non-secret host fact. */
export interface SandboxEnvVar {
  /** Variable name, e.g. `CODEX_HOME`. */
  readonly name: string
  /** Literal value inlined into the wrapper script (a path or a login name). */
  readonly value: string
}

/**
 * Everything one vendor needs in order to authenticate and store its state
 * inside the sandbox, expressed as data the wrapper generator can render
 * mechanically.
 *
 * The generator appends {@link mounts} after the common allow set and before the
 * user's `extraMounts`, emits {@link literalEnv} then {@link forwardEnv} as
 * `--env` flags in that order, and pre-creates {@link preRunDirs} before arapuca
 * starts. Nothing else about the vendor reaches it.
 */
export interface SandboxAuthProfile {
  /** The host PATH CLI name the wrapper `exec`s after arapuca's `--` separator. */
  readonly entryCommand: string
  /**
   * Variables inlined as `--env 'NAME=VALUE'`. Data roots (`CODEX_HOME` /
   * `CLAUDE_CONFIG_DIR`) and login identity live here; a path this vendor must
   * NOT have pinned simply omits it.
   */
  readonly literalEnv: readonly SandboxEnvVar[]
  /**
   * Variable NAMES forwarded as `--env "NAME=$NAME"`, expanded from the wrapper
   * process env at run time. This is the credential channel: the value never
   * lands in the script text. An unset variable expands to `NAME=`, which
   * arapuca drops.
   */
  readonly forwardEnv: readonly string[]
  /**
   * Host paths this vendor needs beyond the common allow set — its data root,
   * its runtime dir, its config sidecar. Scoped per vendor so one vendor's run
   * never exposes another's store.
   */
  readonly mounts: readonly ResolvedMount[]
  /**
   * Directories the wrapper must `mkdir -p` before arapuca starts, for vendors
   * whose CLI expects a host dir it cannot itself create under isolation.
   */
  readonly preRunDirs: readonly string[]
  /**
   * Open the host keychain / subscription credential store (`--allow-keychain`).
   * The vendor decides: a login that rides an environment variable never widens
   * this surface, even for a subscription agent.
   */
  readonly allowKeychain: boolean
}

// ─── Resolution Input ────────────────────────────────────────────────────────

/**
 * Host facts a profile may depend on, injected rather than read from the
 * ambient process so the strategy layer stays table-testable (a macOS-only rule
 * is exercised from any host).
 */
export interface SandboxHostFacts {
  /** Host platform — some auth rules are platform-specific. */
  readonly platform: NodeJS.Platform
  /** Current user's home directory. */
  readonly homeDir: string
  /** Host login name (not a secret) — some credential stores key their lookup by it. */
  readonly loginName: string
  /** Current user id, for per-user runtime dirs. */
  readonly uid: number
  /** Canonicalize a host path, returning it unchanged when it cannot be resolved. */
  readonly canonicalize: (path: string) => string
  /** Whether a host path exists (mounting a missing path aborts the run). */
  readonly exists: (path: string) => boolean
}

/** Read the ambient host facts. */
export function readHostFacts(): SandboxHostFacts {
  return {
    platform: process.platform,
    homeDir: homedir(),
    loginName: process.env.USER || process.env.LOGNAME || userInfo().username,
    uid: typeof process.getuid === 'function' ? process.getuid() : 0,
    canonicalize: (path) => {
      try {
        return realpathSync(path)
      } catch {
        return path
      }
    },
    exists: (path) => existsSync(path),
  }
}

/** What a per-vendor resolver gets to decide from. */
export interface SandboxAuthInput {
  /** The run's resolved allow set — source of the vendor-neutral data roots. */
  readonly paths: ResolvedSandboxPaths
  /**
   * Whether the agent this run actually resolved and bound authenticates through
   * the vendor's own login (`configMode === 'system'`) rather than an injected
   * credential. Never derived from the CLI name, the platform or the default
   * agent.
   */
  readonly systemAuth: boolean
  /** Injected host facts (see {@link SandboxHostFacts}). */
  readonly host: SandboxHostFacts
}

/** A vendor's contribution: pure input → profile, no side effects. */
export type SandboxAuthResolver = (input: SandboxAuthInput) => SandboxAuthProfile

// ─── Claude ──────────────────────────────────────────────────────────────────

/**
 * Claude Code.
 *
 * `CLAUDE_CONFIG_DIR` normally pins the data root at the HOST claude config dir
 * so the transcript the sandbox writes stays readable by the server's SDK — but
 * on macOS a subscription login lives in the login Keychain, which Claude Code
 * consults ONLY in its default profile. The moment `CLAUDE_CONFIG_DIR` is set it
 * flips to a file-backed credential store that does not exist here, and claude
 * reports "Not logged in" even with the keychain wide open. So the macOS
 * subscription path deliberately leaves the variable unset (arapuca's keychain
 * grant already points HOME at the real home, where claude finds the same dir)
 * and instead forwards the login name the keychain lookup is keyed by — arapuca
 * strips `USER`/`LOGNAME` to empty under deny-by-default.
 *
 * The config dir is mounted rw on every path (transcripts land there either
 * way). `~/.claude.json` — the global config holding the oauth account and the
 * project registry — is a SIBLING of that dir, so it needs its own mount; only
 * the keychain path reads it, and only when it already exists (a fresh install
 * has none, and mounting a missing path aborts the run).
 *
 * Claude Code also hardcodes a per-user runtime dir at `/tmp/claude-<uid>`
 * (shell snapshots / IPC). It ignores TMPDIR and arapuca locks TMPDIR, so the
 * dir cannot be redirected — the wrapper creates the host path and allows the
 * canonical one. It is shared per user, not per run: allow it, never clean it.
 */
const claudeProfile: SandboxAuthResolver = ({ paths, systemAuth, host }) => {
  const keychainMode = systemAuth && host.platform === 'darwin'
  const globalConfig = join(host.homeDir, '.claude.json')
  const runtimeDir = `/tmp/claude-${host.uid}`
  return {
    entryCommand: 'claude',
    allowKeychain: systemAuth,
    literalEnv: keychainMode
      ? [
          { name: 'USER', value: host.loginName },
          { name: 'LOGNAME', value: host.loginName },
        ]
      : [{ name: 'CLAUDE_CONFIG_DIR', value: paths.claudeConfigDir }],
    forwardEnv: ['ANTHROPIC_BASE_URL', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'],
    mounts: [
      { path: paths.claudeConfigDir, readonly: false },
      { path: `${host.canonicalize('/tmp')}/claude-${host.uid}`, readonly: false },
      ...(keychainMode && host.exists(globalConfig)
        ? [{ path: globalConfig, readonly: false }]
        : []),
    ],
    preRunDirs: [runtimeDir],
  }
}

// ─── Codex ───────────────────────────────────────────────────────────────────

/**
 * Codex.
 *
 * Codex reads its auth straight from `$CODEX_HOME` — there is no keychain lookup
 * and no environment flip. A subscription agent authenticates in direct mode
 * from `$CODEX_HOME/auth.json` (the ChatGPT OAuth token), which the isolated
 * per-workspace sandbox home does not have, so it would hit the provider with no
 * bearer and fail. Its data root is therefore the HOST codex home, mounted rw;
 * the session's store scope is frozen to `host` to match, so rollouts, resume
 * and transcript reads all resolve to the same place.
 *
 * A custom (relay) agent keeps the isolated per-workspace sandbox home — which
 * survives per-run cleanup so thread rollouts are still there for the next
 * turn's resume — and authenticates with the relay token, never seeing the host
 * codex store.
 */
const codexProfile: SandboxAuthResolver = ({ paths, systemAuth }) => {
  const dataRoot = systemAuth ? hostCodexHome() : paths.codexHome
  return {
    entryCommand: 'codex',
    allowKeychain: systemAuth,
    literalEnv: [{ name: 'CODEX_HOME', value: dataRoot }],
    forwardEnv: ['CODEX_API_KEY'],
    mounts: [{ path: dataRoot, readonly: false }],
    preRunDirs: [],
  }
}

// ─── Registry ────────────────────────────────────────────────────────────────

/**
 * The per-vendor strategy registry. Keyed by the closed {@link VendorId} union,
 * so a new vendor id does not typecheck until it also brings a resolver — the
 * compiler, not a reviewer, is what keeps the sandbox from launching a vendor
 * whose auth nobody described.
 */
export const VENDOR_AUTH_PROFILES: Readonly<Record<VendorId, SandboxAuthResolver>> = {
  claude: claudeProfile,
  codex: codexProfile,
}

/**
 * Resolve the sandbox auth profile for `vendor`.
 *
 * Fails closed on an unregistered vendor: a wrapper without a data root and
 * without a credential channel would start, reach the provider unauthenticated,
 * and write its state somewhere unmanaged — a much worse outcome than a run that
 * never launches.
 *
 * @throws {@link SandboxLaunchError} when no resolver is registered for `vendor`.
 */
export function resolveSandboxAuthProfile(
  vendor: VendorId,
  input: SandboxAuthInput,
): SandboxAuthProfile {
  const resolver = VENDOR_AUTH_PROFILES[vendor] as SandboxAuthResolver | undefined
  if (!resolver) {
    throw new SandboxLaunchError(
      'launch-failed',
      `no sandbox auth profile registered for vendor: ${vendor}`,
    )
  }
  return resolver(input)
}
