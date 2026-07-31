import { describe, it, expect, afterEach } from 'vitest'
import {
  applyStoredTheme,
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

/** Minimal fake root element so the cold-start apply is observable in the Node env. */
function installDocument(): { dataset: Record<string, string>; style: Record<string, string> } {
  const root = { dataset: {} as Record<string, string>, style: {} as Record<string, string> }
  ;(globalThis as unknown as { document: unknown }).document = { documentElement: root }
  return root
}

afterEach(() => {
  delete (globalThis as unknown as { localStorage?: unknown }).localStorage
  delete (globalThis as unknown as { document?: unknown }).document
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
    expect(normalizePersonalized(undefined)).toEqual({ uiLang: 'en', theme: 'dark' })
    expect(normalizePersonalized({})).toEqual({ uiLang: 'en', theme: 'dark' })
    expect(normalizePersonalized({ uiLang: 'xx' })).toEqual({ uiLang: 'en', theme: 'dark' })
    expect(normalizePersonalized('zh')).toEqual({ uiLang: 'en', theme: 'dark' })
    expect(normalizePersonalized(DEFAULT_PERSONALIZED)).toEqual({ uiLang: 'en', theme: 'dark' })
  })

  it('keeps a known language', () => {
    expect(normalizePersonalized({ uiLang: 'zh' })).toEqual({ uiLang: 'zh', theme: 'dark' })
  })

  it('keeps a known theme and defaults an unknown one to dark', () => {
    expect(normalizePersonalized({ theme: 'light' })).toEqual({ uiLang: 'en', theme: 'light' })
    expect(normalizePersonalized({ theme: 'solarized' })).toEqual({ uiLang: 'en', theme: 'dark' })
  })

  it('normalizes each field on its own, so one corrupt value cannot cost the other', () => {
    expect(normalizePersonalized({ uiLang: 'zh', theme: 'solarized' })).toEqual({
      uiLang: 'zh',
      theme: 'dark',
    })
    expect(normalizePersonalized({ uiLang: 'klingon', theme: 'light' })).toEqual({
      uiLang: 'en',
      theme: 'light',
    })
  })
})

describe('browser store', () => {
  it('round-trips a recorded language', () => {
    installStorage()
    writeLocalPersonalized({ uiLang: 'ja' })
    expect(readLocalPersonalized()).toEqual({ uiLang: 'ja' })
    expect(hasLocalPersonalized()).toBe(true)
  })

  it('round-trips a recorded theme independently of the language', () => {
    installStorage()
    writeLocalPersonalized({ theme: 'light' })
    expect(readLocalPersonalized()).toEqual({ theme: 'light' })
    expect(hasLocalPersonalized()).toBe(true)
    writeLocalPersonalized({ uiLang: 'ja' })
    expect(readLocalPersonalized()).toEqual({ uiLang: 'ja', theme: 'light' })
  })

  it('reports nothing recorded before any write, so a seed cannot be invented', () => {
    installStorage()
    expect(readLocalPersonalized()).toEqual({})
    expect(hasLocalPersonalized()).toBe(false)
    expect(normalizePersonalized(readLocalPersonalized())).toEqual({
      uiLang: 'en',
      theme: 'dark',
    })
  })

  it('treats a corrupt stored value as nothing recorded', () => {
    const state = installStorage()
    state.map.set('c3.uiLang', 'klingon')
    state.map.set('c3.theme', 'solarized')
    expect(readLocalPersonalized()).toEqual({})
    expect(normalizePersonalized(readLocalPersonalized())).toEqual({
      uiLang: 'en',
      theme: 'dark',
    })
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
    expect(() => writeLocalPersonalized({ uiLang: 'zh', theme: 'light' })).not.toThrow()
    expect(normalizePersonalized(readLocalPersonalized())).toEqual({
      uiLang: 'en',
      theme: 'dark',
    })
  })

  it('falls back to en when there is no storage global at all', () => {
    expect(readLocalPersonalized()).toEqual({})
    expect(() => writeLocalPersonalized({ uiLang: 'zh' })).not.toThrow()
  })

  it('leaves the store untouched for a settings object carrying no language', () => {
    const state = installStorage()
    state.map.set('c3.uiLang', 'zh')
    state.map.set('c3.theme', 'light')
    writeLocalPersonalized({})
    expect(state.map.get('c3.uiLang')).toBe('zh')
    expect(state.map.get('c3.theme')).toBe('light')
  })
})

describe('applyStoredTheme (cold start)', () => {
  it('applies the theme this browser recorded', () => {
    const state = installStorage()
    state.map.set('c3.theme', 'light')
    const root = installDocument()
    expect(applyStoredTheme()).toBe('light')
    expect(root.dataset.theme).toBe('light')
  })

  it('shows the dark console when this browser has recorded nothing', () => {
    installStorage()
    const root = installDocument()
    expect(applyStoredTheme()).toBe('dark')
    expect(root.dataset.theme).toBe('dark')
  })

  it('shows the dark console when the record is corrupt or storage is unusable', () => {
    const state = installStorage()
    state.map.set('c3.theme', 'solarized')
    const root = installDocument()
    expect(applyStoredTheme()).toBe('dark')
    state.failing = true
    expect(applyStoredTheme()).toBe('dark')
    expect(root.dataset.theme).toBe('dark')
  })
})
