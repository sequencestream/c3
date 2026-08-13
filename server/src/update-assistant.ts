/**
 * `c3 update-apply` — the detached helper that finishes a console-driven update
 * after the server that asked for it is gone.
 *
 * A managed instance cannot install its own successor: a daemon that swaps its
 * binary and then spawns a replacement would be racing itself for the port, and a
 * Windows scheduled task that ends itself never gets to run `/Run`. So the server
 * stages the package, spawns this helper, and exits. The helper then:
 *
 *   wait for the old pid to die → swap the binary → relaunch the owning form
 *
 * It is hidden from `--help` because it is never something a user invokes; it is
 * an implementation detail of "restart to update".
 *
 * Failures are reported by leaving an `apply-failure.json` in the staging dir —
 * there is no console left to talk to. The next boot reads it, shows it, clears
 * it. A failure before the swap leaves the old binary installed and runnable;
 * a failure after it leaves the NEW binary installed but not launched, which the
 * user resolves by starting c3 again.
 */
import { spawn, spawnSync, type SpawnOptions } from 'node:child_process'
import { dirname, join } from 'node:path'
import {
  DAEMON_OPTIONS_NAME,
  isProcessAlive,
  readDaemonOptions,
  resolveSelfCommand,
  startDaemon,
  type DaemonOutcome,
  type DaemonStartOptions,
} from './daemon.js'
import { setDbPath } from './kernel/infra/db.js'
import { SCHTASKS_TASK_NAME } from './service-install.js'
import { applyStaged, defaultUpgradeIo, type UpgradeIo } from './upgrade.js'
import {
  clearStaging,
  readStagedRecord,
  writeApplyFailure,
  type StagedUpdateRecord,
} from './features/updates/staging.js'

/** The (hidden) CLI subcommand name. */
export const UPDATE_ASSISTANT_COMMAND = 'update-apply'

/** Which owning form the helper must relaunch after the swap. */
export type AssistantForm = 'daemon' | 'schtasks'

export interface AssistantOptions {
  /** The pid of the server that is exiting; the helper waits for it to die. */
  waitPid: number
  /** The staging directory holding `staged.json` and the unpacked binary. */
  updateDir: string
  form: AssistantForm
}

/** How long to wait for the old process to exit before giving up (ms). */
const EXIT_TIMEOUT_MS = 30_000
/** Liveness poll interval while waiting (ms). */
const EXIT_POLL_MS = 100

/** The argv (after the executable) that runs the helper. */
export function buildAssistantArgs(opts: AssistantOptions): string[] {
  return [
    UPDATE_ASSISTANT_COMMAND,
    '--wait-pid',
    String(opts.waitPid),
    '--update-dir',
    opts.updateDir,
    '--form',
    opts.form,
  ]
}

/**
 * Launch the helper, fully detached so it survives this process's exit. Returns
 * false when the spawn itself failed, so the caller can stay alive and report
 * instead of exiting into nothing.
 */
export function spawnUpdateAssistant(
  opts: AssistantOptions,
  deps: { spawnFn?: typeof spawn } = {},
): boolean {
  const spawnFn = deps.spawnFn ?? spawn
  const { command, args } = resolveSelfCommand(
    process.execPath,
    process.argv[1],
    buildAssistantArgs(opts),
    process.execArgv,
  )
  const spawnOpts: SpawnOptions = { detached: true, stdio: 'ignore' }
  try {
    const child = spawnFn(command, args, spawnOpts)
    child.unref()
    return child.pid !== undefined
  } catch {
    return false
  }
}

export interface AssistantDeps {
  platform?: NodeJS.Platform
  io?: UpgradeIo
  isAlive?: (pid: number) => boolean
  sleep?: (ms: number) => Promise<void>
  run?: (cmd: string, args: string[]) => { status: number | null; stderr: string }
  readOptions?: (path: string) => DaemonStartOptions | null
  startDaemonFn?: (opts: DaemonStartOptions) => DaemonOutcome
  setDb?: (path: string) => void
  readRecord?: (dir: string) => StagedUpdateRecord | null
  reportFailure?: (dir: string, code: 'replace' | 'relaunch', detail: string) => void
  cleanup?: (dir: string) => void
}

function defaultRun(cmd: string, args: string[]): { status: number | null; stderr: string } {
  const r = spawnSync(cmd, args, { encoding: 'utf-8' })
  if (r.error) return { status: r.status ?? 1, stderr: String(r.error) }
  return { status: r.status, stderr: r.stderr ?? '' }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** Poll until `pid` is gone or the deadline passes. Returns true when it exited. */
async function waitForExit(
  pid: number,
  isAlive: (pid: number) => boolean,
  sleep: (ms: number) => Promise<void>,
): Promise<boolean> {
  const attempts = Math.ceil(EXIT_TIMEOUT_MS / EXIT_POLL_MS)
  for (let i = 0; i < attempts; i++) {
    if (!isAlive(pid)) return true
    await sleep(EXIT_POLL_MS)
  }
  return !isAlive(pid)
}

/**
 * Run the helper. Returns a process exit code; nobody reads it (the helper has no
 * terminal), but it keeps the function testable and mirrors the CLI convention.
 */
export async function runUpdateAssistant(
  opts: AssistantOptions,
  deps: AssistantDeps = {},
): Promise<number> {
  const platform = deps.platform ?? process.platform
  const io = deps.io ?? defaultUpgradeIo()
  const isAlive = deps.isAlive ?? isProcessAlive
  const sleep = deps.sleep ?? defaultSleep
  const run = deps.run ?? defaultRun
  const readOptions = deps.readOptions ?? readDaemonOptions
  const startDaemonFn = deps.startDaemonFn ?? ((o: DaemonStartOptions) => startDaemon(o))
  const setDb = deps.setDb ?? setDbPath
  const readRecord = deps.readRecord ?? readStagedRecord
  const cleanup = deps.cleanup ?? clearStaging
  const reportFailure =
    deps.reportFailure ??
    ((dir: string, code: 'replace' | 'relaunch', detail: string) =>
      writeApplyFailure(dir, { code, detail }))

  const record = readRecord(opts.updateDir)
  if (!record) {
    // Nothing staged (already applied, or the dir was cleaned) — not a failure
    // worth reporting; there is no update to finish.
    return 0
  }

  // Never swap while the old instance may still be running: it would be relaunched
  // into a port that is still held.
  if (!(await waitForExit(opts.waitPid, isAlive, sleep))) {
    reportFailure(
      opts.updateDir,
      'relaunch',
      `the previous c3 process (pid ${opts.waitPid}) did not exit; the update was not applied`,
    )
    return 1
  }

  try {
    applyStaged(io, record.binPath, record.execPath, platform)
  } catch (e) {
    reportFailure(opts.updateDir, 'replace', (e as Error).message)
    return 1
  }

  // The c3 home is the staging dir's parent; the daemon sidecar lives beside it.
  const c3Home = dirname(opts.updateDir)
  const relaunch = relaunchOwner(opts.form, c3Home, { run, readOptions, startDaemonFn, setDb })
  if (relaunch) {
    reportFailure(opts.updateDir, 'relaunch', relaunch)
    return 1
  }

  cleanup(opts.updateDir)
  return 0
}

/** Relaunch the owning form. Returns an error message, or null on success. */
function relaunchOwner(
  form: AssistantForm,
  c3Home: string,
  deps: {
    run: (cmd: string, args: string[]) => { status: number | null; stderr: string }
    readOptions: (path: string) => DaemonStartOptions | null
    startDaemonFn: (opts: DaemonStartOptions) => DaemonOutcome
    setDb: (path: string) => void
  },
): string | null {
  if (form === 'schtasks') {
    const r = deps.run('schtasks', ['/Run', '/TN', SCHTASKS_TASK_NAME])
    if (r.status !== 0) {
      return `schtasks /Run failed (exit ${r.status}) ${r.stderr.trim()}`.trim()
    }
    return null
  }

  const options = deps.readOptions(join(c3Home, DAEMON_OPTIONS_NAME))
  if (!options) {
    return `the daemon options sidecar (${DAEMON_OPTIONS_NAME}) is missing or unreadable; start c3 manually`
  }
  // Resolve the same home the sidecar was written for BEFORE starting, so the new
  // daemon records its pid where the previous one did.
  if (options.dbPath) deps.setDb(options.dbPath)
  const outcome = deps.startDaemonFn(options)
  if (outcome.kind === 'already-running') {
    return `another c3 daemon is already running (pid ${outcome.pid})`
  }
  return null
}
