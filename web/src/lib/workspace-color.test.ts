import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  CONTRAST_BODY,
  CONTRAST_SECONDARY,
  contrastRatio,
  flatten,
  readTokenBlock,
} from './contrast'
import { WORKSPACE_COLOR_SLOTS, workspaceColor, workspaceInitial } from './workspace-color'

const css = readFileSync(resolve(__dirname, '../standard.css'), 'utf8')
const dark = readTokenBlock(css, ':root {')
const light = { ...dark, ...readTokenBlock(css, ":root[data-theme='light']") }
const solarized = { ...dark, ...readTokenBlock(css, ":root[data-theme='solarized-light']") }
const themes = { dark, light, solarized }
const WHITE = { r: 255, g: 255, b: 255 }

describe('workspaceColor', () => {
  it('gives the same workspace the same colour every time it is asked', () => {
    for (const name of ['c3', '/Users/tiltwind/workspace/github/sequencestream/c3', '工作区-甲']) {
      expect(workspaceColor(name)).toEqual(workspaceColor(name))
    }
  })

  it('hands out every one of the palette slots, so names are actually told apart', () => {
    const names = Array.from({ length: 200 }, (_, i) => `workspace-${i}`)
    const slots = new Set(names.map((name) => workspaceColor(name)!.fill))
    expect(slots.size).toBe(WORKSPACE_COLOR_SLOTS)
  })

  it('reads a token name, never a baked hex — the theme supplies the colour', () => {
    const color = workspaceColor('c3')!
    expect(color.fill).toBe(`var(--c-ws-${color.slot})`)
    expect(color.ink).toBe(`var(--c-ws-ink-${color.slot})`)
    expect(color.slot).toBeGreaterThanOrEqual(1)
    expect(color.slot).toBeLessThanOrEqual(WORKSPACE_COLOR_SLOTS)
  })

  it('has no colour for an absent workspace', () => {
    expect(workspaceColor(null)).toBeNull()
    expect(workspaceColor(undefined)).toBeNull()
    expect(workspaceColor('   ')).toBeNull()
  })

  it('stays readable on every theme panel, with ink on the fill', () => {
    for (const [name, tokens] of Object.entries(themes)) {
      for (let slot = 1; slot <= WORKSPACE_COLOR_SLOTS; slot += 1) {
        const fill = flatten(tokens[`--c-ws-${slot}`]!, WHITE)
        const ink = flatten(tokens[`--c-ws-ink-${slot}`]!, WHITE)
        expect(
          contrastRatio(fill, flatten(tokens['--c-panel']!, WHITE)),
          `${name}/${slot}`,
        ).toBeGreaterThanOrEqual(CONTRAST_SECONDARY)
        expect(contrastRatio(ink, fill), `${name}/${slot}`).toBeGreaterThanOrEqual(CONTRAST_BODY)
      }
    }
  })
})

describe('workspaceInitial', () => {
  it('is the first character, upper-cased, for the rail chip', () => {
    expect(workspaceInitial('c3')).toBe('C')
    expect(workspaceInitial('  sequencestream')).toBe('S')
    expect(workspaceInitial('工作区')).toBe('工')
  })

  it('keeps a surrogate pair whole instead of splitting the emoji', () => {
    expect(workspaceInitial('🚀 lab')).toBe('🚀')
  })

  it('is null when there is no workspace to letter', () => {
    expect(workspaceInitial(null)).toBeNull()
    expect(workspaceInitial('')).toBeNull()
  })
})
