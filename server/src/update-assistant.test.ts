import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildAssistantArgs,
  runUpdateAssistant,
  UPDATE_ASSISTANT_COMMAND,
  type AssistantDeps,
} from './update-assistant.js'
import { readApplyFailure, stagingDir, writeStagedRecord } from './features/updates/staging.js'
import { defaultUpgradeIo, type UpgradeIo } from './upgrade.js'

let home: string
let dir: string
let target: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'c3-assistant-'))
  dir = stagingDir(home)
  mkdirSync(dir, { recursive: true })
  target = join(home, 'bin-c3')
  writeFileSync(target, 'OLD')
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

function stage(): void {
  const binPath = join(dir, 'c3')
  writeFileSync(binPath, 'NEW-BINARY')
  writeStagedRecord(dir, {
    version: '2.0.0',
    tag: 'v2.0.0',
    binPath,
    execPath: target,
    fromVersion: '1.0.0',
  })
}

function io(over: Partial<UpgradeIo> = {}): UpgradeIo {
  return { ...defaultUpgradeIo(), selfCheckVersion: () => 'ok', ...over }
}

function deps(over: Partial<AssistantDeps> = {}): AssistantDeps {
  return {
    platform: 'darwin',
    io: io(),
    isAlive: () => false,
    sleep: async () => {},
    run: vi.fn(() => ({ status: 0, stderr: '' })),
    readOptions: () => ({ port: 3000, dev: false }),
    startDaemonFn: () => ({
      kind: 'started',
      pid: 99,
      logPath: 'log',
      pidPath: 'pid',
    }),
    setDb: vi.fn(),
    ...over,
  }
}

describe('buildAssistantArgs', () => {
  it('emits the hidden subcommand with every field the helper needs', () => {
    expect(buildAssistantArgs({ waitPid: 7, updateDir: '/s', form: 'daemon' })).toEqual([
      UPDATE_ASSISTANT_COMMAND,
      '--wait-pid',
      '7',
      '--update-dir',
      '/s',
      '--form',
      'daemon',
    ])
  })
})

describe('runUpdateAssistant', () => {
  it('waits for the old process, swaps the binary, relaunches the daemon and cleans up', async () => {
    stage()
    const startDaemonFn = vi.fn(() => ({
      kind: 'started' as const,
      pid: 99,
      logPath: 'log',
      pidPath: 'pid',
    }))
    const setDb = vi.fn()
    const code = await runUpdateAssistant(
      { waitPid: 1234, updateDir: dir, form: 'daemon' },
      deps({
        startDaemonFn,
        setDb,
        readOptions: () => ({ port: 3000, dev: false, dbPath: join(home, 'c3.db') }),
      }),
    )
    expect(code).toBe(0)
    expect(readFileSync(target, 'utf-8')).toBe('NEW-BINARY')
    // The home must be resolved before the successor records its pid.
    expect(setDb).toHaveBeenCalledWith(join(home, 'c3.db'))
    expect(startDaemonFn).toHaveBeenCalled()
    expect(existsSync(dir)).toBe(false)
  })

  it('does not swap while the old process is still alive', async () => {
    stage()
    const code = await runUpdateAssistant(
      { waitPid: 1234, updateDir: dir, form: 'daemon' },
      deps({ isAlive: () => true }),
    )
    expect(code).toBe(1)
    expect(readFileSync(target, 'utf-8')).toBe('OLD')
    expect(readApplyFailure(dir)?.code).toBe('relaunch')
  })

  it('reports a replace failure and leaves the old binary runnable', async () => {
    stage()
    const code = await runUpdateAssistant(
      { waitPid: 1234, updateDir: dir, form: 'daemon' },
      deps({
        io: io({
          selfCheckVersion: () => {
            throw new Error('downloaded binary is not runnable')
          },
        }),
      }),
    )
    expect(code).toBe(1)
    expect(readFileSync(target, 'utf-8')).toBe('OLD')
    expect(readApplyFailure(dir)?.code).toBe('replace')
  })

  it('reports a relaunch failure when the daemon sidecar is unreadable', async () => {
    stage()
    const code = await runUpdateAssistant(
      { waitPid: 1234, updateDir: dir, form: 'daemon' },
      deps({ readOptions: () => null }),
    )
    expect(code).toBe(1)
    // The swap already happened — the failure is only about starting it back up.
    expect(readFileSync(target, 'utf-8')).toBe('NEW-BINARY')
    expect(readApplyFailure(dir)?.code).toBe('relaunch')
  })

  it('runs the scheduled task for the windows service form', async () => {
    stage()
    const run = vi.fn(() => ({ status: 0, stderr: '' }))
    const code = await runUpdateAssistant(
      { waitPid: 1234, updateDir: dir, form: 'schtasks' },
      deps({ run }),
    )
    expect(code).toBe(0)
    expect(run).toHaveBeenCalledWith('schtasks', ['/Run', '/TN', 'c3'])
  })

  it('is a silent no-op when nothing is staged (already applied / cleaned)', async () => {
    const code = await runUpdateAssistant(
      { waitPid: 1234, updateDir: dir, form: 'daemon' },
      deps({
        io: io({
          rename: () => {
            throw new Error('must not touch anything')
          },
        }),
      }),
    )
    expect(code).toBe(0)
    expect(readApplyFailure(dir)).toBeNull()
  })
})
