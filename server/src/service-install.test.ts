import { describe, expect, it, vi } from 'vitest'
import {
  executeServiceInstall,
  planServiceInstall,
  UnsupportedPlatformError,
  LAUNCHD_LABEL,
  SCHTASKS_TASK_NAME,
  SYSTEMD_UNIT_NAME,
  type ServiceInstallInputs,
} from './service-install.js'

/** A compiled-binary install on a fixed HOME with a baked workspace + port. */
function inputs(platform: NodeJS.Platform): ServiceInstallInputs {
  return {
    platform,
    execPath: '/opt/c3/c3',
    scriptPath: undefined,
    home: '/home/alice',
    start: { workspacePath: '/home/alice/proj', port: 4321, dev: false },
  }
}

describe('planServiceInstall — platform dispatch', () => {
  it('generates a per-user systemd unit running c3 start (no --daemon, loopback only)', () => {
    const plan = planServiceInstall(inputs('linux'))
    expect(plan.platform).toBe('linux')
    expect(plan.unitPath).toBe(`/home/alice/.config/systemd/user/${SYSTEMD_UNIT_NAME}`)
    expect(plan.unitContent).toContain(
      'ExecStart=/opt/c3/c3 start --workspace /home/alice/proj --port 4321',
    )
    expect(plan.unitContent).not.toContain('--daemon')
    // localhost-only is the server default; the unit injects no host/bind override.
    expect(plan.unitContent).not.toMatch(/--host|0\.0\.0\.0|--bind/)
    expect(plan.unitContent).toContain('WantedBy=default.target')
    expect(plan.registerCommands).toEqual([
      { cmd: 'systemctl', args: ['--user', 'daemon-reload'] },
      { cmd: 'systemctl', args: ['--user', 'enable', '--now', SYSTEMD_UNIT_NAME] },
    ])
    // Linger hint is surfaced (per-user units don't auto-start before login otherwise).
    expect(plan.notes.join('\n')).toContain('loginctl enable-linger')
  })

  it('generates a per-user launchd plist with ProgramArguments + load command', () => {
    const plan = planServiceInstall(inputs('darwin'))
    expect(plan.platform).toBe('darwin')
    expect(plan.unitPath).toBe(`/home/alice/Library/LaunchAgents/${LAUNCHD_LABEL}.plist`)
    expect(plan.unitContent).toContain(`<string>${LAUNCHD_LABEL}</string>`)
    expect(plan.unitContent).toContain('<string>/opt/c3/c3</string>')
    expect(plan.unitContent).toContain('<string>start</string>')
    expect(plan.unitContent).toContain('<string>--port</string>')
    expect(plan.unitContent).toContain('<string>4321</string>')
    expect(plan.unitContent).not.toContain('--daemon')
    expect(plan.registerCommands).toEqual([
      {
        cmd: 'launchctl',
        args: ['load', '-w', `/home/alice/Library/LaunchAgents/${LAUNCHD_LABEL}.plist`],
      },
    ])
  })

  it('generates a schtasks logon task with no unit file on Windows', () => {
    const plan = planServiceInstall({
      ...inputs('win32'),
      execPath: 'C:\\Program Files\\c3\\c3.exe',
      home: 'C:\\Users\\alice',
      start: { workspacePath: 'C:\\proj', port: 4321, dev: false },
    })
    expect(plan.platform).toBe('win32')
    expect(plan.unitPath).toBeNull()
    expect(plan.unitContent).toBeNull()
    expect(plan.registerCommands).toHaveLength(1)
    const [cmd] = plan.registerCommands
    expect(cmd.cmd).toBe('schtasks')
    expect(cmd.args).toContain('/Create')
    expect(cmd.args).toContain('ONLOGON')
    expect(cmd.args).toContain(SCHTASKS_TASK_NAME)
    // executable with spaces is quoted inside the /TR string; never --daemon.
    const trIdx = cmd.args.indexOf('/TR')
    const tr = cmd.args[trIdx + 1]
    expect(tr).toContain('"C:\\Program Files\\c3\\c3.exe"')
    expect(tr).toContain('start')
    expect(tr).not.toContain('--daemon')
  })

  it('bakes the absolute --settings path so the service reads the same ~/.c3', () => {
    const plan = planServiceInstall({
      ...inputs('linux'),
      start: { workspacePath: '/ws', port: 3000, dev: false, settingsPath: '/abs/settings.json' },
    })
    expect(plan.unitContent).toContain('--settings /abs/settings.json')
  })

  it('prepends the script path for a dev/interpreter install', () => {
    const plan = planServiceInstall({
      ...inputs('linux'),
      execPath: '/usr/bin/node',
      scriptPath: '/repo/cli.js',
    })
    expect(plan.unitContent).toContain('ExecStart=/usr/bin/node /repo/cli.js start')
  })

  it('throws UnsupportedPlatformError for an unknown platform (failure path)', () => {
    expect(() => planServiceInstall(inputs('freebsd' as NodeJS.Platform))).toThrowError(
      UnsupportedPlatformError,
    )
  })
})

describe('executeServiceInstall', () => {
  it('writes the unit and runs every register command in order on success', () => {
    const plan = planServiceInstall(inputs('linux'))
    const writeFile = vi.fn()
    const run = vi.fn().mockReturnValue({ status: 0, stderr: '' })
    const result = executeServiceInstall(plan, { writeFile, run })

    expect(writeFile).toHaveBeenCalledWith(plan.unitPath, plan.unitContent)
    expect(run).toHaveBeenCalledTimes(2)
    expect(run).toHaveBeenNthCalledWith(1, 'systemctl', ['--user', 'daemon-reload'])
    expect(result.kind).toBe('installed')
  })

  it('does not write a file on Windows but still runs schtasks', () => {
    const plan = planServiceInstall({ ...inputs('win32'), home: 'C:\\Users\\a' })
    const writeFile = vi.fn()
    const run = vi.fn().mockReturnValue({ status: 0, stderr: '' })
    executeServiceInstall(plan, { writeFile, run })
    expect(writeFile).not.toHaveBeenCalled()
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('surfaces the failing command + stderr and aborts (does not swallow)', () => {
    const plan = planServiceInstall(inputs('linux'))
    const run = vi.fn().mockReturnValueOnce({ status: 0, stderr: '' }).mockReturnValueOnce({
      status: 1,
      stderr: 'Failed to connect to bus: No such file or directory',
    })
    const result = executeServiceInstall(plan, { writeFile: vi.fn(), run })

    expect(result.kind).toBe('register-failed')
    if (result.kind === 'register-failed') {
      expect(result.status).toBe(1)
      expect(result.stderr).toContain('Failed to connect to bus')
      expect(result.command.cmd).toBe('systemctl')
      expect(result.command.args).toContain('enable')
    }
    // Second command failed ⇒ no third call attempted (only two exist; both ran).
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('aborts on the first non-zero command without running later ones', () => {
    const plan = planServiceInstall(inputs('linux'))
    const run = vi.fn().mockReturnValue({ status: 127, stderr: 'systemctl: command not found' })
    const result = executeServiceInstall(plan, { writeFile: vi.fn(), run })
    expect(run).toHaveBeenCalledTimes(1) // first failed ⇒ stop
    expect(result.kind).toBe('register-failed')
  })
})
