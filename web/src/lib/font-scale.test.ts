import { describe, it, expect, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  applyFontScale,
  DEFAULT_FONT_SCALE,
  FONT_SCALE_MAX,
  FONT_SCALE_MIN,
  isFontScale,
  resolveFontScale,
} from './font-scale'

// `applyFontScale` writes the root element; the lib runs in the Node test env, so
// install a minimal fake document we can inspect (and drop it again to cover "no DOM").
// The style object carries `setProperty`, which the runtime uses for CSS variables.
type FakeStyle = Record<string, string> & { setProperty(k: string, v: string): void }
type FakeRoot = { dataset: Record<string, string>; style: FakeStyle }

function installDocument(): FakeRoot {
  const style: FakeStyle = Object.assign({} as Record<string, string>, {
    setProperty(this: Record<string, string>, k: string, v: string): void {
      this[k] = v
    },
  })
  const root: FakeRoot = { dataset: {}, style }
  ;(globalThis as unknown as { document: unknown }).document = { documentElement: root }
  return root
}

afterEach(() => {
  delete (globalThis as unknown as { document?: unknown }).document
})

describe('font-scale registry', () => {
  it('declares the accepted 70–120 range with 100 as the default', () => {
    expect(FONT_SCALE_MIN).toBe(70)
    expect(FONT_SCALE_MAX).toBe(120)
    expect(DEFAULT_FONT_SCALE).toBe(100)
  })

  it('accepts only in-range numbers, including a fraction', () => {
    for (const good of [70, 87.5, 100, 120]) expect(isFontScale(good)).toBe(true)
    for (const bad of [69, 121, '100', '87.5', NaN, null, undefined, {}]) {
      expect(isFontScale(bad)).toBe(false)
    }
  })

  it('resolves an unknown value to the default', () => {
    expect(resolveFontScale(120)).toBe(120)
    expect(resolveFontScale(50)).toBe(100)
    expect(resolveFontScale(undefined)).toBe(100)
  })
})

describe('applyFontScale', () => {
  it('writes the scale as a ratio onto the root CSS variable', () => {
    const root = installDocument()
    expect(applyFontScale(100)).toBe(100)
    expect(root.style['--c-font-scale']).toBe('1')
    expect(applyFontScale(87.5)).toBe(87.5)
    expect(root.style['--c-font-scale']).toBe('0.875')
    expect(applyFontScale(120)).toBe(120)
    expect(root.style['--c-font-scale']).toBe('1.2')
  })

  it('normalizes an out-of-range or non-numeric value to the default', () => {
    const root = installDocument()
    for (const bad of [undefined, null, '100', 0, 200, NaN]) {
      expect(applyFontScale(bad)).toBe(100)
      expect(root.style['--c-font-scale']).toBe('1')
    }
  })

  it('still resolves the scale when there is no document at all', () => {
    expect(() => applyFontScale(110)).not.toThrow()
    expect(applyFontScale(110)).toBe(110)
  })
})

describe('stylesheet agreement', () => {
  // The runtime only writes a CSS variable; the tokens that scale live in CSS.
  // These assert the two halves line up, so the font scale actually reaches text.
  const css = readFileSync(resolve(__dirname, '../standard.css'), 'utf8')

  it('declares --c-font-scale on :root with the default 1 (100%)', () => {
    expect(css).toMatch(/:root \{[\s\S]*?--c-font-scale:\s*1;/)
  })

  it('every font token consumes the scale via calc', () => {
    for (const token of [
      '--fs-title-lg',
      '--fs-title-sm',
      '--fs-body',
      '--fs-caption',
      '--fs-code',
      '--fs-badge',
    ]) {
      expect(css).toMatch(new RegExp(`${token}:\\s*calc\\(\\d+px \\* var\\(--c-font-scale\\)\\);`))
    }
  })
})
