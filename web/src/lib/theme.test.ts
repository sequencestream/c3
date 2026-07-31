import { describe, it, expect, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { applyTheme, DEFAULT_THEME, isUiTheme, resolveTheme, THEMES } from './theme'

// `applyTheme` writes the root element; the lib runs in the Node test env, so install
// a minimal fake document we can inspect (and drop it again to cover "no DOM").
type FakeRoot = { dataset: Record<string, string>; style: Record<string, string> }

function installDocument(): FakeRoot {
  const root: FakeRoot = { dataset: {}, style: {} }
  ;(globalThis as unknown as { document: unknown }).document = { documentElement: root }
  return root
}

afterEach(() => {
  delete (globalThis as unknown as { document?: unknown }).document
})

describe('theme registry', () => {
  it('registers exactly the two themes this release ships', () => {
    expect(THEMES.map((theme) => theme.id)).toEqual(['dark', 'light'])
  })

  it('gives every theme a unique id and a display name', () => {
    const ids = THEMES.map((theme) => theme.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const theme of THEMES) {
      expect(theme.labelKey).toMatch(/^personalizedSetting\.theme\./)
      expect(theme.labelKey.endsWith('.label')).toBe(true)
    }
  })

  it('ships a display name for every registered theme in every locale', () => {
    const base = resolve(__dirname, '../locales')
    for (const locale of ['en', 'zh', 'ja', 'ko', 'ru']) {
      const messages = JSON.parse(readFileSync(resolve(base, `${locale}.json`), 'utf8'))
      for (const theme of THEMES) {
        const label = theme.labelKey
          .split('.')
          .reduce<unknown>((node, seg) => (node as Record<string, unknown>)?.[seg], messages)
        expect(typeof label, `${locale} ${theme.labelKey}`).toBe('string')
      }
    }
  })

  it('defaults to the console`s original dark look', () => {
    expect(DEFAULT_THEME).toBe('dark')
    expect(THEMES[0]!.id).toBe(DEFAULT_THEME)
  })

  it('accepts only registered ids', () => {
    expect(isUiTheme('dark')).toBe(true)
    expect(isUiTheme('light')).toBe(true)
    for (const bad of ['DARK', 'solarized', '', 42, null, undefined, {}]) {
      expect(isUiTheme(bad)).toBe(false)
    }
  })

  it('resolves an unknown value to the default entry', () => {
    expect(resolveTheme('light').id).toBe('light')
    expect(resolveTheme('solarized').id).toBe('dark')
    expect(resolveTheme(undefined).id).toBe('dark')
  })
})

describe('applyTheme', () => {
  it('writes the matching data-theme and color-scheme for each registered theme', () => {
    const root = installDocument()
    expect(applyTheme('light')).toBe('light')
    expect(root.dataset.theme).toBe('light')
    expect(root.style.colorScheme).toBe('light')
    expect(applyTheme('dark')).toBe('dark')
    expect(root.dataset.theme).toBe('dark')
    expect(root.style.colorScheme).toBe('dark')
  })

  it('normalizes a missing or unknown value to dark instead of writing it to the DOM', () => {
    const root = installDocument()
    for (const bad of [undefined, null, '', 'solarized', 'light-x', 7]) {
      expect(applyTheme(bad)).toBe('dark')
      expect(root.dataset.theme).toBe('dark')
      expect(root.style.colorScheme).toBe('dark')
    }
  })

  it('still resolves the theme when there is no document at all', () => {
    expect(() => applyTheme('light')).not.toThrow()
    expect(applyTheme('light')).toBe('light')
  })
})

describe('stylesheet agreement', () => {
  // The registry only maps ids; the palette stays in CSS. These assert the two halves
  // still line up, so a registry entry can never point at a selector nobody styles.
  const css = readFileSync(resolve(__dirname, '../standard.css'), 'utf8')

  it('styles every non-default theme through its own [data-theme] block', () => {
    for (const theme of THEMES) {
      if (theme.id === DEFAULT_THEME) continue
      expect(css).toContain(`:root[data-theme='${theme.id}']`)
    }
  })

  it('declares the same color-scheme the registry reports', () => {
    // The default theme's tokens live on bare `:root`; the others in their own block.
    expect(css).toMatch(/:root \{\s*color-scheme: dark;/)
    expect(css).toMatch(/:root\[data-theme='light'\] \{\s*color-scheme: light;/)
    expect(THEMES.find((theme) => theme.id === 'light')!.colorScheme).toBe('light')
    expect(THEMES.find((theme) => theme.id === 'dark')!.colorScheme).toBe('dark')
  })
})
