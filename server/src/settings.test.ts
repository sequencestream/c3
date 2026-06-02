import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SYSTEM_AGENT_ID } from '@ccc/shared/protocol'
import type { SystemSettings } from '@ccc/shared/protocol'
import {
  getDevSkill,
  getMaxRoundsPerStage,
  saveSettings,
  resetSettingsCacheForTests,
  DEFAULT_ROUNDS_PER_STAGE,
  MIN_ROUNDS_PER_STAGE,
} from './settings.js'

// Redirect `~/.c3` to a throwaway dir (os.homedir() honours $HOME on POSIX) so
// these tests never touch the developer's real settings.json.
let dir: string
let prevHome: string | undefined

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'c3-settings-'))
  prevHome = process.env.HOME
  process.env.HOME = dir
  resetSettingsCacheForTests()
})

afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME
  else process.env.HOME = prevHome
  resetSettingsCacheForTests()
  rmSync(dir, { recursive: true, force: true })
})

/** Persist just a `devSkill` value (with the required baseline fields). */
function saveWithDevSkill(devSkill: string | undefined): void {
  saveSettings({ agents: [], defaultAgentId: SYSTEM_AGENT_ID, devSkill } as SystemSettings)
}

describe('getDevSkill normalization', () => {
  it('defaults to empty (no prefix) when unset', () => {
    saveWithDevSkill(undefined)
    expect(getDevSkill()).toBe('')
  })

  it('defaults to empty for a whitespace-only value', () => {
    saveWithDevSkill('   ')
    expect(getDevSkill()).toBe('')
  })

  it('trims surrounding whitespace', () => {
    saveWithDevSkill('  /foo  ')
    expect(getDevSkill()).toBe('/foo')
  })

  it('prepends a missing leading slash', () => {
    saveWithDevSkill('my-skill')
    expect(getDevSkill()).toBe('/my-skill')
  })

  it('keeps an already-slashed command unchanged', () => {
    saveWithDevSkill('/foo')
    expect(getDevSkill()).toBe('/foo')
  })
})

/** Persist just a `maxRoundsPerStage` value (with the required baseline fields). */
function saveWithMaxRounds(value: unknown): void {
  saveSettings({
    agents: [],
    defaultAgentId: SYSTEM_AGENT_ID,
    maxRoundsPerStage: value,
  } as unknown as SystemSettings)
}

describe('getMaxRoundsPerStage normalization', () => {
  it('falls back to the default when unset', () => {
    saveWithMaxRounds(undefined)
    expect(getMaxRoundsPerStage()).toBe(DEFAULT_ROUNDS_PER_STAGE)
  })

  it('clamps a positive value below the floor up to the minimum', () => {
    saveWithMaxRounds(5)
    expect(getMaxRoundsPerStage()).toBe(MIN_ROUNDS_PER_STAGE)
  })

  it('clamps the floor exactly to the minimum', () => {
    saveWithMaxRounds(MIN_ROUNDS_PER_STAGE)
    expect(getMaxRoundsPerStage()).toBe(MIN_ROUNDS_PER_STAGE)
  })

  it('keeps a legal value at or above the floor', () => {
    saveWithMaxRounds(20)
    expect(getMaxRoundsPerStage()).toBe(20)
  })

  it('floors a fractional value', () => {
    saveWithMaxRounds(12.9)
    expect(getMaxRoundsPerStage()).toBe(12)
  })

  it('falls back to the default for a non-numeric value', () => {
    saveWithMaxRounds('nope')
    expect(getMaxRoundsPerStage()).toBe(DEFAULT_ROUNDS_PER_STAGE)
  })

  it('falls back to the default for zero/negative values', () => {
    saveWithMaxRounds(0)
    expect(getMaxRoundsPerStage()).toBe(DEFAULT_ROUNDS_PER_STAGE)
    saveWithMaxRounds(-3)
    expect(getMaxRoundsPerStage()).toBe(DEFAULT_ROUNDS_PER_STAGE)
  })
})
