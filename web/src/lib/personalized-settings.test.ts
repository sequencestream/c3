import { describe, it, expect, afterEach } from 'vitest'
import {
  DEFAULT_PERSONALIZED,
  hasLocalPersonalized,
  isUiLang,
  normalizePersonalized,
  readLocalPersonalized,
  writeLocalPersonalized,
} from './personalized-settings'

// The repository reads `localStorage` off the global; these tests install a fake
// (the lib runs in the Node test env, where no real one exists) and can also make
// it throw to cover a browser that refuses storage.
type FakeStore = { map: Map<string, string>; failing: boolean }

function installStorage(): FakeStore {
  const state: FakeStore = { map: new Map(), failing: false }
  const store = {
    getItem(key: string): string | null {
      if (state.failing) throw new Error('storage disabled')
      return state.map.has(key) ? state.map.get(key)! : null
    },
    setItem(key: string, value: string): void {
      if (state.failing) throw new Error('storage disabled')
      state.map.set(key, value)
    },
  }
  ;(globalThis as unknown as { localStorage: unknown }).localStorage = store
  return state
}

afterEach(() => {
  delete (globalThis as unknown as { localStorage?: unknown }).localStorage
})

describe('isUiLang', () => {
  it('accepts the five known languages and rejects anything else', () => {
    for (const lang of ['en', 'zh', 'ja', 'ko', 'ru']) expect(isUiLang(lang)).toBe(true)
    for (const bad of ['xx', 'zh-CN', '', 42, null, undefined, {}]) {
      expect(isUiLang(bad)).toBe(false)
    }
  })
})

describe('normalizePersonalized', () => {
  it('fills en for a missing, unknown, or non-object value', () => {
    expect(normalizePersonalized(undefined)).toEqual({ uiLang: 'en' })
    expect(normalizePersonalized({})).toEqual({ uiLang: 'en' })
    expect(normalizePersonalized({ uiLang: 'xx' })).toEqual({ uiLang: 'en' })
    expect(normalizePersonalized('zh')).toEqual({ uiLang: 'en' })
    expect(normalizePersonalized(DEFAULT_PERSONALIZED)).toEqual({ uiLang: 'en' })
  })

  it('keeps a known language', () => {
    expect(normalizePersonalized({ uiLang: 'zh' })).toEqual({ uiLang: 'zh' })
  })
})

describe('browser store', () => {
  it('round-trips a recorded language', () => {
    installStorage()
    writeLocalPersonalized({ uiLang: 'ja' })
    expect(readLocalPersonalized()).toEqual({ uiLang: 'ja' })
    expect(hasLocalPersonalized()).toBe(true)
  })

  it('reports nothing recorded before any write, so a seed cannot be invented', () => {
    installStorage()
    expect(readLocalPersonalized()).toEqual({})
    expect(hasLocalPersonalized()).toBe(false)
    expect(normalizePersonalized(readLocalPersonalized())).toEqual({ uiLang: 'en' })
  })

  it('treats a corrupt stored value as nothing recorded', () => {
    const state = installStorage()
    state.map.set('c3.uiLang', 'klingon')
    expect(readLocalPersonalized()).toEqual({})
    expect(normalizePersonalized(readLocalPersonalized())).toEqual({ uiLang: 'en' })
  })

  it('reads the language the console has always stored (no migration needed)', () => {
    const state = installStorage()
    state.map.set('c3.uiLang', 'zh')
    expect(readLocalPersonalized()).toEqual({ uiLang: 'zh' })
  })

  it('falls back to en and never throws when storage is unavailable', () => {
    const state = installStorage()
    state.failing = true
    expect(readLocalPersonalized()).toEqual({})
    expect(hasLocalPersonalized()).toBe(false)
    expect(() => writeLocalPersonalized({ uiLang: 'zh' })).not.toThrow()
    expect(normalizePersonalized(readLocalPersonalized())).toEqual({ uiLang: 'en' })
  })

  it('falls back to en when there is no storage global at all', () => {
    expect(readLocalPersonalized()).toEqual({})
    expect(() => writeLocalPersonalized({ uiLang: 'zh' })).not.toThrow()
  })

  it('leaves the store untouched for a settings object carrying no language', () => {
    const state = installStorage()
    state.map.set('c3.uiLang', 'zh')
    writeLocalPersonalized({})
    expect(state.map.get('c3.uiLang')).toBe('zh')
  })
})
