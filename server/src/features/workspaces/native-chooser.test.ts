/**
 * Platform dispatch for the native directory chooser.
 *
 * Every case drives a fake asynchronous runner, so no real dialog is ever
 * opened. The two things worth breaking the build over: a dismissal is reported
 * as `cancelled` (never as the failure that reveals manual entry), and every
 * launch is asynchronous — a chooser that stays open must not stall the process.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import {
  normalizeChosenPath,
  startDirectoryChooser,
  type ChooserProcess,
  type ProcessOutcome,
  type ProcessRunner,
} from './native-chooser.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))

/** A runner that answers each launch from a scripted queue and records the calls. */
function scriptedRunner(outcomes: (Partial<ProcessOutcome> | 'pending')[]): {
  run: ProcessRunner
  calls: { command: string; args: string[] }[]
  aborts: string[]
} {
  const calls: { command: string; args: string[] }[] = []
  const aborts: string[] = []
  let next = 0
  const run: ProcessRunner = (command, args) => {
    calls.push({ command, args: [...args] })
    const scripted = outcomes[next++] ?? { code: 0, stdout: '', stderr: '' }
    const done: Promise<ProcessOutcome> =
      scripted === 'pending'
        ? new Promise<ProcessOutcome>(() => {})
        : Promise.resolve({ code: 0, stdout: '', stderr: '', ...scripted })
    const proc: ChooserProcess = { done, abort: () => aborts.push(command) }
    return proc
  }
  return { run, calls, aborts }
}

const LINUX_ENV = { DISPLAY: ':0' } as NodeJS.ProcessEnv

describe('chosen-path normalization', () => {
  it('strips the trailing separator macOS appends to a POSIX path', () => {
    expect(normalizeChosenPath('/Users/dev/proj/\n')).toBe('/Users/dev/proj')
  })

  it('keeps the filesystem root intact', () => {
    expect(normalizeChosenPath('/\n')).toBe('/')
  })

  it('rejects empty and relative output', () => {
    expect(normalizeChosenPath('  \n')).toBeNull()
    expect(normalizeChosenPath('relative/dir')).toBeNull()
  })
})

describe('macOS chooser', () => {
  it('returns the selected absolute path', async () => {
    const { run, calls } = scriptedRunner([{ code: 0, stdout: '/Users/dev/proj/\n' }])
    const { result } = startDirectoryChooser({ platform: 'darwin', run })
    expect(await result).toEqual({ kind: 'selected', path: '/Users/dev/proj' })
    expect(calls[0].command).toBe('osascript')
  })

  it('reads the AppleScript user-cancelled error as a cancellation', async () => {
    const { run } = scriptedRunner([{ code: 1, stderr: 'execution error: User canceled. (-128)' }])
    const { result } = startDirectoryChooser({ platform: 'darwin', run })
    expect(await result).toEqual({ kind: 'cancelled' })
  })

  it('fails when osascript is missing', async () => {
    const { run } = scriptedRunner([{ code: null, errorCode: 'ENOENT' }])
    const { result } = startDirectoryChooser({ platform: 'darwin', run })
    expect(await result).toMatchObject({ kind: 'failed' })
  })

  it('fails on a successful exit with unusable output', async () => {
    const { run } = scriptedRunner([{ code: 0, stdout: '   \n' }])
    const { result } = startDirectoryChooser({ platform: 'darwin', run })
    expect(await result).toMatchObject({ kind: 'failed' })
  })
})

describe('Windows chooser', () => {
  it('returns the selected absolute path from the STA PowerShell dialog', async () => {
    const { run, calls } = scriptedRunner([{ code: 0, stdout: 'C:\\work\\proj' }])
    const { result } = startDirectoryChooser({ platform: 'win32', run })
    expect(await result).toEqual({ kind: 'selected', path: 'C:\\work\\proj' })
    expect(calls[0].command).toBe('powershell.exe')
    expect(calls[0].args).toContain('-STA')
  })

  it('reads the script cancel exit code as a cancellation', async () => {
    const { run } = scriptedRunner([{ code: 2, stdout: '' }])
    const { result } = startDirectoryChooser({ platform: 'win32', run })
    expect(await result).toEqual({ kind: 'cancelled' })
  })

  it('fails when powershell cannot be launched', async () => {
    const { run } = scriptedRunner([{ code: null, errorCode: 'ENOENT' }])
    const { result } = startDirectoryChooser({ platform: 'win32', run })
    expect(await result).toMatchObject({ kind: 'failed' })
  })
})

describe('Linux chooser', () => {
  it('prefers zenity', async () => {
    const { run, calls } = scriptedRunner([{ code: 0, stdout: '/home/dev/proj\n' }])
    const { result } = startDirectoryChooser({ platform: 'linux', run, env: LINUX_ENV })
    expect(await result).toEqual({ kind: 'selected', path: '/home/dev/proj' })
    expect(calls.map((c) => c.command)).toEqual(['zenity'])
  })

  it('falls back to kdialog only when zenity is not installed', async () => {
    const { run, calls } = scriptedRunner([
      { code: null, errorCode: 'ENOENT' },
      { code: 0, stdout: '/home/dev/proj\n' },
    ])
    const { result } = startDirectoryChooser({ platform: 'linux', run, env: LINUX_ENV })
    expect(await result).toEqual({ kind: 'selected', path: '/home/dev/proj' })
    expect(calls.map((c) => c.command)).toEqual(['zenity', 'kdialog'])
  })

  it('treats a zenity dismissal as final, without trying kdialog', async () => {
    const { run, calls } = scriptedRunner([{ code: 1, stdout: '' }])
    const { result } = startDirectoryChooser({ platform: 'linux', run, env: LINUX_ENV })
    expect(await result).toEqual({ kind: 'cancelled' })
    expect(calls.map((c) => c.command)).toEqual(['zenity'])
  })

  it('fails when neither chooser is installed', async () => {
    const { run } = scriptedRunner([
      { code: null, errorCode: 'ENOENT' },
      { code: null, errorCode: 'ENOENT' },
    ])
    const { result } = startDirectoryChooser({ platform: 'linux', run, env: LINUX_ENV })
    expect(await result).toMatchObject({ kind: 'failed' })
  })

  it('fails without launching anything when no display server is reachable', async () => {
    const { run, calls } = scriptedRunner([])
    const { result } = startDirectoryChooser({ platform: 'linux', run, env: {} })
    expect(await result).toMatchObject({ kind: 'failed' })
    expect(calls).toEqual([])
  })

  it('accepts a wayland-only session', async () => {
    const { run } = scriptedRunner([{ code: 0, stdout: '/home/dev/proj' }])
    const { result } = startDirectoryChooser({
      platform: 'linux',
      run,
      env: { WAYLAND_DISPLAY: 'wayland-0' } as NodeJS.ProcessEnv,
    })
    expect(await result).toEqual({ kind: 'selected', path: '/home/dev/proj' })
  })
})

describe('unsupported platform', () => {
  it('fails without launching anything', async () => {
    const { run, calls } = scriptedRunner([])
    const { result } = startDirectoryChooser({ platform: 'aix', run })
    expect(await result).toMatchObject({ kind: 'failed' })
    expect(calls).toEqual([])
  })
})

describe('aborting a run', () => {
  it('kills the live child and settles as cancelled', async () => {
    const { run, aborts } = scriptedRunner(['pending'])
    const chooser = startDirectoryChooser({ platform: 'darwin', run })
    chooser.abort()
    expect(aborts).toEqual(['osascript'])
    expect(await chooser.result).toEqual({ kind: 'cancelled' })
  })

  it('does not launch the Linux fallback after an abort', async () => {
    const { run, calls } = scriptedRunner([{ code: null, errorCode: 'ENOENT' }, 'pending'])
    const chooser = startDirectoryChooser({ platform: 'linux', run, env: LINUX_ENV })
    chooser.abort()
    expect(await chooser.result).toEqual({ kind: 'cancelled' })
    expect(calls.map((c) => c.command)).toEqual(['zenity'])
  })
})

describe('event-loop safety', () => {
  it('uses no synchronous child-process API', () => {
    const source = readFileSync(path.join(HERE, 'native-chooser.ts'), 'utf8')
    expect(source).not.toMatch(/\b(execSync|execFileSync|spawnSync)\b/)
  })

  it('lets unrelated callbacks run while a chooser stays open', async () => {
    const { run } = scriptedRunner(['pending'])
    let settled: 'chooser' | 'unrelated' | null = null
    const chooser = startDirectoryChooser({ platform: 'darwin', run })
    void chooser.result.then(() => {
      settled ??= 'chooser'
    })
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    settled ??= 'unrelated'
    expect(settled).toBe('unrelated')
  })
})
