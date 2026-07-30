import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SYSTEM_AGENT_ID } from '@ccc/shared/protocol'
import type { SystemSettings } from '@ccc/shared/protocol'
import {
  getAgentLang,
  loadPersonalizedFor,
  normalizePersonalized,
  resolvePersonalized,
  savePersonalizedFor,
} from './personalized.js'
import { loadSettings, resetSettingsCacheForTests, saveSettings } from './index.js'
import { readJsonFile, writeAtomic } from './store.js'

// Redirect `~/.c3` to a throwaway dir (os.homedir() honours $HOME on POSIX) so
// these tests never touch the developer's real settings.json.
let dir: string
let prevHome: string | undefined

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'c3-personalized-'))
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

function settingsPath(): string {
  return join(dir, '.c3', 'settings.json')
}

function diskRaw(): Record<string, unknown> {
  return readJsonFile<Record<string, unknown>>(settingsPath()) ?? {}
}

/** A minimal system-settings object, as the settings panel would submit it. */
function baseSystemSettings(extra: Partial<SystemSettings> = {}): SystemSettings {
  return {
    agents: [],
    defaultAgentId: SYSTEM_AGENT_ID,
    toolAgentId: '',
    intentAgentId: '',
    specAgentId: '',
    automationAgentId: '',
    ...extra,
  } as SystemSettings
}

describe('normalizePersonalized', () => {
  it('fills the default language for a missing, unknown, or non-string value', () => {
    expect(normalizePersonalized(undefined)).toEqual({ uiLang: 'en' })
    expect(normalizePersonalized({})).toEqual({ uiLang: 'en' })
    expect(normalizePersonalized({ uiLang: 'xx' })).toEqual({ uiLang: 'en' })
    expect(normalizePersonalized({ uiLang: 42 })).toEqual({ uiLang: 'en' })
    expect(normalizePersonalized('zh')).toEqual({ uiLang: 'en' })
  })

  it('keeps every known language', () => {
    for (const lang of ['en', 'zh', 'ja', 'ko', 'ru'] as const) {
      expect(normalizePersonalized({ uiLang: lang })).toEqual({ uiLang: lang })
    }
  })
})

describe('per-account storage', () => {
  it('keeps two subjects isolated', () => {
    savePersonalizedFor('alice', { uiLang: 'zh' })
    savePersonalizedFor('bob', { uiLang: 'ja' })
    expect(loadPersonalizedFor('alice')).toEqual({ uiLang: 'zh' })
    expect(loadPersonalizedFor('bob')).toEqual({ uiLang: 'ja' })
  })

  it('treats subjects case-sensitively (no identity folding)', () => {
    savePersonalizedFor('Alice', { uiLang: 'zh' })
    expect(loadPersonalizedFor('alice')).toBe(null)
  })

  it('reports no record for an account that never saved', () => {
    expect(loadPersonalizedFor('nobody')).toBe(null)
  })

  it('persists under a top-level map that is not part of SystemSettings', () => {
    savePersonalizedFor('alice', { uiLang: 'zh' })
    expect(diskRaw().personalizedSettings).toEqual({ alice: { uiLang: 'zh' } })
    expect(
      (loadSettings() as unknown as Record<string, unknown>).personalizedSettings,
    ).toBeUndefined()
  })

  it('creates no shared record when the connection has no subject', () => {
    savePersonalizedFor(null, { uiLang: 'zh' })
    expect(diskRaw().personalizedSettings).toEqual({})
    expect(getAgentLang()).toBe('zh')
  })
})

describe('first-login seeding from the browser fallback', () => {
  it('seeds a brand-new account record from the local fallback', () => {
    expect(resolvePersonalized('alice', { uiLang: 'zh' })).toEqual({ uiLang: 'zh' })
    expect(loadPersonalizedFor('alice')).toEqual({ uiLang: 'zh' })
  })

  it('seeds the built-in default when the browser reported nothing', () => {
    expect(resolvePersonalized('alice', undefined)).toEqual({ uiLang: 'en' })
    expect(loadPersonalizedFor('alice')).toEqual({ uiLang: 'en' })
  })

  it('never overwrites an existing account record with a different local value', () => {
    savePersonalizedFor('alice', { uiLang: 'zh' })
    expect(resolvePersonalized('alice', { uiLang: 'ru' })).toEqual({ uiLang: 'zh' })
    expect(loadPersonalizedFor('alice')).toEqual({ uiLang: 'zh' })
  })

  it('seeds at most once across repeated fetches (the first value stays authoritative)', () => {
    resolvePersonalized('alice', { uiLang: 'ja' })
    resolvePersonalized('alice', { uiLang: 'ru' })
    resolvePersonalized('alice', { uiLang: 'ko' })
    expect(loadPersonalizedFor('alice')).toEqual({ uiLang: 'ja' })
  })

  it('lets exactly one concurrent seeder win when two connections race', () => {
    // The store re-checks inside the lock, so a caller whose cached read said
    // "no record" still returns the record that was actually created.
    savePersonalizedFor('alice', { uiLang: 'zh' })
    resetSettingsCacheForTests()
    const first = resolvePersonalized('alice', { uiLang: 'ja' })
    const second = resolvePersonalized('alice', { uiLang: 'ko' })
    expect(first).toEqual({ uiLang: 'zh' })
    expect(second).toEqual({ uiLang: 'zh' })
  })

  it('stores nothing per account when there is no subject', () => {
    expect(resolvePersonalized(null, { uiLang: 'ru' })).toEqual({ uiLang: 'ru' })
    expect(diskRaw().personalizedSettings).toEqual({})
  })

  it('falls back to the built-in default with neither subject nor local record', () => {
    expect(resolvePersonalized(null, undefined)).toEqual({ uiLang: 'en' })
  })
})

describe('coexistence with the system settings write path', () => {
  it('survives a whole-object save_settings', () => {
    savePersonalizedFor('alice', { uiLang: 'zh' })
    saveSettings(baseSystemSettings({ voiceLang: 'en-US' }))
    expect(loadPersonalizedFor('alice')).toEqual({ uiLang: 'zh' })
    expect(diskRaw().personalizedSettings).toEqual({ alice: { uiLang: 'zh' } })
    expect(loadSettings().voiceLang).toBe('en-US')
  })

  it('preserves the system settings when a personalized save runs', () => {
    saveSettings(baseSystemSettings({ voiceLang: 'en-US', timezone: 'Asia/Shanghai' }))
    savePersonalizedFor('alice', { uiLang: 'zh' })
    resetSettingsCacheForTests()
    expect(loadSettings().voiceLang).toBe('en-US')
    expect(loadSettings().timezone).toBe('Asia/Shanghai')
  })

  it('drops a legacy system-wide uiLang instead of adopting it for any account', () => {
    saveSettings(baseSystemSettings({ uiLang: 'zh' } as Partial<SystemSettings>))
    expect(diskRaw().uiLang).toBeUndefined()
    expect(loadPersonalizedFor('alice')).toBe(null)
    expect(resolvePersonalized('alice', undefined)).toEqual({ uiLang: 'en' })
  })

  it('drops malformed entries from a hand-edited personalized map', () => {
    savePersonalizedFor('alice', { uiLang: 'zh' })
    writeAtomic(settingsPath(), {
      ...diskRaw(),
      personalizedSettings: {
        alice: 'not-an-object',
        '': { uiLang: 'zh' },
        bob: { uiLang: 'ja' },
      },
    })
    resetSettingsCacheForTests()
    expect(loadPersonalizedFor('alice')).toBe(null)
    expect(loadPersonalizedFor('')).toBe(null)
    expect(loadPersonalizedFor('bob')).toEqual({ uiLang: 'ja' })
    // A system-settings save must not resurrect what the read already rejected.
    saveSettings(baseSystemSettings())
    expect(diskRaw().personalizedSettings).toEqual({ bob: { uiLang: 'ja' } })
  })
})

describe('agent-output language tracking', () => {
  it('starts at the built-in default', () => {
    expect(getAgentLang()).toBe('en')
  })

  it('follows an account save', () => {
    savePersonalizedFor('alice', { uiLang: 'ko' })
    expect(getAgentLang()).toBe('ko')
  })

  it('follows a no-account report so an unauthenticated deployment still works', () => {
    resolvePersonalized(null, { uiLang: 'ru' })
    expect(getAgentLang()).toBe('ru')
  })

  it('follows the account being fetched when several accounts differ', () => {
    savePersonalizedFor('alice', { uiLang: 'zh' })
    savePersonalizedFor('bob', { uiLang: 'ja' })
    resolvePersonalized('alice', undefined)
    expect(getAgentLang()).toBe('zh')
  })
})
