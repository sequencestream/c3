import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SYSTEM_AGENT_ID } from '@ccc/shared/protocol'
import type { SystemSettings } from '@ccc/shared/protocol'
import {
  getDevSkill,
  getMaxRoundsPerStage,
  getMaxSpeechChars,
  saveSettings,
  normalizeDegradationChain,
  resetSettingsCacheForTests,
  DEFAULT_ROUNDS_PER_STAGE,
  MIN_ROUNDS_PER_STAGE,
  DEFAULT_SPEECH_CHARS,
  MIN_SPEECH_CHARS,
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

const AGENTS: import('@ccc/shared/protocol').AgentConfig[] = [
  { id: 'sys', name: 'System', baseUrl: '', apiKey: '', model: '' },
  { id: 'a1', name: 'Agent One', baseUrl: 'https://one.example.com', apiKey: 'key1', model: '' },
  { id: 'a2', name: 'Agent Two', baseUrl: 'https://two.example.com', apiKey: 'key2', model: '' },
  { id: 'a3', name: 'Agent Three', baseUrl: '', apiKey: '', model: 'claude-opus-4' },
]

describe('normalizeDegradationChain', () => {
  it('returns undefined for undefined input', () => {
    expect(normalizeDegradationChain(undefined, AGENTS)).toBeUndefined()
  })

  it('returns undefined for empty array', () => {
    expect(normalizeDegradationChain([], AGENTS)).toBeUndefined()
  })

  it('returns undefined when no known agent ids are given', () => {
    expect(normalizeDegradationChain(['unknown-id', 'also-unknown'], AGENTS)).toBeUndefined()
  })

  it('filters out unknown ids and keeps known ones in order', () => {
    const result = normalizeDegradationChain(['unknown', 'a2', 'also-unknown', 'a1'], AGENTS)
    expect(result).toEqual(['a2', 'a1'])
  })

  it('strips duplicate ids (keeps first occurrence)', () => {
    const result = normalizeDegradationChain(['a1', 'a2', 'a1', 'a3', 'a2'], AGENTS)
    expect(result).toEqual(['a1', 'a2', 'a3'])
  })

  it('ignores non-string entries', () => {
    const result = normalizeDegradationChain(
      ['a1', null, 123, undefined, 'a2'] as unknown as string[],
      AGENTS,
    )
    expect(result).toEqual(['a1', 'a2'])
  })

  it('accepts the system agent id as a valid chain entry', () => {
    const result = normalizeDegradationChain(['sys', 'a1'], AGENTS)
    expect(result).toEqual(['sys', 'a1'])
  })
})

/** Persist just a `maxSpeechChars` value (with the required baseline fields). */
function saveWithMaxSpeechChars(value: unknown): void {
  saveSettings({
    agents: [],
    defaultAgentId: SYSTEM_AGENT_ID,
    maxSpeechChars: value,
  } as unknown as SystemSettings)
}

describe('getMaxSpeechChars normalization', () => {
  it('falls back to the default when unset', () => {
    saveWithMaxSpeechChars(undefined)
    expect(getMaxSpeechChars()).toBe(DEFAULT_SPEECH_CHARS)
  })

  it('clamps a positive value below the floor up to the minimum', () => {
    saveWithMaxSpeechChars(100)
    expect(getMaxSpeechChars()).toBe(MIN_SPEECH_CHARS)
  })

  it('clamps the floor exactly to the minimum', () => {
    saveWithMaxSpeechChars(MIN_SPEECH_CHARS)
    expect(getMaxSpeechChars()).toBe(MIN_SPEECH_CHARS)
  })

  it('keeps a legal value at or above the floor', () => {
    saveWithMaxSpeechChars(500)
    expect(getMaxSpeechChars()).toBe(500)
  })

  it('floors a fractional value', () => {
    saveWithMaxSpeechChars(450.7)
    expect(getMaxSpeechChars()).toBe(450)
  })

  it('falls back to the default for a non-numeric value', () => {
    saveWithMaxSpeechChars('nope')
    expect(getMaxSpeechChars()).toBe(DEFAULT_SPEECH_CHARS)
  })

  it('falls back to the default for zero/negative values', () => {
    saveWithMaxSpeechChars(0)
    expect(getMaxSpeechChars()).toBe(DEFAULT_SPEECH_CHARS)
    saveWithMaxSpeechChars(-3)
    expect(getMaxSpeechChars()).toBe(DEFAULT_SPEECH_CHARS)
  })
})
