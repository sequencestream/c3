/** `c3 uninstall` — remove c3's per-user OS-service registration only. */
import { spawnSync } from 'node:child_process'
import { existsSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  LAUNCHD_LABEL,
  SCHTASKS_TASK_NAME,
  SYSTEMD_UNIT_NAME,
  UnsupportedPlatformError,
  type ServiceCommand,
} from './service-install.js'

/** A platform-resolved service removal plan. It contains no user-data paths. */
export interface ServiceUninstallPlan {
  platform: NodeJS.Platform
  /** Written unit/plist to remove, or null for Task Scheduler. */
  unitPath: string | null
  /** Windows task-presence probe; file-based platforms use unitPath existence. */
  probeCommand: ServiceCommand | null
  /** Commands run after the service is known to be installed. */
  unregisterCommands: ServiceCommand[]
  notInstalledMessage: string
}

export interface ServiceUninstallInputs {
  platform: NodeJS.Platform
  home: string
}

function planLinux(home: string): ServiceUninstallPlan {
  const unitPath = join(home, '.config', 'systemd', 'user', SYSTEMD_UNIT_NAME)
  return {
    platform: 'linux',
    unitPath,
    probeCommand: null,
    unregisterCommands: [
      { cmd: 'systemctl', args: ['--user', 'disable', '--now', SYSTEMD_UNIT_NAME] },
    ],
    notInstalledMessage: 'c3 systemd user service is not installed; nothing to remove.',
  }
}

function planDarwin(home: string): ServiceUninstallPlan {
  const unitPath = join(home, 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`)
  return {
    platform: 'darwin',
    unitPath,
    probeCommand: null,
    unregisterCommands: [{ cmd: 'launchctl', args: ['unload', unitPath] }],
    notInstalledMessage: 'c3 LaunchAgent is not installed; nothing to remove.',
  }
}

function planWindows(): ServiceUninstallPlan {
  return {
    platform: 'win32',
    unitPath: null,
    probeCommand: { cmd: 'schtasks', args: ['/Query', '/TN', SCHTASKS_TASK_NAME] },
    unregisterCommands: [{ cmd: 'schtasks', args: ['/Delete', '/TN', SCHTASKS_TASK_NAME, '/F'] }],
    notInstalledMessage: 'c3 Task Scheduler task is not installed; nothing to remove.',
  }
}

/** Build a pure uninstall plan for one supported platform. */
export function planServiceUninstall(inputs: ServiceUninstallInputs): ServiceUninstallPlan {
  switch (inputs.platform) {
    case 'linux':
      return planLinux(inputs.home)
    case 'darwin':
      return planDarwin(inputs.home)
    case 'win32':
      return planWindows()
    default:
      throw new UnsupportedPlatformError(inputs.platform)
  }
}

export interface CommandResult {
  status: number | null
  stderr: string
  errorCode?: string
}

export interface ExecuteServiceUninstallDeps {
  fileExists?: (path: string) => boolean
  removeFile?: (path: string) => void
  run?: (cmd: string, args: string[]) => CommandResult
}

function defaultRun(cmd: string, args: string[]): CommandResult {
  const result = spawnSync(cmd, args, { encoding: 'utf-8' })
  if (result.error) {
    return {
      status: result.status ?? 1,
      stderr: result.stderr || String(result.error),
      errorCode: (result.error as NodeJS.ErrnoException).code,
    }
  }
  return { status: result.status, stderr: result.stderr ?? '' }
}

/** unlink tolerates a concurrently/mistakenly absent unit, preserving idempotency. */
function defaultRemoveFile(path: string): void {
  try {
    unlinkSync(path)
  } catch (error: unknown) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error
  }
}

function taskIsMissing(result: CommandResult): boolean {
  return (
    result.status !== 0 &&
    !result.errorCode &&
    /(?:cannot find|not found|does not exist)/i.test(result.stderr)
  )
}

export type UninstallResult =
  | { kind: 'uninstalled'; plan: ServiceUninstallPlan }
  | { kind: 'not-installed'; plan: ServiceUninstallPlan }
  | {
      kind: 'probe-failed' | 'unregister-failed'
      plan: ServiceUninstallPlan
      command: ServiceCommand
      status: number | null
      stderr: string
      errorCode?: string
    }

/**
 * Execute removal after determining that the service exists. All side effects
 * are injectable; command stderr and missing-tool errors are retained exactly.
 */
export function executeServiceUninstall(
  plan: ServiceUninstallPlan,
  deps: ExecuteServiceUninstallDeps = {},
): UninstallResult {
  const fileExists = deps.fileExists ?? existsSync
  const removeFile = deps.removeFile ?? defaultRemoveFile
  const run = deps.run ?? defaultRun

  if (plan.unitPath && !fileExists(plan.unitPath)) return { kind: 'not-installed', plan }

  if (plan.probeCommand) {
    const probe = run(plan.probeCommand.cmd, plan.probeCommand.args)
    if (taskIsMissing(probe)) return { kind: 'not-installed', plan }
    if (probe.status !== 0) {
      return { kind: 'probe-failed', plan, command: plan.probeCommand, ...probe }
    }
  }

  for (const command of plan.unregisterCommands) {
    const result = run(command.cmd, command.args)
    if (result.status !== 0) return { kind: 'unregister-failed', plan, command, ...result }
  }
  if (plan.unitPath) removeFile(plan.unitPath)
  return { kind: 'uninstalled', plan }
}

export interface UninstallServiceArgs {
  platform: NodeJS.Platform
  home?: string
}

/** Resolve and execute service removal for the current user. */
export function uninstallService(
  args: UninstallServiceArgs,
  deps: ExecuteServiceUninstallDeps = {},
): UninstallResult {
  return executeServiceUninstall(
    planServiceUninstall({ platform: args.platform, home: args.home ?? homedir() }),
    deps,
  )
}
