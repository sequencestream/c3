import { describe, it, expect, afterEach } from 'vitest'
import {
  applyStoredFontScale,
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

/** Minimal fake root element so the cold-start apply is observable in the Node env.
 *  The style object carries `setProperty`, which the font-scale runtime uses. */
function installDocument(): { dataset: Record<string, string>; style: Record<string, string> } {
  const style = Object.assign({} as Record<string, string>, {
    setProperty(this: Record<string, string>, k: string, v: string): void {
      this[k] = v
    },
  })
  const root = { dataset: {} as Record<string, string>, style }
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
    expect(normalizePersonalized(undefined)).toEqual({
      uiLang: 'en',
      theme: 'dark',
      fontScale: 100,
    })
    expect(normalizePersonalized({})).toEqual({ uiLang: 'en', theme: 'dark', fontScale: 100 })
    expect(normalizePersonalized({ uiLang: 'xx' })).toEqual({
      uiLang: 'en',
      theme: 'dark',
      fontScale: 100,
    })
    expect(normalizePersonalized('zh')).toEqual({ uiLang: 'en', theme: 'dark', fontScale: 100 })
    expect(normalizePersonalized(DEFAULT_PERSONALIZED)).toEqual({
      uiLang: 'en',
      theme: 'dark',
      fontScale: 100,
    })
  })

  it('keeps a known language', () => {
    expect(normalizePersonalized({ uiLang: 'zh' })).toEqual({
      uiLang: 'zh',
      theme: 'dark',
      fontScale: 100,
    })
  })

  it('keeps a known theme and defaults an unknown one to dark', () => {
    expect(normalizePersonalized({ theme: 'light' })).toEqual({
      uiLang: 'en',
      theme: 'light',
      fontScale: 100,
    })
    expect(normalizePersonalized({ theme: 'solarized' })).toEqual({
      uiLang: 'en',
      theme: 'dark',
      fontScale: 100,
    })
  })

  it('normalizes each field on its own, so one corrupt value cannot cost the other', () => {
    expect(normalizePersonalized({ uiLang: 'zh', theme: 'solarized' })).toEqual({
      uiLang: 'zh',
      theme: 'dark',
      fontScale: 100,
    })
    expect(normalizePersonalized({ uiLang: 'klingon', theme: 'light' })).toEqual({
      uiLang: 'en',
      theme: 'light',
      fontScale: 100,
    })
  })

  it('keeps an in-range scale and defaults an out-of-range or non-numeric one to 100', () => {
    expect(normalizePersonalized({ fontScale: 87.5 })).toEqual({
      uiLang: 'en',
      theme: 'dark',
      fontScale: 87.5,
    })
    expect(normalizePersonalized({ fontScale: 50 })).toEqual({
      uiLang: 'en',
      theme: 'dark',
      fontScale: 100,
    })
    expect(normalizePersonalized({ fontScale: '110' })).toEqual({
      uiLang: 'en',
      theme: 'dark',
      fontScale: 100,
    })
  })

  it('normalizes the scale independently of the language and theme', () => {
    expect(normalizePersonalized({ uiLang: 'zh', theme: 'light', fontScale: 110 })).toEqual({
      uiLang: 'zh',
      theme: 'light',
      fontScale: 110,
    })
    expect(normalizePersonalized({ uiLang: 'zh', fontScale: 69 })).toEqual({
      uiLang: 'zh',
      theme: 'dark',
      fontScale: 100,
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

  it('round-trips a recorded font scale independently of the other fields', () => {
    installStorage()
    writeLocalPersonalized({ fontScale: 115 })
    expect(readLocalPersonalized()).toEqual({ fontScale: 115 })
    expect(hasLocalPersonalized()).toBe(true)
    writeLocalPersonalized({ uiLang: 'zh', theme: 'light' })
    expect(readLocalPersonalized()).toEqual({ uiLang: 'zh', theme: 'light', fontScale: 115 })
  })

  it('reads a corrupt or out-of-range stored scale as nothing recorded', () => {
    const state = installStorage()
    state.map.set('c3.fontScale', '200')
    expect(readLocalPersonalized()).toEqual({})
    state.map.set('c3.fontScale', 'not-a-number')
    expect(readLocalPersonalized()).toEqual({})
    state.map.set('c3.fontScale', '87.5')
    expect(readLocalPersonalized()).toEqual({ fontScale: 87.5 })
  })

  it('reports nothing recorded before any write, so a seed cannot be invented', () => {
    installStorage()
    expect(readLocalPersonalized()).toEqual({})
    expect(hasLocalPersonalized()).toBe(false)
    expect(normalizePersonalized(readLocalPersonalized())).toEqual({
      uiLang: 'en',
      theme: 'dark',
      fontScale: 100,
    })
  })

  it('treats a corrupt stored value as nothing recorded', () => {
    const state = installStorage()
    state.map.set('c3.uiLang', 'klingon')
    state.map.set('c3.theme', 'solarized')
    state.map.set('c3.fontScale', '1e3')
    expect(readLocalPersonalized()).toEqual({})
    expect(normalizePersonalized(readLocalPersonalized())).toEqual({
      uiLang: 'en',
      theme: 'dark',
      fontScale: 100,
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
    expect(() =>
      writeLocalPersonalized({ uiLang: 'zh', theme: 'light', fontScale: 110 }),
    ).not.toThrow()
    expect(normalizePersonalized(readLocalPersonalized())).toEqual({
      uiLang: 'en',
      theme: 'dark',
      fontScale: 100,
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

describe('applyStoredFontScale (cold start)', () => {
  it('applies the scale this browser recorded as a ratio', () => {
    const state = installStorage()
    state.map.set('c3.fontScale', '87.5')
    const root = installDocument()
    expect(applyStoredFontScale()).toBe(87.5)
    expect(root.style['--c-font-scale']).toBe('0.875')
  })

  it('applies 100% when this browser has recorded nothing', () => {
    installStorage()
    const root = installDocument()
    expect(applyStoredFontScale()).toBe(100)
    expect(root.style['--c-font-scale']).toBe('1')
  })

  it('applies 100% when the record is corrupt or storage is unusable', () => {
    const state = installStorage()
    state.map.set('c3.fontScale', '300')
    const root = installDocument()
    expect(applyStoredFontScale()).toBe(100)
    expect(root.style['--c-font-scale']).toBe('1')
    state.failing = true
    expect(applyStoredFontScale()).toBe(100)
  })
})
