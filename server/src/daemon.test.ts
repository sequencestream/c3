import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChildProcess } from 'node:child_process'
import {
  buildStartArgs,
  isProcessAlive,
  readActivePid,
  readDaemonOptions,
  resolveSelfCommand,
  startDaemon,
  writeDaemonOptions,
  PID_FILE_NAME,
  DAEMON_LOG_NAME,
  DAEMON_OPTIONS_NAME,
} from './daemon.js'

describe('buildStartArgs', () => {
  it('emits a plain start and never re-adds --daemon (no self-fork)', () => {
    const args = buildStartArgs({ port: 3000, dev: false })
    expect(args[0]).toBe('start')
    expect(args).not.toContain('--daemon')
    expect(args).not.toContain('--workspace')
    expect(args).toEqual(['start', '--port', '3000'])
  })

  it('threads settings first, plus dev when set', () => {
    const args = buildStartArgs({
      port: 8080,
      dev: true,
      settingsPath: '/abs/settings.json',
    })
    expect(args).toEqual([
      'start',
      '--settings',
      '/abs/settings.json',
      '--port',
      '8080',
      '--dev',
    ])
  })
})

describe('resolveSelfCommand', () => {
  const childArgs = ['start', '--port', '3000']

  it('passes args straight through for the compiled single binary', () => {
    const r = resolveSelfCommand('/usr/local/bin/c3-macos-arm64', '/whatever', childArgs)
    expect(r).toEqual({ command: '/usr/local/bin/c3-macos-arm64', args: childArgs })
  })

  it('prepends the script path under an interpreter (dev/tsx)', () => {
    const r = resolveSelfCommand('/usr/bin/node', '/repo/server/dist/cli.js', childArgs)
    expect(r).toEqual({
      command: '/usr/bin/node',
      args: ['/repo/server/dist/cli.js', ...childArgs],
    })
  })

  it('treats node.exe as an interpreter', () => {
    const r = resolveSelfCommand('C:\\Program Files\\nodejs\\node.exe', 'C:\\cli.js', childArgs)
    expect(r.args[0]).toBe('C:\\cli.js')
  })
})

describe('isProcessAlive', () => {
  it('reports the current process alive', () => {
    expect(isProcessAlive(process.pid)).toBe(true)
  })

  it('rejects invalid pids', () => {
    expect(isProcessAlive(0)).toBe(false)
    expect(isProcessAlive(-1)).toBe(false)
  })

  it('reports a (almost certainly) dead pid as not alive', () => {
    // 2^31-1 is an extremely unlikely live pid on a test host.
    expect(isProcessAlive(2147483646)).toBe(false)
  })
})

describe('readActivePid', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'c3-pid-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('returns null when the pid file is absent', () => {
    expect(readActivePid(join(dir, 'c3.pid'), () => true)).toBeNull()
  })

  it('returns null for a stale (dead) pid so the caller overwrites', () => {
    const p = join(dir, 'c3.pid')
    writeFileSync(p, '4242\n')
    expect(readActivePid(p, () => false)).toBeNull()
  })

  it('returns the pid when the recorded process is alive', () => {
    const p = join(dir, 'c3.pid')
    writeFileSync(p, '4242\n')
    expect(readActivePid(p, () => true)).toBe(4242)
  })

  it('returns null for a garbled pid file', () => {
    const p = join(dir, 'c3.pid')
    writeFileSync(p, 'not-a-pid')
    expect(readActivePid(p, () => true)).toBeNull()
  })
})

describe('daemon options sidecar', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'c3-daemon-opts-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('round-trips the resolved start options', () => {
    const p = join(dir, DAEMON_OPTIONS_NAME)
    const opts = { port: 8080, dev: true, settingsPath: '/abs/settings.json' }
    writeDaemonOptions(p, opts)
    expect(readDaemonOptions(p)).toEqual(opts)
  })

  it('round-trips minimal options (no settings)', () => {
    const p = join(dir, DAEMON_OPTIONS_NAME)
    const opts = { port: 3000, dev: false }
    writeDaemonOptions(p, opts)
    expect(readDaemonOptions(p)).toEqual(opts)
  })

  it('gracefully ignores legacy workspacePath field', () => {
    const p = join(dir, DAEMON_OPTIONS_NAME)
    const old = { workspacePath: '/old/ws', port: 3000, dev: true }
    writeFileSync(p, JSON.stringify(old))
    const parsed = readDaemonOptions(p)
    expect(parsed).not.toBeNull()
    expect(parsed).toEqual({ port: 3000, dev: true })
    expect((parsed as Record<string, unknown>).workspacePath).toBeUndefined()
  })

  it('returns null for a missing file', () => {
    expect(readDaemonOptions(join(dir, 'nope.json'))).toBeNull()
  })

  it('returns null for corrupt JSON', () => {
    const p = join(dir, DAEMON_OPTIONS_NAME)
    writeFileSync(p, '{not json')
    expect(readDaemonOptions(p)).toBeNull()
  })

  it('returns null when required fields are missing/wrong type', () => {
    const p = join(dir, DAEMON_OPTIONS_NAME)
    writeFileSync(p, JSON.stringify({ port: 'oops', dev: false }))
    expect(readDaemonOptions(p)).toBeNull()
  })
})

describe('startDaemon', () => {
  let dir: string
  let prevC3Dir: string | undefined

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'c3-daemon-'))
    prevC3Dir = process.env.C3_DIR
    process.env.C3_DIR = dir
  })
  afterEach(() => {
    if (prevC3Dir === undefined) delete process.env.C3_DIR
    else process.env.C3_DIR = prevC3Dir
    rmSync(dir, { recursive: true, force: true })
  })

  function fakeChild(pid = 9999): ChildProcess {
    return { pid, unref: vi.fn() } as unknown as ChildProcess
  }

  it("respawns detached, stdio-redirected, unref'd, without --daemon/--workspace, and writes the pid file", () => {
    const child = fakeChild(12345)
    const spawn = vi.fn().mockReturnValue(child)
    const outcome = startDaemon(
      { port: 3000, dev: false },
      { spawn: spawn as never, isAlive: () => false },
    )

    expect(spawn).toHaveBeenCalledTimes(1)
    const [, args, opts] = spawn.mock.calls[0]
    expect(args).not.toContain('--daemon')
    expect(args).not.toContain('--workspace')
    // The `start …` child args are always a trailing slice (an interpreter run —
    // e.g. under vitest — prepends the script path; the compiled binary does not).
    expect(args.slice(-3)).toEqual(['start', '--port', '3000'])
    expect(opts.detached).toBe(true)
    // stdio redirects stdout+stderr to the same log fd, stdin ignored.
    expect(opts.stdio[0]).toBe('ignore')
    expect(typeof opts.stdio[1]).toBe('number')
    expect(opts.stdio[1]).toBe(opts.stdio[2])
    expect(child.unref).toHaveBeenCalledTimes(1)

    expect(outcome.kind).toBe('started')
    if (outcome.kind === 'started') {
      expect(outcome.pid).toBe(12345)
      expect(outcome.logPath).toBe(join(dir, DAEMON_LOG_NAME))
      expect(outcome.pidPath).toBe(join(dir, PID_FILE_NAME))
      expect(readFileSync(outcome.pidPath, 'utf-8').trim()).toBe('12345')
      // a restart-only options sidecar lands next to the pid file
      expect(readDaemonOptions(join(dir, DAEMON_OPTIONS_NAME))).toEqual({
        port: 3000,
        dev: false,
      })
    }
  })

  it('does not spawn a second instance when a live daemon is already recorded', () => {
    writeFileSync(join(dir, PID_FILE_NAME), '777\n')
    const spawn = vi.fn().mockReturnValue(fakeChild())
    const outcome = startDaemon(
      { port: 3000, dev: false },
      { spawn: spawn as never, isAlive: () => true },
    )
    expect(spawn).not.toHaveBeenCalled()
    expect(outcome.kind).toBe('already-running')
    if (outcome.kind === 'already-running') expect(outcome.pid).toBe(777)
  })

  it('overwrites a stale pid file and starts fresh', () => {
    writeFileSync(join(dir, PID_FILE_NAME), '777\n')
    const spawn = vi.fn().mockReturnValue(fakeChild(888))
    const outcome = startDaemon(
      { port: 3000, dev: false },
      { spawn: spawn as never, isAlive: () => false },
    )
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(outcome.kind).toBe('started')
    expect(readFileSync(join(dir, PID_FILE_NAME), 'utf-8').trim()).toBe('888')
  })
})
