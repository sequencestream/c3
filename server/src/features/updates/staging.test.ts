import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  clearApplyFailure,
  clearStaging,
  readApplyFailure,
  readStagedRecord,
  resetStaging,
  stagingDir,
  writeApplyFailure,
  writeStagedRecord,
} from './staging.js'

let home: string
let dir: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'c3-staging-'))
  dir = stagingDir(home)
  mkdirSync(dir, { recursive: true })
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

function stage(version: string, binName = 'c3'): string {
  const binPath = join(dir, binName)
  writeFileSync(binPath, 'binary')
  writeStagedRecord(dir, {
    version,
    tag: `v${version}`,
    binPath,
    execPath: '/usr/local/bin/c3',
    fromVersion: '1.0.0',
  })
  return binPath
}

describe('stagingDir', () => {
  it('lives under the c3 home, so a relocated instance stages into its own home', () => {
    expect(stagingDir('/custom/home')).toBe(join('/custom/home', 'update-staging'))
  })
})

describe('staged record', () => {
  it('round-trips a record', () => {
    const binPath = stage('2.0.0')
    expect(readStagedRecord(dir)).toEqual({
      version: '2.0.0',
      tag: 'v2.0.0',
      binPath,
      execPath: '/usr/local/bin/c3',
      fromVersion: '1.0.0',
    })
  })

  it('reports nothing staged when the unpacked binary is gone', () => {
    const binPath = stage('2.0.0')
    rmSync(binPath)
    // The readiness claim must be backed by a file that still exists.
    expect(readStagedRecord(dir)).toBeNull()
  })

  it('reports nothing staged for a missing or corrupt record', () => {
    expect(readStagedRecord(dir)).toBeNull()
    writeFileSync(join(dir, 'staged.json'), '{ not json')
    expect(readStagedRecord(dir)).toBeNull()
  })

  it('rejects a record missing its required fields', () => {
    writeFileSync(join(dir, 'staged.json'), JSON.stringify({ tag: 'v2.0.0' }))
    expect(readStagedRecord(dir)).toBeNull()
  })

  it('leaves no temp file behind after a write', () => {
    stage('2.0.0')
    expect(existsSync(join(dir, 'staged.json.tmp'))).toBe(false)
  })
})

describe('resetStaging / clearStaging', () => {
  it('reset wipes a previous download and leaves an empty directory', () => {
    stage('2.0.0')
    resetStaging(dir)
    expect(existsSync(dir)).toBe(true)
    expect(readStagedRecord(dir)).toBeNull()
  })

  it('clear removes the directory entirely', () => {
    stage('2.0.0')
    clearStaging(dir)
    expect(existsSync(dir)).toBe(false)
  })
})

describe('apply failure handback', () => {
  it('round-trips and clears', () => {
    writeApplyFailure(dir, { code: 'replace', detail: 'not writable' })
    expect(readApplyFailure(dir)).toEqual({ code: 'replace', detail: 'not writable' })
    clearApplyFailure(dir)
    expect(readApplyFailure(dir)).toBeNull()
  })

  it('creates the directory when the helper reports into a cleaned staging area', () => {
    clearStaging(dir)
    writeApplyFailure(dir, { code: 'relaunch' })
    expect(readApplyFailure(dir)?.code).toBe('relaunch')
  })

  it('ignores a corrupt failure record', () => {
    writeFileSync(join(dir, 'apply-failure.json'), '{')
    expect(readApplyFailure(dir)).toBeNull()
  })
})
