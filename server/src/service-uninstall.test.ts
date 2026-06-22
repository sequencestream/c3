import { describe, expect, it, vi } from 'vitest'
import {
  executeServiceUninstall,
  planServiceUninstall,
  type ServiceUninstallInputs,
} from './service-uninstall.js'
import { UnsupportedPlatformError } from './service-install.js'

function inputs(platform: NodeJS.Platform): ServiceUninstallInputs {
  return { platform, home: '/home/alice' }
}

describe('planServiceUninstall', () => {
  it.each(['linux', 'darwin', 'win32'] as const)(
    'matches the %s uninstall plan snapshot',
    (platform) => {
      expect(planServiceUninstall(inputs(platform))).toMatchSnapshot()
    },
  )

  it('rejects unsupported platforms', () => {
    expect(() => planServiceUninstall(inputs('freebsd' as NodeJS.Platform))).toThrow(
      UnsupportedPlatformError,
    )
  })
})

describe('executeServiceUninstall', () => {
  it('does nothing when the Linux unit is absent, including on repeated calls', () => {
    const plan = planServiceUninstall(inputs('linux'))
    const run = vi.fn()
    const removeFile = vi.fn()
    const deps = { fileExists: vi.fn().mockReturnValue(false), run, removeFile }

    expect(executeServiceUninstall(plan, deps).kind).toBe('not-installed')
    expect(executeServiceUninstall(plan, deps).kind).toBe('not-installed')
    expect(run).not.toHaveBeenCalled()
    expect(removeFile).not.toHaveBeenCalled()
  })

  it('removes an installed macOS service after unloading it', () => {
    const plan = planServiceUninstall(inputs('darwin'))
    const run = vi.fn().mockReturnValue({ status: 0, stderr: '' })
    const removeFile = vi.fn()

    const result = executeServiceUninstall(plan, { fileExists: () => true, run, removeFile })

    expect(result.kind).toBe('uninstalled')
    expect(run).toHaveBeenCalledWith('launchctl', ['unload', plan.unitPath])
    expect(removeFile).toHaveBeenCalledWith(plan.unitPath)
  })

  it('treats a missing Windows task as an idempotent success', () => {
    const plan = planServiceUninstall(inputs('win32'))
    const run = vi.fn().mockReturnValue({
      status: 1,
      stderr: 'ERROR: The system cannot find the file specified.',
    })

    const result = executeServiceUninstall(plan, { run })

    expect(result.kind).toBe('not-installed')
    expect(run).toHaveBeenCalledTimes(1)
    expect(run).toHaveBeenCalledWith('schtasks', ['/Query', '/TN', 'c3'])
  })

  it('runs the Windows query then deletion for an installed task', () => {
    const plan = planServiceUninstall(inputs('win32'))
    const run = vi.fn().mockReturnValue({ status: 0, stderr: '' })

    const result = executeServiceUninstall(plan, { run })

    expect(result.kind).toBe('uninstalled')
    expect(run).toHaveBeenNthCalledWith(1, 'schtasks', ['/Query', '/TN', 'c3'])
    expect(run).toHaveBeenNthCalledWith(2, 'schtasks', ['/Delete', '/TN', 'c3', '/F'])
  })

  it('surfaces a failing unregister command and preserves stderr', () => {
    const plan = planServiceUninstall(inputs('linux'))
    const result = executeServiceUninstall(plan, {
      fileExists: () => true,
      run: () => ({ status: 1, stderr: 'Failed to connect to bus' }),
      removeFile: vi.fn(),
    })

    expect(result).toMatchObject({
      kind: 'unregister-failed',
      status: 1,
      stderr: 'Failed to connect to bus',
      command: { cmd: 'systemctl', args: ['--user', 'disable', '--now', 'c3.service'] },
    })
  })

  it('surfaces a missing systemctl command with an actionable failure result', () => {
    const plan = planServiceUninstall(inputs('linux'))
    const result = executeServiceUninstall(plan, {
      fileExists: () => true,
      run: () => ({ status: 1, stderr: 'spawnSync systemctl ENOENT', errorCode: 'ENOENT' }),
    })

    expect(result).toMatchObject({
      kind: 'unregister-failed',
      errorCode: 'ENOENT',
      stderr: 'spawnSync systemctl ENOENT',
      command: { cmd: 'systemctl' },
    })
  })
})
