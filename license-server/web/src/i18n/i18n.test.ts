import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  i18n,
  readStoredLocale,
  resolveInitialLocale,
  setLocale,
  setStoredLocale,
} from './index'
import zh from '../locales/zh.json'
import en from '../locales/en.json'

// happy-dom doesn't surface `localStorage` as a bare global in this setup, so the
// module's persistence helpers would silently no-op. Back them with an in-memory
// store per test for deterministic round-trips.
function memStorage(): Storage {
  const m = new Map<string, string>()
  return {
    getItem: (k) => (m.has(k) ? (m.get(k) as string) : null),
    setItem: (k, v) => void m.set(k, String(v)),
    removeItem: (k) => void m.delete(k),
    clear: () => m.clear(),
    key: (i) => Array.from(m.keys())[i] ?? null,
    get length() {
      return m.size
    },
  }
}

beforeEach(() => {
  vi.stubGlobal('localStorage', memStorage())
})

afterEach(() => {
  vi.unstubAllGlobals()
  // Leave the shared singleton on the default locale so other suites start clean.
  i18n.global.locale.value = 'zh'
})

// flatten turns a nested message object into the set of its dot-joined leaf keys,
// so two locales can be compared for an identical keyspace (no missing / extra).
function flatten(obj: Record<string, unknown>, prefix = ''): string[] {
  return Object.entries(obj).flatMap(([k, v]) => {
    const key = prefix ? `${prefix}.${k}` : k
    return typeof v === 'object' && v !== null
      ? flatten(v as Record<string, unknown>, key)
      : [key]
  })
}

describe('resolveInitialLocale', () => {
  it('defaults to zh when navigator.language is zh-CN and nothing is stored', () => {
    localStorage.clear()
    vi.stubGlobal('navigator', { language: 'zh-CN' })
    expect(resolveInitialLocale()).toBe('zh')
  })

  it('defaults to en when navigator.language is en-US and nothing is stored', () => {
    localStorage.clear()
    vi.stubGlobal('navigator', { language: 'en-US' })
    expect(resolveInitialLocale()).toBe('en')
  })

  it('maps a non-zh, non-en browser language to en', () => {
    localStorage.clear()
    vi.stubGlobal('navigator', { language: 'fr-FR' })
    expect(resolveInitialLocale()).toBe('en')
  })

  it('falls back to zh when the browser language is unavailable', () => {
    localStorage.clear()
    vi.stubGlobal('navigator', { language: '' })
    expect(resolveInitialLocale()).toBe('zh')
  })

  it('prefers the stored locale over the browser language', () => {
    setStoredLocale('en')
    vi.stubGlobal('navigator', { language: 'zh-CN' })
    expect(resolveInitialLocale()).toBe('en')
  })
})

describe('locale persistence', () => {
  it('round-trips a stored locale through localStorage', () => {
    setStoredLocale('en')
    expect(readStoredLocale()).toBe('en')
  })

  it('ignores an invalid stored value', () => {
    localStorage.setItem('c3ls.uiLang', 'de')
    expect(readStoredLocale()).toBeNull()
  })

  it('persists the locale chosen via setLocale so a refresh keeps it', () => {
    setLocale('en')
    expect(readStoredLocale()).toBe('en')
  })
})

describe('runtime switching', () => {
  it('switches the active messages immediately', () => {
    setLocale('zh')
    expect(i18n.global.t('login.title')).toBe('登录')
    setLocale('en')
    expect(i18n.global.t('login.title')).toBe('Sign in')
  })

  it('localizes a front-end error/hint message per locale', () => {
    setLocale('zh')
    expect(i18n.global.t('checkout.errorMustAccept')).toBe('请先同意服务协议。')
    setLocale('en')
    expect(i18n.global.t('checkout.errorMustAccept')).toBe('Please accept the service agreement first.')
  })
})

describe('resource integrity', () => {
  it('zh and en share an identical keyspace (no missing or extra keys)', () => {
    const zhKeys = flatten(zh as Record<string, unknown>).sort()
    const enKeys = flatten(en as Record<string, unknown>).sort()
    expect(zhKeys).toEqual(enKeys)
  })

  it('keeps plan comparison capability and name keys aligned across locales', () => {
    expect(Object.keys(zh.plans.capabilities).sort()).toEqual(Object.keys(en.plans.capabilities).sort())
    expect(Object.keys(zh.plans.name).sort()).toEqual(Object.keys(en.plans.name).sort())

    for (const key of Object.keys(zh.plans.capabilities) as Array<keyof typeof zh.plans.capabilities>) {
      expect(Object.keys(zh.plans.capabilities[key]).sort()).toEqual(Object.keys(en.plans.capabilities[key]).sort())
    }
  })
})
