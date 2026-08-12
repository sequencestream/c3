import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SYSTEM_AGENT_ID } from '@ccc/shared/protocol'
import type { PersonalizedSettings, SystemSettings, UiLang, UiTheme } from '@ccc/shared/protocol'
import {
  getAgentLang,
  loadPersonalizedFor,
  normalizePersonalized,
  resolvePersonalized,
  savePersonalizedFor,
} from './personalized.js'
import { loadSettings, resetSettingsCacheForTests, saveSettings } from './index.js'
import {
  readStoredPersonalized,
  readStoredSystemSettings,
  releaseConfigDb,
  seedPersonalized,
  useConfigDb,
} from './config-fixture.js'

// Run against a throwaway database (and a throwaway `$HOME`, so a leak would be both
// harmless and visible) — these tests must never touch the developer's real config.
let dir: string
let prevHome: string | undefined

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'c3-personalized-'))
  prevHome = process.env.HOME
  process.env.HOME = dir
  useConfigDb(dir)
})

afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME
  else process.env.HOME = prevHome
  releaseConfigDb()
  rmSync(dir, { recursive: true, force: true })
})

/**
 * A fully normalized record: every field filled with its own default, which is what
 * every read and echo returns regardless of how sparse the stored value was.
 */
function rec(uiLang: UiLang, theme: UiTheme = 'dark', fontScale = 100): PersonalizedSettings {
  return { uiLang, theme, fontScale }
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
    expect(normalizePersonalized(undefined)).toEqual(rec('en'))
    expect(normalizePersonalized({})).toEqual(rec('en'))
    expect(normalizePersonalized({ uiLang: 'xx' })).toEqual(rec('en'))
    expect(normalizePersonalized({ uiLang: 42 })).toEqual(rec('en'))
    expect(normalizePersonalized('zh')).toEqual(rec('en'))
  })

  it('keeps every known language', () => {
    for (const lang of ['en', 'zh', 'ja', 'ko', 'ru'] as const) {
      expect(normalizePersonalized({ uiLang: lang })).toEqual(rec(lang))
    }
  })

  it('fills the dark theme for a missing, unknown, or non-string value', () => {
    expect(normalizePersonalized({})).toEqual(rec('en', 'dark'))
    expect(normalizePersonalized({ theme: 'solarized' })).toEqual(rec('en', 'dark'))
    expect(normalizePersonalized({ theme: 7 })).toEqual(rec('en', 'dark'))
  })

  it('keeps every known theme', () => {
    for (const theme of ['dark', 'light'] as const) {
      expect(normalizePersonalized({ theme })).toEqual(rec('en', theme))
    }
  })

  it('normalizes the two fields independently', () => {
    expect(normalizePersonalized({ uiLang: 'zh', theme: 'solarized' })).toEqual(rec('zh', 'dark'))
    expect(normalizePersonalized({ uiLang: 'klingon', theme: 'light' })).toEqual(rec('en', 'light'))
  })

  it('fills the 100% scale for a missing, non-numeric, or out-of-range value', () => {
    expect(normalizePersonalized({})).toEqual(rec('en', 'dark', 100))
    expect(normalizePersonalized({ fontScale: '110' })).toEqual(rec('en', 'dark', 100))
    expect(normalizePersonalized({ fontScale: 69 })).toEqual(rec('en', 'dark', 100))
    expect(normalizePersonalized({ fontScale: 121 })).toEqual(rec('en', 'dark', 100))
    expect(normalizePersonalized({ fontScale: NaN })).toEqual(rec('en', 'dark', 100))
  })

  it('keeps every in-range scale, including a fraction', () => {
    expect(normalizePersonalized({ fontScale: 70 })).toEqual(rec('en', 'dark', 70))
    expect(normalizePersonalized({ fontScale: 87.5 })).toEqual(rec('en', 'dark', 87.5))
    expect(normalizePersonalized({ fontScale: 100 })).toEqual(rec('en', 'dark', 100))
    expect(normalizePersonalized({ fontScale: 120 })).toEqual(rec('en', 'dark', 120))
  })

  it('normalizes the scale independently of the language and theme', () => {
    expect(normalizePersonalized({ uiLang: 'zh', theme: 'light', fontScale: 110 })).toEqual(
      rec('zh', 'light', 110),
    )
    expect(normalizePersonalized({ uiLang: 'zh', theme: 'solarized', fontScale: 69 })).toEqual(
      rec('zh', 'dark', 100),
    )
  })
})

describe('per-account storage', () => {
  it('keeps two subjects isolated', () => {
    savePersonalizedFor('alice', { uiLang: 'zh' })
    savePersonalizedFor('bob', { uiLang: 'ja' })
    expect(loadPersonalizedFor('alice')).toEqual(rec('zh'))
    expect(loadPersonalizedFor('bob')).toEqual(rec('ja'))
  })

  it('treats subjects case-sensitively (no identity folding)', () => {
    savePersonalizedFor('Alice', { uiLang: 'zh' })
    expect(loadPersonalizedFor('alice')).toBe(null)
  })

  it('reports no record for an account that never saved', () => {
    expect(loadPersonalizedFor('nobody')).toBe(null)
  })

  it('persists in its own scope, outside SystemSettings', () => {
    savePersonalizedFor('alice', { uiLang: 'zh' })
    expect(readStoredPersonalized()).toEqual({ alice: rec('zh') })
    expect(
      (loadSettings() as unknown as Record<string, unknown>).personalizedSettings,
    ).toBeUndefined()
  })

  it('creates no shared record when the connection has no subject', () => {
    savePersonalizedFor(null, { uiLang: 'zh' })
    expect(readStoredPersonalized()).toEqual({})
    expect(getAgentLang()).toBe('zh')
  })
})

describe('first-login seeding from the browser fallback', () => {
  it('seeds a brand-new account record from the local fallback', () => {
    expect(resolvePersonalized('alice', { uiLang: 'zh' })).toEqual(rec('zh'))
    expect(loadPersonalizedFor('alice')).toEqual(rec('zh'))
  })

  it('seeds the built-in default when the browser reported nothing', () => {
    expect(resolvePersonalized('alice', undefined)).toEqual(rec('en'))
    expect(loadPersonalizedFor('alice')).toEqual(rec('en'))
  })

  it('never overwrites an existing account record with a different local value', () => {
    savePersonalizedFor('alice', { uiLang: 'zh' })
    expect(resolvePersonalized('alice', { uiLang: 'ru' })).toEqual(rec('zh'))
    expect(loadPersonalizedFor('alice')).toEqual(rec('zh'))
  })

  it('seeds at most once across repeated fetches (the first value stays authoritative)', () => {
    resolvePersonalized('alice', { uiLang: 'ja' })
    resolvePersonalized('alice', { uiLang: 'ru' })
    resolvePersonalized('alice', { uiLang: 'ko' })
    expect(loadPersonalizedFor('alice')).toEqual(rec('ja'))
  })

  it('lets exactly one concurrent seeder win when two connections race', () => {
    // The store re-checks inside the lock, so a caller whose cached read said
    // "no record" still returns the record that was actually created.
    savePersonalizedFor('alice', { uiLang: 'zh' })
    resetSettingsCacheForTests()
    const first = resolvePersonalized('alice', { uiLang: 'ja' })
    const second = resolvePersonalized('alice', { uiLang: 'ko' })
    expect(first).toEqual(rec('zh'))
    expect(second).toEqual(rec('zh'))
  })

  it('stores nothing per account when there is no subject', () => {
    expect(resolvePersonalized(null, { uiLang: 'ru' })).toEqual(rec('ru'))
    expect(readStoredPersonalized()).toEqual({})
  })

  it('falls back to the built-in default with neither subject nor local record', () => {
    expect(resolvePersonalized(null, undefined)).toEqual(rec('en'))
  })

  it('seeds the theme alongside the language', () => {
    expect(resolvePersonalized('alice', { uiLang: 'zh', theme: 'light' })).toEqual(
      rec('zh', 'light'),
    )
    expect(loadPersonalizedFor('alice')).toEqual(rec('zh', 'light'))
  })

  it('seeds the dark theme for a browser that only ever chose a language', () => {
    expect(resolvePersonalized('alice', { uiLang: 'zh' })).toEqual(rec('zh', 'dark'))
  })

  it('reads an account record written before themes existed as dark', () => {
    seedPersonalized('alice', { uiLang: 'zh' })
    expect(loadPersonalizedFor('alice')).toEqual(rec('zh', 'dark'))
    expect(resolvePersonalized('alice', { theme: 'light' })).toEqual(rec('zh', 'dark'))
  })
})

describe('coexistence with the system settings write path', () => {
  it('survives a whole-object save_settings', () => {
    savePersonalizedFor('alice', { uiLang: 'zh' })
    saveSettings(baseSystemSettings({ voiceLang: 'en-US' }))
    expect(loadPersonalizedFor('alice')).toEqual(rec('zh'))
    expect(readStoredPersonalized()).toEqual({ alice: rec('zh') })
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
    expect(readStoredSystemSettings().uiLang).toBeUndefined()
    expect(loadPersonalizedFor('alice')).toBe(null)
    expect(resolvePersonalized('alice', undefined)).toEqual(rec('en'))
  })

  it('drops an empty-subject record and normalizes junk fields', () => {
    seedPersonalized('', { uiLang: 'zh' })
    seedPersonalized('bob', { uiLang: 'ja' })
    seedPersonalized('carol', { uiLang: 'klingon', theme: 'neon' })
    expect(loadPersonalizedFor('')).toBe(null)
    expect(loadPersonalizedFor('bob')).toEqual(rec('ja'))
    // A field nobody recognizes falls back to its own default; it never takes the
    // whole account record down with it.
    expect(loadPersonalizedFor('carol')).toEqual(rec('en'))
    // A system-settings save touches no personalized scope at all.
    saveSettings(baseSystemSettings())
    expect(loadPersonalizedFor('bob')).toEqual(rec('ja'))
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

  it('ignores the theme — it is a web display preference, not a language decision', () => {
    savePersonalizedFor('alice', { uiLang: 'ko', theme: 'light' })
    expect(getAgentLang()).toBe('ko')
    savePersonalizedFor('alice', { uiLang: 'ko', theme: 'dark' })
    expect(getAgentLang()).toBe('ko')
  })
})

describe('theme persistence', () => {
  it('stores the theme per account, independently of the language', () => {
    savePersonalizedFor('alice', { uiLang: 'zh', theme: 'light' })
    savePersonalizedFor('bob', { uiLang: 'zh', theme: 'dark' })
    expect(loadPersonalizedFor('alice')).toEqual(rec('zh', 'light'))
    expect(loadPersonalizedFor('bob')).toEqual(rec('zh', 'dark'))
  })

  it('rejects an unknown theme without losing the language that came with it', () => {
    savePersonalizedFor('alice', { uiLang: 'ja', theme: 'solarized' } as never)
    expect(loadPersonalizedFor('alice')).toEqual(rec('ja', 'dark'))
  })

  it('survives a whole-object save_settings like every other personalized field', () => {
    savePersonalizedFor('alice', { uiLang: 'zh', theme: 'light' })
    saveSettings(baseSystemSettings({ voiceLang: 'en-US' }))
    resetSettingsCacheForTests()
    expect(loadPersonalizedFor('alice')).toEqual(rec('zh', 'light'))
  })
})

describe('font scale persistence', () => {
  it('stores the scale per account, independently of language and theme', () => {
    savePersonalizedFor('alice', { uiLang: 'zh', theme: 'light', fontScale: 115 })
    savePersonalizedFor('bob', { uiLang: 'zh', fontScale: 85 })
    expect(loadPersonalizedFor('alice')).toEqual(rec('zh', 'light', 115))
    expect(loadPersonalizedFor('bob')).toEqual(rec('zh', 'dark', 85))
  })

  it('rejects an out-of-range scale without losing the fields that came with it', () => {
    savePersonalizedFor('alice', { uiLang: 'ja', theme: 'light', fontScale: 200 } as never)
    expect(loadPersonalizedFor('alice')).toEqual(rec('ja', 'light', 100))
  })

  it('reads an account record written before the scale existed as 100%', () => {
    seedPersonalized('alice', { uiLang: 'zh' })
    expect(loadPersonalizedFor('alice')).toEqual(rec('zh', 'dark', 100))
  })

  it('seeds a brand-new account record with the browser scale', () => {
    expect(resolvePersonalized('alice', { uiLang: 'zh', fontScale: 110 })).toEqual(
      rec('zh', 'dark', 110),
    )
    expect(loadPersonalizedFor('alice')).toEqual(rec('zh', 'dark', 110))
  })
})
