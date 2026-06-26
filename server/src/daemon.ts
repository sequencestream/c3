/**
 * `c3 start --daemon` — background launch without a daemonize dependency.
 *
 * The daemon path re-spawns the SAME executable (`process.execPath`) running a
 * plain `start` (deliberately WITHOUT `--daemon`, so it never self-forks again),
 * with `detached: true`, stdio redirected to a log file under the c3 home dir,
 * and `unref()` so the parent can exit while the child outlives the terminal
 * session. A PID file (`~/.c3/c3.pid`) records the live child so a second
 * `--daemon` invocation detects an already-running instance instead of starting
 * a duplicate; a stale PID file (process gone) is overwritten.
 *
 * This module owns ONLY process plumbing — it never imports the server runtime.
 * The actual `startServer()` runs in the child via the ordinary `start` path.
 */
import { spawn, type SpawnOptions } from 'node:child_process'
import { mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { c3HomeDir } from './kernel/config/index.js'

/** PID file recording the live daemon child, under the c3 home dir. */
export const PID_FILE_NAME = 'c3.pid'
/** stdout+stderr of the detached daemon child, under the c3 home dir. */
export const DAEMON_LOG_NAME = 'c3-daemon.log'
/** Snapshot of the resolved start options for the live daemon, under the c3 home
 * dir. Written next to the pid file so `c3 restart` can faithfully rebuild the
 * original launch command (the pid file alone carries no workspace/port/dev/settings).
 * Consumed ONLY by restart; absence/corruption never affects start/daemon itself. */
export const DAEMON_OPTIONS_NAME = 'c3.daemon.json'

/** Runtime basenames that mean "we are running under an interpreter" (dev/tsx),
 * not as the compiled single binary. In that case the child command must include
 * the script path (`argv[1]`); the compiled binary takes the subcommand directly. */
const INTERPRETER_BASENAMES = new Set(['node', 'bun', 'tsx', 'deno'])

/** The resolved `start`-launch parameters to bake into the daemon child. */
export interface DaemonStartOptions {
  workspacePath?: string
  port: number
  dev: boolean
  /** Absolute settings.json path when `--settings` was given (so the child reads
   * the SAME c3 home as the parent), otherwise undefined. */
  settingsPath?: string
}

/** Outcome of {@link startDaemon}. The CLI maps this to console output + exit code. */
export type DaemonOutcome =
  | { kind: 'started'; pid: number; logPath: string; pidPath: string }
  | { kind: 'already-running'; pid: number; pidPath: string }

/** Injectable side effects so {@link startDaemon} is unit-testable (mock spawn). */
export interface DaemonDeps {
  spawn?: typeof spawn
  /** Liveness probe for an existing PID; defaults to {@link isProcessAlive}. */
  isAlive?: (pid: number) => boolean
}

/**
 * The argv (after the executable) for the daemon child: a plain `start` carrying
 * the SAME workspace/port/dev/settings, and pointedly NO `--daemon` (the child
 * must run the server, not fork again). `--settings` is emitted first so the
 * child relocates its config root before anything reads it.
 */
export function buildStartArgs(opts: DaemonStartOptions): string[] {
  const args = ['start']
  if (opts.settingsPath) args.push('--settings', opts.settingsPath)
  if (opts.workspacePath) args.push('--workspace', opts.workspacePath)
  args.push('--port', String(opts.port))
  if (opts.dev) args.push('--dev')
  return args
}

/** True when `execPath` is a JS runtime (dev/tsx) rather than the compiled c3
 * binary. Splits on BOTH separators so a Windows `node.exe` path is recognized
 * even when this runs under a POSIX `path` (and vice-versa). Reused by `c3 upgrade`
 * to refuse self-update under a dev/interpreter run (no single binary to replace). */
export function isInterpreter(execPath: string): boolean {
  const tail = execPath.split(/[\\/]/).pop() ?? execPath
  const base = tail.toLowerCase().replace(/\.exe$/, '')
  return INTERPRETER_BASENAMES.has(base)
}

/**
 * Resolve how to re-invoke c3 itself with `childArgs`. Under the compiled single
 * binary `execPath` IS c3, so the args go straight through (and `execArgv` is
 * empty). Under an interpreter (dev/tsx) the runtime flags (`execArgv` —
 * e.g. tsx's `--import` loader, which lives there, NOT in `argv`) and the script
 * path (`scriptPath` = `process.argv[1]`) must both be prepended so
 * `node --import tsx <cli.ts> start …` is faithfully reconstructed. Reused by the
 * service installer to build each unit's launch command.
 */
export function resolveSelfCommand(
  execPath: string,
  scriptPath: string | undefined,
  childArgs: string[],
  execArgv: string[] = [],
): { command: string; args: string[] } {
  if (isInterpreter(execPath) && scriptPath) {
    return { command: execPath, args: [...execArgv, scriptPath, ...childArgs] }
  }
  return { command: execPath, args: childArgs }
}

/** Whether `pid` names a live process. `kill(pid, 0)` throws ESRCH when the
 * process is gone but EPERM when it exists under another owner (still alive). */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * Persist the resolved daemon start options as a sidecar next to the pid file so
 * `c3 restart` can rebuild the original launch command. Best-effort: a write
 * failure must never abort the daemon launch itself (restart degrades to asking
 * the user to start manually), so the caller ignores throws.
 */
export function writeDaemonOptions(optionsPath: string, opts: DaemonStartOptions): void {
  writeFileSync(optionsPath, `${JSON.stringify(opts, null, 2)}\n`)
}

/**
 * Read the daemon options sidecar. Returns null on a missing / unreadable /
 * malformed file (restart then reports it must be started manually rather than
 * guessing workspace/port/dev/settings).
 */
export function readDaemonOptions(optionsPath: string): DaemonStartOptions | null {
  let raw: string
  try {
    raw = readFileSync(optionsPath, 'utf-8')
  } catch {
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const o = parsed as Record<string, unknown>
  if (typeof o.port !== 'number' || !Number.isFinite(o.port)) return null
  if (typeof o.dev !== 'boolean') return null
  if (o.workspacePath !== undefined && typeof o.workspacePath !== 'string') return null
  if (o.settingsPath !== undefined && typeof o.settingsPath !== 'string') return null
  return {
    workspacePath: o.workspacePath as string | undefined,
    port: o.port,
    dev: o.dev,
    settingsPath: o.settingsPath as string | undefined,
  }
}

/**
 * Read the PID file and return its pid ONLY when that process is still alive; a
 * missing/garbled file or a dead (stale) pid returns null so the caller may
 * overwrite it and start fresh.
 */
export function readActivePid(pidPath: string, isAlive: (pid: number) => boolean): number | null {
  let raw: string
  try {
    raw = readFileSync(pidPath, 'utf-8')
  } catch {
    return null // no pid file ⇒ nothing running we know of
  }
  const pid = Number.parseInt(raw.trim(), 10)
  if (!Number.isInteger(pid) || pid <= 0) return null
  return isAlive(pid) ? pid : null
}

/**
 * Launch c3 in the background. Re-spawns a detached, log-redirected, unref'd
 * `start` child (no `--daemon`) and records its pid. If a live daemon is already
 * recorded, returns `already-running` WITHOUT starting a second one (a stale pid
 * is treated as absent and overwritten).
 */
export function startDaemon(opts: DaemonStartOptions, deps: DaemonDeps = {}): DaemonOutcome {
  const spawnFn = deps.spawn ?? spawn
  const isAlive = deps.isAlive ?? isProcessAlive
  const home = c3HomeDir()
  const pidPath = join(home, PID_FILE_NAME)
  const logPath = join(home, DAEMON_LOG_NAME)

  const existing = readActivePid(pidPath, isAlive)
  if (existing !== null) {
    return { kind: 'already-running', pid: existing, pidPath }
  }

  mkdirSync(home, { recursive: true })
  // Append so consecutive daemon restarts accrue history in one file; the c3
  // file-logger (initLogging) still also tees the live ~/.c3/log/c3.log inside
  // the child, this stream just captures anything before that installs.
  const logFd = openSync(logPath, 'a')
  const childArgs = buildStartArgs(opts)
  const { command, args } = resolveSelfCommand(
    process.execPath,
    process.argv[1],
    childArgs,
    process.execArgv,
  )
  const spawnOpts: SpawnOptions = {
    detached: true,
    stdio: ['ignore', logFd, logFd],
  }
  const child = spawnFn(command, args, spawnOpts)
  child.unref()
  const pid = child.pid ?? 0
  writeFileSync(pidPath, `${pid}\n`)
  // Persist a restart-only snapshot of the launch options alongside the pid file.
  // Best-effort: a failure here must not fail the (already-spawned) daemon.
  try {
    writeDaemonOptions(join(home, DAEMON_OPTIONS_NAME), opts)
  } catch {
    // restart will degrade to "start manually" if this sidecar is missing.
  }
  return { kind: 'started', pid, logPath, pidPath }
}
