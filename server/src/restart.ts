/**
 * `c3 restart` — restart the current c3 so a freshly `c3 upgrade`d binary takes
 * effect. upgrade only swaps the file on disk; an already-running process keeps
 * the old image in memory until restarted. This command bridges that gap.
 *
 * It restarts ONLY the forms c3 owns, by priority OS service > `--daemon`:
 *   - OS service installed → delegate to the service manager so it re-reads its
 *     unit (which references the path, now the new binary) and relaunches with the
 *     baked-in args: `systemctl --user restart` / `launchctl kickstart -k` /
 *     `schtasks /End`+`/Run`. We never kill+respawn a managed process ourselves —
 *     that fights the manager's KeepAlive/Restart policy.
 *   - `--daemon` background process → stop the recorded pid (SIGTERM, poll, then
 *     SIGKILL as a backstop), then relaunch from the persisted options sidecar.
 *   - neither → report there is nothing to restart (a foreground session is not
 *     owned by c3; the user must exit and rerun it).
 *
 * restart never downloads and never upgrades — it only restarts the binary on
 * disk. All side effects are injectable for unit tests.
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { c3HomeDir } from './kernel/config/index.js'
import {
  DAEMON_OPTIONS_NAME,
  PID_FILE_NAME,
  isProcessAlive,
  readActivePid,
  readDaemonOptions,
  startDaemon,
  type DaemonOutcome,
  type DaemonStartOptions,
} from './daemon.js'
import {
  LAUNCHD_LABEL,
  SCHTASKS_TASK_NAME,
  SYSTEMD_UNIT_NAME,
  UnsupportedPlatformError,
} from './service-install.js'

/** The runtime forms c3 can detect and restart. */
export interface RuntimeForms {
  /** An OS service (systemd/launchd/schtasks) is installed for c3. */
  service: boolean
  /** Live pid of a `--daemon` background instance, or null if none. */
  daemonPid: number | null
}

interface CommandResult {
  status: number | null
  stderr: string
  errorCode?: string
}

/** Probes used by {@link detectRuntimeForms}, injectable for tests. */
export interface RuntimeProbeDeps {
  fileExists?: (path: string) => boolean
  run?: (cmd: string, args: string[]) => CommandResult
  isAlive?: (pid: number) => boolean
}

function defaultRun(cmd: string, args: string[]): CommandResult {
  const r = spawnSync(cmd, args, { encoding: 'utf-8' })
  if (r.error) {
    return {
      status: r.status ?? 1,
      stderr: r.stderr || String(r.error),
      errorCode: (r.error as NodeJS.ErrnoException).code,
    }
  }
  return { status: r.status, stderr: r.stderr ?? '' }
}

/** The systemd/launchd unit file path for a file-based platform, else null (win32). */
function serviceUnitPath(platform: NodeJS.Platform, osHome: string): string | null {
  if (platform === 'linux') return join(osHome, '.config', 'systemd', 'user', SYSTEMD_UNIT_NAME)
  if (platform === 'darwin')
    return join(osHome, 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`)
  return null
}

function taskIsMissing(result: CommandResult): boolean {
  return (
    result.status !== 0 &&
    !result.errorCode &&
    /(?:cannot find|not found|does not exist)/i.test(result.stderr)
  )
}

/**
 * Detect which runtime forms exist. Service presence reuses the SAME judgement as
 * install/uninstall (unit/plist file existence on linux/darwin; `schtasks /Query`
 * on win32). Daemon presence is the live pid recorded in `~/.c3/c3.pid`. Note the
 * two roots differ: service units live under the OS home, the pid under the c3 home.
 */
export function detectRuntimeForms(opts: {
  platform?: NodeJS.Platform
  osHome?: string
  c3Home?: string
  deps?: RuntimeProbeDeps
}): RuntimeForms {
  const platform = opts.platform ?? process.platform
  const osHome = opts.osHome ?? homedir()
  const c3Home = opts.c3Home ?? c3HomeDir()
  const fileExists = opts.deps?.fileExists ?? existsSync
  const run = opts.deps?.run ?? defaultRun
  const isAlive = opts.deps?.isAlive ?? isProcessAlive

  let service = false
  const unitPath = serviceUnitPath(platform, osHome)
  if (unitPath) {
    service = fileExists(unitPath)
  } else if (platform === 'win32') {
    const probe = run('schtasks', ['/Query', '/TN', SCHTASKS_TASK_NAME])
    service = probe.status === 0 && !taskIsMissing(probe)
  }

  const daemonPid = readActivePid(join(c3Home, PID_FILE_NAME), isAlive)
  return { service, daemonPid }
}

// ── Restart orchestration ───────────────────────────────────────────────────

export interface RestartDeps {
  platform?: NodeJS.Platform
  osHome?: string
  c3Home?: string
  fileExists?: (path: string) => boolean
  run?: (cmd: string, args: string[]) => CommandResult
  kill?: (pid: number, signal: NodeJS.Signals) => void
  isAlive?: (pid: number) => boolean
  getuid?: () => number
  readOptions?: (path: string) => DaemonStartOptions | null
  startDaemonFn?: (opts: DaemonStartOptions) => DaemonOutcome
  /** Awaited between liveness polls; tests inject an instant resolver. */
  sleep?: (ms: number) => Promise<void>
  log?: (msg: string) => void
  errlog?: (msg: string) => void
}

function defaultKill(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e // already gone is fine
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** Issue the service-manager restart for the platform. */
function restartService(
  platform: NodeJS.Platform,
  run: (cmd: string, args: string[]) => CommandResult,
  getuid: () => number,
  log: (m: string) => void,
  errlog: (m: string) => void,
): number {
  if (platform === 'win32') {
    // /End may report "task not running"; tolerate it — /Run is the one that must
    // succeed (the goal is to END up running the new binary, not to assert prior state).
    run('schtasks', ['/End', '/TN', SCHTASKS_TASK_NAME])
    const r = run('schtasks', ['/Run', '/TN', SCHTASKS_TASK_NAME])
    if (r.status !== 0) {
      errlog(`[c3 restart] schtasks /Run failed (exit ${r.status})`)
      if (r.stderr.trim()) errlog(r.stderr.trim())
      return 1
    }
    log('[c3 restart] restarted Windows scheduled task c3')
    return 0
  }
  let cmd: string
  let args: string[]
  if (platform === 'linux') {
    cmd = 'systemctl'
    args = ['--user', 'restart', SYSTEMD_UNIT_NAME]
  } else if (platform === 'darwin') {
    cmd = 'launchctl'
    args = ['kickstart', '-k', `gui/${getuid()}/${LAUNCHD_LABEL}`]
  } else {
    throw new UnsupportedPlatformError(platform)
  }
  const r = run(cmd, args)
  if (r.status !== 0) {
    errlog(`[c3 restart] ${cmd} ${args.join(' ')} failed (exit ${r.status})`)
    if (r.stderr.trim()) errlog(r.stderr.trim())
    return 1
  }
  log(`[c3 restart] restarted ${platform} service`)
  return 0
}

/** Stop the recorded daemon pid, then relaunch from the persisted options. */
async function restartDaemon(
  pid: number,
  c3Home: string,
  kill: (pid: number, signal: NodeJS.Signals) => void,
  isAlive: (pid: number) => boolean,
  readOptions: (path: string) => DaemonStartOptions | null,
  startDaemonFn: (opts: DaemonStartOptions) => DaemonOutcome,
  sleep: (ms: number) => Promise<void>,
  log: (m: string) => void,
  errlog: (m: string) => void,
): Promise<number> {
  kill(pid, 'SIGTERM')
  let alive = isAlive(pid)
  for (let i = 0; i < 50 && alive; i++) {
    await sleep(100)
    alive = isAlive(pid)
  }
  if (alive) {
    // Graceful stop timed out — escalate, but NEVER start a new instance while the
    // old one might still hold the port (double-instance / port conflict).
    kill(pid, 'SIGKILL')
    for (let i = 0; i < 20 && isAlive(pid); i++) await sleep(100)
    if (isAlive(pid)) {
      errlog(
        `[c3 restart] daemon pid ${pid} did not exit after SIGKILL; not starting a new instance`,
      )
      return 1
    }
  }

  const opts = readOptions(join(c3Home, DAEMON_OPTIONS_NAME))
  if (!opts) {
    errlog(`[c3 restart] daemon options sidecar missing or corrupt (${DAEMON_OPTIONS_NAME})`)
    errlog(`[c3 restart] start it manually: c3 start --daemon [--port …]`)
    return 1
  }
  const outcome = startDaemonFn(opts)
  if (outcome.kind === 'already-running') {
    errlog(`[c3 restart] a daemon is unexpectedly already running (pid ${outcome.pid})`)
    return 1
  }
  log(`[c3 restart] restarted background daemon (pid ${outcome.pid})`)
  return 0
}

/**
 * Run `c3 restart`. Returns a process exit code: success or "nothing to restart"
 * are both 0; a service command failure / undead daemon / missing sidecar are
 * non-zero with stderr. Priority is OS service over daemon (the longer-lived,
 * OS-managed form wins, and the chosen form is named in the output).
 */
export async function runRestart(deps: RestartDeps = {}): Promise<number> {
  const platform = deps.platform ?? process.platform
  const osHome = deps.osHome ?? homedir()
  const c3Home = deps.c3Home ?? c3HomeDir()
  const run = deps.run ?? defaultRun
  const isAlive = deps.isAlive ?? isProcessAlive
  const kill = deps.kill ?? defaultKill
  const getuid =
    deps.getuid ?? (() => (typeof process.getuid === 'function' ? process.getuid() : 0))
  const readOptions = deps.readOptions ?? readDaemonOptions
  const startDaemonFn = deps.startDaemonFn ?? ((o: DaemonStartOptions) => startDaemon(o))
  const sleep = deps.sleep ?? defaultSleep
  const log = deps.log ?? ((m: string) => console.log(m))
  const errlog = deps.errlog ?? ((m: string) => console.error(m))

  const forms = detectRuntimeForms({
    platform,
    osHome,
    c3Home,
    deps: { fileExists: deps.fileExists, run, isAlive },
  })

  try {
    if (forms.service) {
      if (forms.daemonPid !== null) {
        log(
          `[c3 restart] both an OS service and a daemon (pid ${forms.daemonPid}) exist; restarting the service`,
        )
      }
      return restartService(platform, run, getuid, log, errlog)
    }
    if (forms.daemonPid !== null) {
      return await restartDaemon(
        forms.daemonPid,
        c3Home,
        kill,
        isAlive,
        readOptions,
        startDaemonFn,
        sleep,
        log,
        errlog,
      )
    }
    log('[c3 restart] no OS service or background daemon to restart')
    log(
      '[c3 restart] if c3 is running in this terminal, exit it and re-run c3 to use the new version',
    )
    return 0
  } catch (e) {
    if (e instanceof UnsupportedPlatformError) {
      errlog(`[c3 restart] ${e.message.replace("'c3 install'", "'c3 restart'")}`)
      return 1
    }
    errlog(`[c3 restart] unexpected error: ${(e as Error).message}`)
    return 1
  }
}
