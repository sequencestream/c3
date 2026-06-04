import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SYSTEM_AGENT_ID } from '@ccc/shared/protocol'
import type { SystemSettings } from '@ccc/shared/protocol'
import {
  consensusVoters,
  enabledAgents,
  getDevSkill,
  getMaxRoundsPerStage,
  getMaxSpeechChars,
  getUiLang,
  loadSettings,
  resolveSessionLaunch,
  saveSettings,
  normalizeDegradationChain,
  normalizeIcon,
  resetSettingsCacheForTests,
  DEFAULT_ROUNDS_PER_STAGE,
  DEFAULT_UI_LANG,
  MIN_ROUNDS_PER_STAGE,
  DEFAULT_SPEECH_CHARS,
  MIN_SPEECH_CHARS,
  AGENT_ICON_MAX_CHARS,
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

  it('drops disabled agents from the chain (AC-R10)', () => {
    const agents = AGENTS.map((a) => (a.id === 'a2' ? { ...a, enabled: false } : a))
    const result = normalizeDegradationChain(['a1', 'a2', 'a3'], agents)
    expect(result).toEqual(['a1', 'a3'])
  })
})

/** Persist a set of agents (plus the baseline fields) and re-read via loadSettings. */
function saveAgents(
  agents: import('@ccc/shared/protocol').AgentConfig[],
  defaultAgentId = SYSTEM_AGENT_ID,
): SystemSettings {
  return saveSettings({ agents, defaultAgentId } as SystemSettings)
}

describe('enabled flag (AC-R10)', () => {
  it('persists enabled as an explicit boolean; absent ⇒ enabled (back-compat)', () => {
    // No `enabled` field on the incoming agent → treated as enabled and persisted as true.
    const saved = saveAgents([
      { id: 'a1', name: 'One', baseUrl: '', apiKey: '', model: '' } as never,
    ])
    const a1 = saved.agents.find((a) => a.id === 'a1')
    expect(a1?.enabled).toBe(true)
    // The re-injected system agent is enabled by default too.
    expect(saved.agents.find((a) => a.id === SYSTEM_AGENT_ID)?.enabled).toBe(true)
  })

  it('keeps an explicit false (disabled) through normalize', () => {
    const saved = saveAgents([
      { id: 'a1', name: 'One', baseUrl: '', apiKey: '', model: '', enabled: false },
    ])
    expect(saved.agents.find((a) => a.id === 'a1')?.enabled).toBe(false)
  })

  it('honours a disabled system agent (overrides still ignored — AC-R1)', () => {
    const saved = saveAgents([
      // Try to both disable and override the system agent.
      {
        id: SYSTEM_AGENT_ID,
        name: 'hacked',
        baseUrl: 'https://evil',
        apiKey: 'k',
        model: 'm',
        enabled: false,
      },
    ])
    const sys = saved.agents.find((a) => a.id === SYSTEM_AGENT_ID)!
    expect(sys.enabled).toBe(false)
    expect(sys.baseUrl).toBe('')
    expect(sys.apiKey).toBe('')
    expect(sys.model).toBe('')
  })

  it('enabledAgents() returns only enabled agents', () => {
    saveAgents([
      { id: 'a1', name: 'One', baseUrl: '', apiKey: '', model: '', enabled: true },
      { id: 'a2', name: 'Two', baseUrl: '', apiKey: '', model: '', enabled: false },
    ])
    const ids = enabledAgents().map((a) => a.id)
    expect(ids).toContain(SYSTEM_AGENT_ID)
    expect(ids).toContain('a1')
    expect(ids).not.toContain('a2')
  })

  it('enabledAgents() excludes a disabled system agent', () => {
    saveAgents([
      { id: SYSTEM_AGENT_ID, name: 'System', baseUrl: '', apiKey: '', model: '', enabled: false },
    ])
    expect(enabledAgents().some((a) => a.id === SYSTEM_AGENT_ID)).toBe(false)
  })

  it('consensusVoters drops disabled agents and the session self', () => {
    saveAgents([
      { id: 'a1', name: 'One', baseUrl: '', apiKey: '', model: '', enabled: true },
      { id: 'a2', name: 'Two', baseUrl: '', apiKey: '', model: '', enabled: false },
    ])
    const voters = consensusVoters('a1').map((a) => a.id)
    expect(voters).toContain(SYSTEM_AGENT_ID)
    expect(voters).not.toContain('a1') // self excluded
    expect(voters).not.toContain('a2') // disabled excluded
  })

  it('still launches a session bound to a disabled agent (no lock-out — AC-R10)', () => {
    const settings = saveAgents([
      { id: 'a1', name: 'One', baseUrl: 'https://one', apiKey: 'k', model: '', enabled: false },
    ])
    // Sanity: a1 is disabled yet present.
    expect(settings.agents.find((a) => a.id === 'a1')?.enabled).toBe(false)
    // No binding for this session → falls back to default (system). Always resolves.
    const launch = resolveSessionLaunch('some-session')
    expect(launch.agentId).toBe(SYSTEM_AGENT_ID)
    // loadSettings is consistent with the saved set.
    expect(loadSettings().agents.some((a) => a.id === 'a1')).toBe(true)
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

/** Persist just a `uiLang` value (with the required baseline fields). */
function saveWithUiLang(uiLang: unknown): void {
  saveSettings({ agents: [], defaultAgentId: SYSTEM_AGENT_ID, uiLang } as SystemSettings)
}

describe('getUiLang normalization', () => {
  it('defaults to en when unset', () => {
    saveWithUiLang(undefined)
    expect(getUiLang()).toBe(DEFAULT_UI_LANG)
    expect(getUiLang()).toBe('en')
  })

  it('keeps a known language code', () => {
    saveWithUiLang('zh')
    expect(getUiLang()).toBe('zh')
  })

  it('falls back to en for an unknown code', () => {
    saveWithUiLang('xx')
    expect(getUiLang()).toBe('en')
  })

  it('falls back to en for a non-string value', () => {
    saveWithUiLang(42)
    expect(getUiLang()).toBe('en')
  })

  it('is independent from voiceLang (decoupled)', () => {
    saveSettings({
      agents: [],
      defaultAgentId: SYSTEM_AGENT_ID,
      uiLang: 'zh',
      voiceLang: 'en-US',
    } as SystemSettings)
    expect(getUiLang()).toBe('zh')
    expect(loadSettings().voiceLang).toBe('en-US')
  })
})

describe('normalizeIcon (AC-R11)', () => {
  it('returns "" for missing / non-string input', () => {
    expect(normalizeIcon(undefined)).toBe('')
    expect(normalizeIcon(null)).toBe('')
    expect(normalizeIcon(42)).toBe('')
    expect(normalizeIcon({})).toBe('')
  })

  it('trims surrounding whitespace', () => {
    expect(normalizeIcon('  🤖  ')).toBe('🤖')
  })

  it('returns "" for whitespace-only input', () => {
    expect(normalizeIcon('   ')).toBe('')
    expect(normalizeIcon('\t\n')).toBe('')
  })

  it('keeps a short emoji or text verbatim', () => {
    expect(normalizeIcon('🤖')).toBe('🤖')
    expect(normalizeIcon('fox')).toBe('fox')
  })

  it('truncates a string longer than AGENT_ICON_MAX_CHARS', () => {
    const long = 'a'.repeat(AGENT_ICON_MAX_CHARS + 5)
    const out = normalizeIcon(long)
    expect(out).toBe('a'.repeat(AGENT_ICON_MAX_CHARS))
    expect(out.length).toBe(AGENT_ICON_MAX_CHARS)
  })
})

describe('AgentConfig.icon persistence (AC-R11)', () => {
  it('persists a valid icon on a non-system agent', () => {
    const saved = saveAgents([
      { id: 'a1', name: 'One', baseUrl: '', apiKey: '', model: '', icon: '🤖' } as never,
    ])
    expect(saved.agents.find((a) => a.id === 'a1')?.icon).toBe('🤖')
  })

  it('defaults icon to "" when the incoming agent has no `icon` field (back-compat)', () => {
    // No `icon` field on the incoming agent → treated as empty.
    const saved = saveAgents([
      { id: 'a1', name: 'One', baseUrl: '', apiKey: '', model: '' } as never,
    ])
    expect(saved.agents.find((a) => a.id === 'a1')?.icon).toBe('')
  })

  it('loads an old config (no icon field) without error and yields ""', () => {
    // Simulate a legacy on-disk shape: no icon at all.
    saveSettings({
      agents: [{ id: 'a1', name: 'One', baseUrl: '', apiKey: '', model: '' }],
      defaultAgentId: 'a1',
    } as SystemSettings)
    const reloaded = loadSettings()
    expect(reloaded.agents.find((a) => a.id === 'a1')?.icon).toBe('')
    // System agent also gets the default empty icon.
    expect(reloaded.agents.find((a) => a.id === SYSTEM_AGENT_ID)?.icon).toBe('')
  })

  it('honours an icon set on the system agent (overrides still ignored — AC-R1)', () => {
    const saved = saveAgents([
      // Try to both set an icon and override the system agent's Claude config.
      {
        id: SYSTEM_AGENT_ID,
        name: 'hacked',
        baseUrl: 'https://evil',
        apiKey: 'k',
        model: 'm',
        icon: '🛡️',
      },
    ])
    const sys = saved.agents.find((a) => a.id === SYSTEM_AGENT_ID)!
    expect(sys.icon).toBe('🛡️')
    expect(sys.baseUrl).toBe('')
    expect(sys.apiKey).toBe('')
    expect(sys.model).toBe('')
  })

  it('truncates an over-long icon on save', () => {
    const tooLong = '🦊'.repeat(20) // well over AGENT_ICON_MAX_CHARS
    const saved = saveAgents([
      { id: 'a1', name: 'One', baseUrl: '', apiKey: '', model: '', icon: tooLong } as never,
    ])
    const out = saved.agents.find((a) => a.id === 'a1')?.icon ?? ''
    expect(out.length).toBe(AGENT_ICON_MAX_CHARS)
  })

  it('persists a system-agent icon across load (system agent can have one too)', () => {
    saveSettings({
      agents: [
        { id: SYSTEM_AGENT_ID, name: 'System', baseUrl: '', apiKey: '', model: '', icon: '⚙️' },
      ],
      defaultAgentId: SYSTEM_AGENT_ID,
    } as SystemSettings)
    const sys = loadSettings().agents.find((a) => a.id === SYSTEM_AGENT_ID)!
    expect(sys.icon).toBe('⚙️')
  })
})
