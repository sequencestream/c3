/**
 * Platform adapters for the host operating system's own directory dialog.
 *
 * `add_workspace` establishes a trust root from an absolute path on the SERVER
 * filesystem, so the path has to be produced there. This module knows how to ask
 * each platform for one directory and how to read its answer back;
 * `directory-picker.ts` owns the per-connection request lifecycle.
 *
 * **Never block the event loop.** A chooser stays open for as long as the person
 * in front of the machine wants it to. Every process launch goes through an
 * asynchronous runner; a synchronous child-process API would freeze every other
 * WebSocket connection for that whole time.
 *
 * Cancellation is a normal outcome, not a failure — the caller must be able to
 * stay silent about it. Everything else (unsupported platform, missing
 * executable, no display, odd exit, unusable output) is a failure carrying a
 * short diagnostic for the server log only.
 */
import { execFile } from 'node:child_process'
import path from 'node:path'

/** How a chooser process ended. Never rejects — a launch error is an outcome. */
export interface ProcessOutcome {
  /** Process exit code, or `null` when it was killed by a signal. */
  code: number | null
  stdout: string
  stderr: string
  /** Set when the process could not be launched at all (e.g. `ENOENT`). */
  errorCode?: string
}

/** A launched chooser process: its terminal outcome plus a way to kill it. */
export interface ChooserProcess {
  done: Promise<ProcessOutcome>
  abort: () => void
}

/**
 * Launches one command. Injected so platform dispatch is testable without
 * spawning anything; the default implementation is {@link execFileRunner}.
 */
export type ProcessRunner = (command: string, args: readonly string[]) => ChooserProcess

/** The internal outcome of a chooser run, before it is mapped onto the wire. */
export type DirectoryChoice =
  { kind: 'selected'; path: string } | { kind: 'cancelled' } | { kind: 'failed'; detail: string }

/** A chooser run in flight: its eventual choice plus a way to abort it. */
export interface DirectoryChooserRun {
  result: Promise<DirectoryChoice>
  abort: () => void
}

/**
 * macOS. `choose folder` carries no prompt argument on purpose: the system
 * supplies its own, already localized to the host's language, and the server
 * holds no UI copy.
 *
 * Cancelling raises AppleScript error `-128` ("User canceled"), which is how
 * cancellation is told apart from a real failure.
 */
const OSASCRIPT_ARGS = ['-e', 'POSIX path of (choose folder)'] as const
const APPLESCRIPT_USER_CANCELLED = '-128'

/**
 * Windows. `FolderBrowserDialog` needs a single-threaded apartment, hence
 * `-STA`. The script maps its own outcomes onto exit codes so the parent never
 * has to guess: `0` + the path on stdout for a pick, `2` for a dismissal.
 * Anything else is PowerShell itself failing.
 */
const WINDOWS_CANCEL_EXIT_CODE = 2
const POWERSHELL_SCRIPT = [
  'Add-Type -AssemblyName System.Windows.Forms',
  '$dialog = New-Object System.Windows.Forms.FolderBrowserDialog',
  'if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {',
  '[Console]::Out.Write($dialog.SelectedPath); exit 0 } else { exit 2 }',
].join('; ')
const POWERSHELL_ARGS = ['-NoProfile', '-NonInteractive', '-STA', '-Command', POWERSHELL_SCRIPT]

/** Linux. `zenity` is preferred; `kdialog` is used only when it is absent. */
const ZENITY_ARGS = ['--file-selection', '--directory'] as const
const KDIALOG_ARGS = ['--getexistingdirectory'] as const

/** Every command string and argument above is a constant — nothing is interpolated. */
const NO_SHELL = { shell: false, windowsHide: true } as const

/** The default runner: asynchronous `execFile`, resolved from child lifecycle only. */
export const execFileRunner: ProcessRunner = (command, args) => {
  let settle: (outcome: ProcessOutcome) => void = () => {}
  const done = new Promise<ProcessOutcome>((resolve) => {
    settle = resolve
  })
  const child = execFile(command, [...args], NO_SHELL, (err, stdout, stderr) => {
    const errno = err as (Error & { code?: string | number }) | null
    // `execFile` reports a non-zero exit and a failed launch through the same
    // argument; only a string `code` is an OS-level launch error (`ENOENT`).
    const launchFailure = typeof errno?.code === 'string' ? errno.code : undefined
    settle({
      code: child.exitCode,
      stdout: String(stdout),
      stderr: String(stderr),
      ...(launchFailure ? { errorCode: launchFailure } : {}),
    })
  })
  return { done, abort: () => void child.kill() }
}

/**
 * Normalize a chooser's stdout into an absolute path. macOS returns POSIX paths
 * with a trailing separator; every tool ends its output with a newline. Returns
 * `null` when the output cannot be a directory path.
 *
 * `flavor` is the path grammar of the tool that produced the output, not the
 * grammar of the host running this code — `C:\work` is absolute for the Windows
 * adapter even while the test suite runs on a POSIX machine.
 */
export function normalizeChosenPath(
  raw: string,
  flavor: 'posix' | 'win32' = 'posix',
): string | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  // Strip trailing separators, but never reduce a root ("/" or "C:\") to "".
  const stripped = trimmed.replace(/[\\/]+$/, '')
  const normalized = stripped === '' || /^[A-Za-z]:$/.test(stripped) ? trimmed : stripped
  return path[flavor].isAbsolute(normalized) ? normalized : null
}

/** Whether a Linux session has any display server a GUI chooser could attach to. */
function hasLinuxDisplay(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.DISPLAY ?? env.WAYLAND_DISPLAY)
}

function selectedOrMalformed(stdout: string, flavor: 'posix' | 'win32'): DirectoryChoice {
  const chosen = normalizeChosenPath(stdout, flavor)
  return chosen ? { kind: 'selected', path: chosen } : { kind: 'failed', detail: 'unusable output' }
}

async function chooseOnMac(
  run: ProcessRunner,
  track: (p: ChooserProcess) => void,
): Promise<DirectoryChoice> {
  const proc = run('osascript', OSASCRIPT_ARGS)
  track(proc)
  const { code, stdout, stderr, errorCode } = await proc.done
  if (errorCode) return { kind: 'failed', detail: `osascript ${errorCode}` }
  if (code === 0) return selectedOrMalformed(stdout, 'posix')
  if (stderr.includes(APPLESCRIPT_USER_CANCELLED)) return { kind: 'cancelled' }
  return { kind: 'failed', detail: `osascript exit ${String(code)}` }
}

async function chooseOnWindows(
  run: ProcessRunner,
  track: (p: ChooserProcess) => void,
): Promise<DirectoryChoice> {
  const proc = run('powershell.exe', POWERSHELL_ARGS)
  track(proc)
  const { code, stdout, errorCode } = await proc.done
  if (errorCode) return { kind: 'failed', detail: `powershell ${errorCode}` }
  if (code === 0) return selectedOrMalformed(stdout, 'win32')
  if (code === WINDOWS_CANCEL_EXIT_CODE) return { kind: 'cancelled' }
  return { kind: 'failed', detail: `powershell exit ${String(code)}` }
}

/**
 * Linux. The display check runs BEFORE any launch: on a headless host `zenity`
 * exits `1` — the same code it uses for "the user pressed Cancel" — so without
 * this check a server with no GUI would silently look like a dismissal. With it,
 * exit `1` unambiguously means cancellation.
 *
 * `kdialog` is tried only when `zenity` is not installed; a `zenity` that runs
 * and cancels is a final answer.
 */
async function chooseOnLinux(
  run: ProcessRunner,
  track: (p: ChooserProcess) => void,
  aborted: () => boolean,
  env: NodeJS.ProcessEnv,
): Promise<DirectoryChoice> {
  if (!hasLinuxDisplay(env)) return { kind: 'failed', detail: 'no display' }
  const zenity = run('zenity', ZENITY_ARGS)
  track(zenity)
  const first = await zenity.done
  if (first.errorCode !== 'ENOENT') return classifyLinux('zenity', first)
  if (aborted()) return { kind: 'cancelled' }
  const kdialog = run('kdialog', KDIALOG_ARGS)
  track(kdialog)
  const second = await kdialog.done
  if (second.errorCode === 'ENOENT') return { kind: 'failed', detail: 'no zenity or kdialog' }
  return classifyLinux('kdialog', second)
}

function classifyLinux(tool: string, outcome: ProcessOutcome): DirectoryChoice {
  const { code, stdout, errorCode } = outcome
  if (errorCode) return { kind: 'failed', detail: `${tool} ${errorCode}` }
  if (code === 0) return selectedOrMalformed(stdout, 'posix')
  if (code === 1) return { kind: 'cancelled' }
  return { kind: 'failed', detail: `${tool} exit ${String(code)}` }
}

/**
 * Open one native directory chooser for the running platform.
 *
 * `abort` kills the live child and makes the run resolve as cancelled without
 * waiting for the operating system to finish tearing the process down — the
 * caller frees its slot immediately, so the next request never queues behind a
 * dialog someone left open.
 */
export function startDirectoryChooser(
  deps: { platform?: NodeJS.Platform; run?: ProcessRunner; env?: NodeJS.ProcessEnv } = {},
): DirectoryChooserRun {
  const platform = deps.platform ?? process.platform
  const run = deps.run ?? execFileRunner
  const env = deps.env ?? process.env

  let current: ChooserProcess | null = null
  let aborted = false
  const track = (proc: ChooserProcess): void => {
    // An abort that lands between two launches (the Linux fallback) must still
    // kill the process that was just started.
    if (aborted) proc.abort()
    else current = proc
  }
  const isAborted = (): boolean => aborted

  // Abort settles the run on its own, without waiting for the child to die: a
  // killed dialog can take arbitrarily long to report back, and the caller needs
  // its slot now.
  let settleAborted: () => void = () => {}
  const abortedEarly = new Promise<DirectoryChoice>((resolve) => {
    settleAborted = () => resolve({ kind: 'cancelled' })
  })

  const dispatched: Promise<DirectoryChoice> =
    platform === 'darwin'
      ? chooseOnMac(run, track)
      : platform === 'win32'
        ? chooseOnWindows(run, track)
        : platform === 'linux'
          ? chooseOnLinux(run, track, isAborted, env)
          : Promise.resolve<DirectoryChoice>({
              kind: 'failed',
              detail: `unsupported platform ${platform}`,
            })

  // An aborted run is reported as cancelled no matter what the dying child says.
  const result = Promise.race([
    dispatched.then((choice): DirectoryChoice => (aborted ? { kind: 'cancelled' } : choice)),
    abortedEarly,
  ])
  return {
    result,
    abort: () => {
      aborted = true
      current?.abort()
      current = null
      settleAborted()
    },
  }
}
