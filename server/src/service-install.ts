/**
 * `c3 install` — register c3 as a per-user, OS-managed background service.
 *
 * Per-user (never root/admin) by design: c3 is a single-user, localhost-only
 * tool, so each platform's user-scoped mechanism is used and the unit launches
 * the SAME `c3 start` (no `--daemon` — the service manager owns the lifecycle,
 * the two do not stack):
 *
 *   - Linux   → systemd USER unit at `~/.config/systemd/user/c3.service`,
 *               registered via `systemctl --user`. Surviving logout needs an
 *               explicit `loginctl enable-linger` (printed as a hint).
 *   - macOS   → launchd LaunchAgent plist at `~/Library/LaunchAgents/<label>.plist`,
 *               registered via `launchctl load -w`.
 *   - Windows → Task Scheduler logon-triggered task via `schtasks` (no native
 *               service wrapper — the single binary is not SCM-compatible, and a
 *               logon task needs no admin and matches the per-user scope).
 *
 * Non-goals (held): no auto-update, no `uninstall`. The pure plan builders are
 * snapshot-tested per platform; execution side effects (write unit, run register
 * command) are injectable so the failure path (register non-zero ⇒ surfaced
 * stderr, never swallowed) is testable without touching the real OS.
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { buildStartArgs, resolveSelfCommand, type DaemonStartOptions } from './daemon.js'

/** launchd LaunchAgent label (also the plist basename). */
export const LAUNCHD_LABEL = 'center.c3.server'
/** systemd user unit filename. */
export const SYSTEMD_UNIT_NAME = 'c3.service'
/** Windows Task Scheduler task name. */
export const SCHTASKS_TASK_NAME = 'c3'

/** A single OS command to run as part of registration (array form — no shell). */
export interface ServiceCommand {
  cmd: string
  args: string[]
}

/**
 * A platform-resolved installation plan: the unit file to write (none on
 * Windows, which registers entirely through `schtasks`), the registration
 * command sequence, and human-facing post-install notes (linger hint, manual
 * uninstall steps). Pure data so it can be asserted in a snapshot test.
 */
export interface ServicePlan {
  platform: NodeJS.Platform
  /** Absolute path of the unit/plist file to write, or null (Windows). */
  unitPath: string | null
  /** Unit/plist file content, or null when no file is written. */
  unitContent: string | null
  /** Commands run in order to register the service; first non-zero aborts. */
  registerCommands: ServiceCommand[]
  /** Lines printed after a successful install (hints + manual uninstall). */
  notes: string[]
}

/** Inputs needed to render a plan: how to launch c3 plus where HOME lives. */
export interface ServiceInstallInputs {
  platform: NodeJS.Platform
  /** The executable to run (compiled c3 binary, or the interpreter in dev). */
  execPath: string
  /** `process.argv[1]` — the script path, used only under an interpreter. */
  scriptPath?: string
  /** `process.execArgv` — runtime flags (e.g. tsx loader) preserved under an interpreter. */
  execArgv?: string[]
  /** The user's home dir (unit-file location root). */
  home: string
  /** Resolved `start` parameters (workspace/port/dev/settings) baked into the unit. */
  start: DaemonStartOptions
}

/** Thrown for a `process.platform` with no service mapping (failure path). */
export class UnsupportedPlatformError extends Error {
  constructor(public readonly platform: NodeJS.Platform) {
    super(`unsupported platform for 'c3 install': ${platform}`)
    this.name = 'UnsupportedPlatformError'
  }
}

/** Quote a single token for a systemd `ExecStart=` line (double-quote if needed). */
function systemdQuote(token: string): string {
  return /[\s"'\\]/.test(token) ? `"${token.replace(/(["\\])/g, '\\$1')}"` : token
}

/** XML-escape a value for inclusion in a launchd plist `<string>` element. */
function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/** Resolve the c3 launch command (executable + args) the unit must run. */
function launchCommand(inputs: ServiceInstallInputs): { command: string; args: string[] } {
  const childArgs = buildStartArgs(inputs.start)
  return resolveSelfCommand(inputs.execPath, inputs.scriptPath, childArgs, inputs.execArgv)
}

/** Build the Linux systemd user unit plan. */
function planLinux(inputs: ServiceInstallInputs): ServicePlan {
  const { command, args } = launchCommand(inputs)
  const execStart = [command, ...args].map(systemdQuote).join(' ')
  const workingDir = inputs.start.workspacePath ?? inputs.home
  const unitContent = [
    '[Unit]',
    'Description=c3 - Code Creative Center',
    'After=network.target',
    '',
    '[Service]',
    'Type=simple',
    `ExecStart=${execStart}`,
    `WorkingDirectory=${workingDir}`,
    'Restart=on-failure',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n')
  const unitPath = join(inputs.home, '.config', 'systemd', 'user', SYSTEMD_UNIT_NAME)
  return {
    platform: 'linux',
    unitPath,
    unitContent,
    registerCommands: [
      { cmd: 'systemctl', args: ['--user', 'daemon-reload'] },
      { cmd: 'systemctl', args: ['--user', 'enable', '--now', SYSTEMD_UNIT_NAME] },
    ],
    notes: [
      'To keep c3 running after logout / start at boot before login, enable lingering:',
      '  loginctl enable-linger',
      'Auto-update and uninstall are not provided. To remove the service manually:',
      `  systemctl --user disable --now ${SYSTEMD_UNIT_NAME}`,
      `  rm ${unitPath}`,
    ],
  }
}

/** Build the macOS launchd LaunchAgent plan. */
function planDarwin(inputs: ServiceInstallInputs): ServicePlan {
  const { command, args } = launchCommand(inputs)
  const programArgs = [command, ...args]
    .map((a) => `    <string>${xmlEscape(a)}</string>`)
    .join('\n')
  const workingDir = inputs.start.workspacePath ?? inputs.home
  const unitPath = join(inputs.home, 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`)
  const unitContent = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    `  <string>${LAUNCHD_LABEL}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    programArgs,
    '  </array>',
    '  <key>WorkingDirectory</key>',
    `  <string>${xmlEscape(workingDir)}</string>`,
    '  <key>RunAtLoad</key>',
    '  <true/>',
    '  <key>KeepAlive</key>',
    '  <true/>',
    '</dict>',
    '</plist>',
    '',
  ].join('\n')
  return {
    platform: 'darwin',
    unitPath,
    unitContent,
    registerCommands: [{ cmd: 'launchctl', args: ['load', '-w', unitPath] }],
    notes: [
      'The LaunchAgent starts within your login session each time you log in.',
      'Auto-update and uninstall are not provided. To remove the service manually:',
      `  launchctl unload ${unitPath}`,
      `  rm ${unitPath}`,
    ],
  }
}

/** Build the Windows Task Scheduler (schtasks) plan. */
function planWindows(inputs: ServiceInstallInputs): ServicePlan {
  const { command, args } = launchCommand(inputs)
  // schtasks /TR is a single string; quote the executable and any arg with spaces.
  const tr = [command, ...args].map((t) => (/\s/.test(t) ? `"${t}"` : t)).join(' ')
  return {
    platform: 'win32',
    unitPath: null,
    unitContent: null,
    registerCommands: [
      {
        cmd: 'schtasks',
        args: ['/Create', '/TN', SCHTASKS_TASK_NAME, '/TR', tr, '/SC', 'ONLOGON', '/F'],
      },
    ],
    notes: [
      'The task runs c3 at logon (it is a logon-triggered task, not a pre-login service).',
      'Auto-update and uninstall are not provided. To remove the task manually:',
      `  schtasks /Delete /TN ${SCHTASKS_TASK_NAME} /F`,
    ],
  }
}

/**
 * Resolve the per-platform installation plan. Throws {@link UnsupportedPlatformError}
 * for any `process.platform` outside the three supported targets (the failure-path
 * branch — exercised by tests, and the CLI exits non-zero on it).
 */
export function planServiceInstall(inputs: ServiceInstallInputs): ServicePlan {
  switch (inputs.platform) {
    case 'linux':
      return planLinux(inputs)
    case 'darwin':
      return planDarwin(inputs)
    case 'win32':
      return planWindows(inputs)
    default:
      throw new UnsupportedPlatformError(inputs.platform)
  }
}

/** Result of running an install plan against the OS. */
export type InstallResult =
  | { kind: 'installed'; plan: ServicePlan }
  | {
      kind: 'register-failed'
      plan: ServicePlan
      command: ServiceCommand
      status: number | null
      stderr: string
    }

/** Injectable side effects so {@link executeServiceInstall} is testable. */
export interface ExecuteDeps {
  writeFile?: (path: string, content: string) => void
  run?: (cmd: string, args: string[]) => { status: number | null; stderr: string }
}

/** Default file writer: ensure the unit's parent dir then write it. */
function defaultWriteFile(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

/** Default command runner: synchronous, capturing stderr for the failure message. */
function defaultRun(cmd: string, args: string[]): { status: number | null; stderr: string } {
  const r = spawnSync(cmd, args, { encoding: 'utf-8' })
  if (r.error) {
    // e.g. ENOENT when systemctl/launchctl/schtasks is absent — surface it.
    return { status: r.status ?? 1, stderr: r.stderr || String(r.error) }
  }
  return { status: r.status, stderr: r.stderr ?? '' }
}

/**
 * Execute a resolved plan: write the unit file (if any), then run each register
 * command in order. The FIRST command that returns a non-zero/null status aborts
 * and returns `register-failed` carrying the offending command + its stderr — the
 * error is surfaced, never swallowed (a clean, actionable failure path).
 */
export function executeServiceInstall(plan: ServicePlan, deps: ExecuteDeps = {}): InstallResult {
  const writeFile = deps.writeFile ?? defaultWriteFile
  const run = deps.run ?? defaultRun
  if (plan.unitPath && plan.unitContent !== null) {
    writeFile(plan.unitPath, plan.unitContent)
  }
  for (const command of plan.registerCommands) {
    const { status, stderr } = run(command.cmd, command.args)
    if (status !== 0) {
      return { kind: 'register-failed', plan, command, status, stderr }
    }
  }
  return { kind: 'installed', plan }
}

/** Inputs the CLI gathers before installing (resolved workspace/port/settings). */
export interface InstallServiceArgs {
  platform: NodeJS.Platform
  execPath: string
  scriptPath?: string
  execArgv?: string[]
  home?: string
  start: DaemonStartOptions
}

/**
 * Orchestrate a real install: resolve the plan for the current platform and run
 * it. An unsupported platform propagates as {@link UnsupportedPlatformError}; the
 * CLI catches it and exits non-zero with an actionable message.
 */
export function installService(args: InstallServiceArgs, deps: ExecuteDeps = {}): InstallResult {
  const plan = planServiceInstall({
    platform: args.platform,
    execPath: args.execPath,
    scriptPath: args.scriptPath,
    execArgv: args.execArgv,
    home: args.home ?? homedir(),
    start: args.start,
  })
  return executeServiceInstall(plan, deps)
}
