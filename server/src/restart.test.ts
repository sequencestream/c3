import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { detectRuntimeForms, runRestart } from './restart.js'
import { DAEMON_OPTIONS_NAME, PID_FILE_NAME, type DaemonStartOptions } from './daemon.js'

let c3Home: string
beforeEach(() => {
  c3Home = mkdtempSync(join(tmpdir(), 'c3-restart-'))
})
afterEach(() => rmSync(c3Home, { recursive: true, force: true }))

function writePid(pid: number): void {
  writeFileSync(join(c3Home, PID_FILE_NAME), `${pid}\n`)
}

const instantSleep = () => Promise.resolve()

// ── detectRuntimeForms ──────────────────────────────────────────────────────

describe('detectRuntimeForms', () => {
  it('detects only a service (linux unit file present, no daemon)', () => {
    const forms = detectRuntimeForms({
      platform: 'linux',
      osHome: '/home/u',
      c3Home,
      deps: { fileExists: () => true, isAlive: () => true },
    })
    expect(forms).toEqual({ service: true, daemonPid: null })
  })

  it('detects only a daemon (no unit file, live pid)', () => {
    writePid(1234)
    const forms = detectRuntimeForms({
      platform: 'linux',
      osHome: '/home/u',
      c3Home,
      deps: { fileExists: () => false, isAlive: () => true },
    })
    expect(forms).toEqual({ service: false, daemonPid: 1234 })
  })

  it('detects both', () => {
    writePid(1234)
    const forms = detectRuntimeForms({
      platform: 'darwin',
      osHome: '/Users/u',
      c3Home,
      deps: { fileExists: () => true, isAlive: () => true },
    })
    expect(forms).toEqual({ service: true, daemonPid: 1234 })
  })

  it('detects neither (stale pid + no unit)', () => {
    writePid(1234)
    const forms = detectRuntimeForms({
      platform: 'linux',
      osHome: '/home/u',
      c3Home,
      deps: { fileExists: () => false, isAlive: () => false },
    })
    expect(forms).toEqual({ service: false, daemonPid: null })
  })

  it('uses schtasks /Query for the win32 service probe', () => {
    const run = vi.fn(() => ({ status: 0, stderr: '' }))
    const forms = detectRuntimeForms({
      platform: 'win32',
      osHome: 'C:\\Users\\u',
      c3Home,
      deps: { run },
    })
    expect(run).toHaveBeenCalledWith('schtasks', ['/Query', '/TN', 'c3'])
    expect(forms.service).toBe(true)
  })

  it('treats a missing win32 task as no service', () => {
    const run = vi.fn(() => ({
      status: 1,
      stderr: 'ERROR: The system cannot find the file specified.',
    }))
    const forms = detectRuntimeForms({
      platform: 'win32',
      osHome: 'C:\\Users\\u',
      c3Home,
      deps: { run },
    })
    expect(forms.service).toBe(false)
  })
})

// ── runRestart: priority + service ──────────────────────────────────────────

describe('runRestart service', () => {
  it('restarts the linux systemd user service', async () => {
    const run = vi.fn(() => ({ status: 0, stderr: '' }))
    const code = await runRestart({
      platform: 'linux',
      osHome: '/home/u',
      c3Home,
      fileExists: () => true,
      run,
      log: vi.fn(),
      errlog: vi.fn(),
    })
    expect(code).toBe(0)
    expect(run).toHaveBeenCalledWith('systemctl', ['--user', 'restart', 'c3.service'])
  })

  it('restarts the darwin LaunchAgent with kickstart and the current uid', async () => {
    const run = vi.fn(() => ({ status: 0, stderr: '' }))
    const code = await runRestart({
      platform: 'darwin',
      osHome: '/Users/u',
      c3Home,
      fileExists: () => true,
      run,
      getuid: () => 501,
      log: vi.fn(),
      errlog: vi.fn(),
    })
    expect(code).toBe(0)
    expect(run).toHaveBeenCalledWith('launchctl', ['kickstart', '-k', 'gui/501/center.c3.server'])
  })

  it('restarts the win32 task: tolerant /End then /Run', async () => {
    const run = vi.fn((_cmd: string, args: string[]) =>
      args[0] === '/End'
        ? { status: 1, stderr: 'ERROR: The task is not running.' } // tolerated
        : { status: 0, stderr: '' },
    )
    const code = await runRestart({
      platform: 'win32',
      osHome: 'C:\\Users\\u',
      c3Home,
      run,
      log: vi.fn(),
      errlog: vi.fn(),
    })
    expect(code).toBe(0)
    expect(run).toHaveBeenCalledWith('schtasks', ['/End', '/TN', 'c3'])
    expect(run).toHaveBeenCalledWith('schtasks', ['/Run', '/TN', 'c3'])
  })

  it('surfaces a non-zero service command failure', async () => {
    const errlog = vi.fn()
    const run = vi.fn(() => ({
      status: 5,
      stderr: 'Failed to restart c3.service: Unit not found.',
    }))
    const code = await runRestart({
      platform: 'linux',
      osHome: '/home/u',
      c3Home,
      fileExists: () => true,
      run,
      log: vi.fn(),
      errlog,
    })
    expect(code).toBe(1)
    expect(errlog.mock.calls.flat().join('\n')).toContain('Unit not found')
  })

  it('restarts the service when BOTH a service and daemon exist (priority service)', async () => {
    writePid(1234)
    const run = vi.fn(() => ({ status: 0, stderr: '' }))
    const log = vi.fn()
    const code = await runRestart({
      platform: 'linux',
      osHome: '/home/u',
      c3Home,
      fileExists: () => true,
      run,
      isAlive: () => true,
      log,
      errlog: vi.fn(),
    })
    expect(code).toBe(0)
    expect(run).toHaveBeenCalledWith('systemctl', ['--user', 'restart', 'c3.service'])
    expect(log.mock.calls.flat().join('\n')).toContain('restarting the service')
  })
})

// ── runRestart: daemon ──────────────────────────────────────────────────────

describe('runRestart daemon', () => {
  const opts: DaemonStartOptions = { workspacePath: '/ws', port: 8080, dev: false }

  it('stops the recorded pid then relaunches from the persisted options', async () => {
    writePid(1234)
    let killed = false
    const kill = vi.fn(() => {
      killed = true
    })
    const startDaemonFn = vi.fn(() => ({
      kind: 'started' as const,
      pid: 5678,
      logPath: 'l',
      pidPath: 'p',
    }))
    const readOptions = vi.fn(() => opts)
    const code = await runRestart({
      platform: 'linux',
      osHome: '/home/u',
      c3Home,
      fileExists: () => false, // no service
      isAlive: () => !killed, // alive until SIGTERM
      kill,
      readOptions,
      startDaemonFn,
      sleep: instantSleep,
      log: vi.fn(),
      errlog: vi.fn(),
    })
    expect(code).toBe(0)
    expect(kill).toHaveBeenCalledWith(1234, 'SIGTERM')
    expect(readOptions).toHaveBeenCalledWith(join(c3Home, DAEMON_OPTIONS_NAME))
    // relaunched with the SAME options (non-default workspace/port preserved)
    expect(startDaemonFn).toHaveBeenCalledWith(opts)
  })

  it('errors and does NOT start a new instance when the daemon will not die', async () => {
    writePid(1234)
    const startDaemonFn = vi.fn()
    const errlog = vi.fn()
    const code = await runRestart({
      platform: 'linux',
      osHome: '/home/u',
      c3Home,
      fileExists: () => false,
      isAlive: () => true, // never dies, even after SIGKILL
      kill: vi.fn(),
      readOptions: () => opts,
      startDaemonFn,
      sleep: instantSleep,
      log: vi.fn(),
      errlog,
    })
    expect(code).toBe(1)
    expect(startDaemonFn).not.toHaveBeenCalled()
    expect(errlog.mock.calls.flat().join('\n')).toContain('SIGKILL')
  })

  it('errors with guidance when the options sidecar is missing/corrupt', async () => {
    writePid(1234)
    let killed = false
    const startDaemonFn = vi.fn()
    const errlog = vi.fn()
    const code = await runRestart({
      platform: 'linux',
      osHome: '/home/u',
      c3Home,
      fileExists: () => false,
      isAlive: () => !killed,
      kill: vi.fn(() => {
        killed = true
      }),
      readOptions: () => null, // missing/corrupt
      startDaemonFn,
      sleep: instantSleep,
      log: vi.fn(),
      errlog,
    })
    expect(code).toBe(1)
    expect(startDaemonFn).not.toHaveBeenCalled()
    expect(errlog.mock.calls.flat().join('\n')).toContain('c3 start --daemon')
  })
})

// ── runRestart: nothing to restart ──────────────────────────────────────────

describe('runRestart nothing to restart', () => {
  it('returns 0 and explains when no service or daemon exists', async () => {
    const log = vi.fn()
    const code = await runRestart({
      platform: 'linux',
      osHome: '/home/u',
      c3Home, // empty: no pid file
      fileExists: () => false,
      log,
      errlog: vi.fn(),
    })
    expect(code).toBe(0)
    expect(log.mock.calls.flat().join('\n')).toContain('no OS service or background daemon')
  })
})
