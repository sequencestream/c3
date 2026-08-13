/**
 * Console-driven self-update: keep the newest release downloaded and verified in
 * the background, and let an admin restart into it from the header.
 *
 * The division of labour mirrors the desktop shell's updater, with the roles
 * moved inward: the shared kernel (`upgrade-core.ts` / `upgrade.ts`) owns the
 * version facts, the transport, the integrity rules and the platform replace
 * strategy; this module owns the STATE MACHINE, the staging lifecycle and the
 * relaunch handoff.
 *
 * ```text
 * idle → downloading → verifying → ready → applying
 *   ↑         └────────────┴─────────┴──→ failed (retryable)
 * ```
 *
 * Two invariants make this safe to run unattended:
 *
 *   - Downloading changes nothing that matters. The installed binary is not
 *     touched until an admin applies the update, so a bad or interrupted download
 *     costs bandwidth and nothing else.
 *   - A package only becomes `ready` after its bytes matched the checksum
 *     published beside the release AND unpacked into a runnable binary.
 *
 * Everything is fail-soft and injectable: a failed check or download degrades to
 * a retryable `failed` state and never throws into the boot path or a request.
 */
import { accessSync, constants } from 'node:fs'
import { homedir } from 'node:os'
import { dirname } from 'node:path'
import type {
  SelfUpdateFailureCode,
  SelfUpdateIncapableReason,
  SelfUpdateState,
} from '@ccc/shared/protocol'
import { c3HomeDir } from '../../kernel/config/index.js'
import { detectRuntimeForms, resolveRelaunchStrategy } from '../../restart.js'
import { SYSTEMD_UNIT_NAME } from '../../service-install.js'
import { spawnUpdateAssistant } from '../../update-assistant.js'
import {
  applyStaged,
  defaultUpgradeIo,
  hostTarget,
  isSelfUpdatable,
  stageRelease,
  type UpgradeIo,
} from '../../upgrade.js'
import {
  DEFAULT_REPO,
  UPGRADE_EXIT,
  UpgradeError,
  compareVersions,
  decideAction,
  normalizeVersion,
  resolveLatestRelease,
} from '../../upgrade-core.js'
import { VERSION } from '../../version.js'
import {
  clearStaging,
  readApplyFailure,
  clearApplyFailure,
  readStagedRecord,
  resetStaging,
  stagingDir,
  writeStagedRecord,
} from './staging.js'
import { currentUpdateStatus } from './update-checker.js'

/** Package-manager prefixes whose binaries must be updated through that manager. */
const PACKAGE_MANAGER_MARKERS = ['/Cellar/', '/homebrew/', '/linuxbrew/']

/** Progress is pushed at most this often, whichever threshold trips first. */
const PROGRESS_EVERY_BYTES = 256 * 1024
const PROGRESS_EVERY_MS = 500

// ── Capability ──────────────────────────────────────────────────────────────

/**
 * The facts about THIS installation that the whole module reads. One place
 * decides them, so a test can drive the full pipeline without monkey-patching
 * `process` or the build-time `VERSION`.
 */
export interface SelfUpdateRuntime {
  version: string
  execPath: string
  env: NodeJS.ProcessEnv
  platform: NodeJS.Platform
  arch: string
  /** Resolved lazily — `--db` can relocate the home after this module loads. */
  home: () => string
  /** The OS home, where service units live (separate root from the c3 home). */
  osHome: string
  /** Writability probe for the binary's directory. */
  canWriteDir: (dir: string) => boolean
}

function defaultCanWriteDir(dir: string): boolean {
  try {
    accessSync(dir, constants.W_OK)
    return true
  } catch {
    return false
  }
}

let runtime: SelfUpdateRuntime | null = null

function rt(): SelfUpdateRuntime {
  if (!runtime) {
    runtime = {
      version: VERSION,
      execPath: process.execPath,
      env: process.env,
      platform: process.platform,
      arch: process.arch,
      home: c3HomeDir,
      osHome: homedir(),
      canWriteDir: defaultCanWriteDir,
    }
  }
  return runtime
}

/**
 * Whether this installation may swap its own binary, and why not when it may not.
 *
 * Fail-closed and ordered by how fundamental the reason is: an instance the
 * desktop shell owns is never a candidate no matter what else is true, and a dev
 * run has no single binary to swap in the first place.
 */
export function selfUpdateCapability(
  facts: SelfUpdateRuntime = rt(),
): { capable: true } | { capable: false; reason: SelfUpdateIncapableReason } {
  // The desktop shell installs a whole app bundle, sidecar included; a sidecar
  // that swapped its own file would break the bundle's signature.
  if (facts.env.C3_MANAGED_BY === 'desktop') return { capable: false, reason: 'desktop-managed' }
  if (!isSelfUpdatable(facts.execPath, facts.version).ok) {
    return { capable: false, reason: 'dev-runtime' }
  }
  if (PACKAGE_MANAGER_MARKERS.some((marker) => facts.execPath.includes(marker))) {
    return { capable: false, reason: 'package-manager' }
  }
  if (!facts.canWriteDir(dirname(facts.execPath))) return { capable: false, reason: 'not-writable' }
  return { capable: true }
}

// ── State ───────────────────────────────────────────────────────────────────

function idleState(): SelfUpdateState {
  const capability = selfUpdateCapability()
  return {
    phase: 'idle',
    capable: capability.capable,
    ...(capability.capable ? {} : { incapableReason: capability.reason }),
    currentVersion: rt().version,
    targetVersion: null,
    downloadedBytes: 0,
    totalBytes: 0,
  }
}

let state: SelfUpdateState | null = null
let onChange: (() => void) | undefined
let busy = false
let cancelled = false

function snapshot(): SelfUpdateState {
  if (!state) state = idleState()
  return state
}

/** The current self-update snapshot (read by the `ready` frame + broadcaster). */
export function currentSelfUpdateState(): SelfUpdateState {
  return snapshot()
}

function setState(next: SelfUpdateState): void {
  state = next
  onChange?.()
}

function patchState(patch: Partial<SelfUpdateState>): void {
  setState({ ...snapshot(), ...patch })
}

/** Wire the broadcaster. Called once during server startup. */
export function configureSelfUpdate(hooks: {
  onChange?: () => void
  runtime?: Partial<SelfUpdateRuntime>
}): void {
  onChange = hooks.onChange
  if (hooks.runtime) runtime = { ...rt(), ...hooks.runtime }
}

/** Reset module state (tests only). */
export function resetSelfUpdateForTests(): void {
  state = null
  onChange = undefined
  runtime = null
  busy = false
  cancelled = false
}

/** Map a kernel failure to the wire's closed set of failure tokens. */
function failureCodeFor(e: unknown): SelfUpdateFailureCode {
  if (!(e instanceof UpgradeError)) return 'unknown'
  switch (e.code) {
    case UPGRADE_EXIT.network:
      return 'network'
    case UPGRADE_EXIT.noArtifact:
      return 'no-artifact'
    case UPGRADE_EXIT.verifyFailed:
      return 'checksum'
    case UPGRADE_EXIT.unpackFailed:
      return 'unpack'
    case UPGRADE_EXIT.replaceFailed:
      return 'replace'
    default:
      return 'unknown'
  }
}

function fail(code: SelfUpdateFailureCode, detail: string, targetVersion: string | null): void {
  setState({
    ...snapshot(),
    phase: 'failed',
    targetVersion,
    downloadedBytes: 0,
    totalBytes: 0,
    failure: { code, detail },
  })
}

// ── Download / staging ──────────────────────────────────────────────────────

export interface SelfUpdateDeps {
  io?: UpgradeIo
  fetchFn?: typeof fetch
  repo?: string
  now?: () => number
}

/**
 * Download and stage the newest release. Idempotent while one is in flight, and a
 * no-op when there is nothing newer or this installation cannot self-update.
 *
 * Never throws: every failure lands in the snapshot as a retryable `failed`.
 */
export async function startSelfUpdate(deps: SelfUpdateDeps = {}): Promise<void> {
  if (busy) return
  const facts = rt()
  const capability = selfUpdateCapability(facts)
  if (!capability.capable) {
    setState({ ...idleState(), capable: false, incapableReason: capability.reason })
    return
  }
  if (snapshot().phase === 'ready' || snapshot().phase === 'applying') return

  busy = true
  cancelled = false
  const io = deps.io ?? defaultUpgradeIo()
  const fetchFn = deps.fetchFn ?? fetch
  const { env, execPath, platform, arch } = facts
  const repo = deps.repo ?? DEFAULT_REPO
  const now = deps.now ?? Date.now
  const dir = stagingDir(facts.home())

  let target: string | null = null
  try {
    const resolved = await resolveLatestRelease(repo, fetchFn, env)
    const latest = normalizeVersion(resolved.tag)
    target = latest
    if (decideAction({ current: facts.version, latest }) !== 'update') {
      clearStaging(dir)
      setState(idleState())
      return
    }

    // A package staged by an earlier run (or an earlier boot) for this exact
    // version is already verified; re-downloading it buys nothing.
    const existing = readStagedRecord(dir)
    if (existing && existing.version === latest && existing.execPath === execPath) {
      patchState({ phase: 'ready', targetVersion: latest, downloadedBytes: 0, totalBytes: 0 })
      return
    }

    resetStaging(dir)
    patchState({
      phase: 'downloading',
      targetVersion: latest,
      downloadedBytes: 0,
      totalBytes: 0,
      failure: undefined,
    })

    let lastBytes = 0
    let lastAt = 0
    const staged = await stageRelease(
      {
        repo,
        tag: resolved.tag,
        version: latest,
        target: hostTarget(platform, arch),
        dir,
        assets: resolved.assets,
      },
      {
        io,
        fetchFn,
        env,
        shouldAbort: () => cancelled,
        onProgress: (received, total) => {
          const at = now()
          const complete = total > 0 && received >= total
          if (
            !complete &&
            received - lastBytes < PROGRESS_EVERY_BYTES &&
            at - lastAt < PROGRESS_EVERY_MS
          ) {
            return
          }
          lastBytes = received
          lastAt = at
          patchState({
            phase: complete ? 'verifying' : 'downloading',
            downloadedBytes: received,
            totalBytes: total,
          })
        },
      },
    )

    writeStagedRecord(dir, {
      version: staged.version,
      tag: staged.tag,
      binPath: staged.binPath,
      execPath,
      fromVersion: facts.version,
    })
    patchState({ phase: 'ready', targetVersion: staged.version })
  } catch (e) {
    clearStaging(dir)
    if (cancelled) setState(idleState())
    else fail(failureCodeFor(e), (e as Error).message, target)
  } finally {
    busy = false
    cancelled = false
  }
}

/**
 * Abandon the current update: interrupt an in-flight download or discard a staged
 * package. A download in flight notices between chunks and cleans up its own
 * partial file.
 */
export function cancelSelfUpdate(): void {
  const phase = snapshot().phase
  if (phase === 'applying') return
  if (busy) {
    cancelled = true
    return
  }
  clearStaging(stagingDir(rt().home()))
  setState(idleState())
}

// ── Apply + relaunch ────────────────────────────────────────────────────────

/** Process-lifecycle hooks the server owns; injected so this module stays testable. */
export interface RelaunchHooks {
  /** Stop accepting connections and release the listening port. */
  releasePort: () => Promise<void>
  /** End this process. */
  exit: (code: number) => void
  /** Spawn the successor for the foreground form, inheriting this terminal. */
  spawnSuccessor: () => boolean
  /** Run a service-manager command. */
  run: (cmd: string, args: string[]) => { status: number | null; stderr: string }
  /** Spawn the detached relaunch helper. */
  spawnAssistant: typeof spawnUpdateAssistant
  /** This process's pid, for the helper to wait on. */
  pid: number
}

let relaunchHooks: RelaunchHooks | null = null

/** Install the process-lifecycle hooks. Called once during server startup. */
export function configureRelaunch(hooks: RelaunchHooks): void {
  relaunchHooks = hooks
}

/**
 * Swap in the staged binary and hand off the relaunch. Valid only in `ready`.
 *
 * Who performs the swap depends on who owns the process. Forms that relaunch
 * themselves (systemd, launchd, a plain foreground run) let this process do it
 * and then step aside. Forms where the successor must be spawned by someone else
 * (a `--daemon` background process, a Windows scheduled task) delegate the whole
 * swap-and-relaunch to a detached helper, because this process cannot outlive its
 * own exit to start the replacement.
 */
export async function applySelfUpdate(deps: SelfUpdateDeps = {}): Promise<void> {
  const hooks = relaunchHooks
  if (!hooks) return
  if (snapshot().phase !== 'ready') return

  const { platform } = rt()
  const home = rt().home()
  const io = deps.io ?? defaultUpgradeIo()
  const dir = stagingDir(home)
  const record = readStagedRecord(dir)
  if (!record) {
    fail('replace', 'the staged package is gone; download it again', snapshot().targetVersion)
    return
  }

  patchState({ phase: 'applying', failure: undefined })
  const strategy = resolveRelaunchStrategy(
    detectRuntimeForms({ platform, osHome: rt().osHome, c3Home: home }),
    platform,
  )

  if (strategy === 'assistant-daemon' || strategy === 'assistant-schtasks') {
    const spawned = hooks.spawnAssistant({
      waitPid: hooks.pid,
      updateDir: dir,
      form: strategy === 'assistant-daemon' ? 'daemon' : 'schtasks',
    })
    if (!spawned) {
      fail('relaunch', 'could not start the update helper', record.version)
      return
    }
    await hooks.releasePort()
    hooks.exit(0)
    return
  }

  try {
    applyStaged(io, record.binPath, record.execPath, platform)
  } catch (e) {
    fail(failureCodeFor(e), (e as Error).message, record.version)
    return
  }
  // The swap succeeded, so the staged package has served its purpose; leaving it
  // would make the next boot think an update is still pending.
  clearStaging(dir)

  if (strategy === 'systemd') {
    // `--no-block` is mandatory: this process IS the unit, so systemd kills the
    // `systemctl` child along with it. An enqueued job survives that; a blocking
    // wait would not.
    const r = hooks.run('systemctl', ['--user', 'restart', '--no-block', SYSTEMD_UNIT_NAME])
    if (r.status !== 0) {
      fail(
        'relaunch',
        `systemctl --user restart failed (exit ${r.status}); the new binary is installed — restart c3 to use it`,
        record.version,
      )
      return
    }
    await hooks.releasePort()
    hooks.exit(0)
    return
  }

  if (strategy === 'launchd') {
    // The agent is KeepAlive, so exiting cleanly IS the restart.
    await hooks.releasePort()
    hooks.exit(0)
    return
  }

  // Foreground: nobody will relaunch this, so spawn the successor onto the same
  // terminal after the port is free, then step aside.
  await hooks.releasePort()
  if (!hooks.spawnSuccessor()) {
    fail(
      'relaunch',
      'could not start the new version; the new binary is installed — run c3 again to use it',
      record.version,
    )
    return
  }
  hooks.exit(0)
}

// ── Boot reconciliation ─────────────────────────────────────────────────────

/**
 * Reconcile the staging area with reality at startup. Three inputs, three
 * outcomes: a failure the helper left behind becomes a visible `failed`; a
 * package for a version we are already running is spent and gets cleaned; a
 * package for a newer version survives a restart as `ready`.
 */
export function restoreStagedOnBoot(): void {
  const facts = rt()
  const dir = stagingDir(facts.home())

  const failure = readApplyFailure(dir)
  if (failure) {
    clearApplyFailure(dir)
    clearStaging(dir)
    fail(failure.code, failure.detail ?? 'the update could not be applied', null)
    return
  }

  const record = readStagedRecord(dir)
  if (!record) {
    setState(idleState())
    return
  }
  if (record.execPath !== facts.execPath || compareVersions(record.version, facts.version) <= 0) {
    clearStaging(dir)
    setState(idleState())
    return
  }
  setState({ ...idleState(), phase: 'ready', targetVersion: record.version })
}

/**
 * Start a background download when the checker says a newer release exists. Called
 * after every check, so a release cut while c3 is running is picked up on the next
 * tick, and a download that failed is retried then too.
 */
export function maybeAutoDownload(deps: SelfUpdateDeps = {}): void {
  if (!currentUpdateStatus().available) return
  const phase = snapshot().phase
  if (phase === 'ready' || phase === 'applying') return
  void startSelfUpdate(deps)
}
