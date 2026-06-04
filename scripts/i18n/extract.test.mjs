import { describe, it, expect } from 'vitest'
import {
  TRANSLATABLE_ATTRS,
  isTranslatableText,
  slugify,
  deriveNamespace,
  deriveSubject,
  attrSuffix,
  suggestKey,
  extractFromSfc,
  buildCandidates,
  setDeep,
  mergeIntoLocale,
} from './extract.mjs'

describe('isTranslatableText', () => {
  it('accepts prose with at least one letter', () => {
    expect(isTranslatableText('Save')).toBe(true)
    expect(isTranslatableText('  Open chat  ')).toBe(true)
  })
  it('rejects whitespace / pure punctuation / numbers / symbols', () => {
    expect(isTranslatableText('   ')).toBe(false)
    expect(isTranslatableText('...')).toBe(false)
    expect(isTranslatableText('42')).toBe(false)
    expect(isTranslatableText('⚙')).toBe(false)
    expect(isTranslatableText('')).toBe(false)
    expect(isTranslatableText(null)).toBe(false)
  })
})

describe('slugify', () => {
  it('produces a camelCase slug capped at maxWords', () => {
    expect(slugify('Open the chat window now please', 5)).toBe('openTheChatWindowNow')
    expect(slugify('Open the chat window now please', 4)).toBe('openTheChatWindow')
    expect(slugify('System settings')).toBe('systemSettings')
  })
  it('strips quotes and falls back when empty', () => {
    expect(slugify("don't")).toBe('dont')
    expect(slugify('!!!')).toBe('text')
  })
})

describe('deriveNamespace', () => {
  it('maps known paths to frozen namespaces (no guess)', () => {
    expect(
      deriveNamespace('web/src/pages/sessions/components/SessionList/SessionList.vue'),
    ).toEqual({
      namespace: 'session',
      nsGuess: false,
    })
    expect(
      deriveNamespace('web/src/components/PermissionPrompt/PermissionPrompt.vue').namespace,
    ).toBe('permission')
    expect(
      deriveNamespace('web/src/pages/systemsettings/components/SettingsPanel/SettingsPanel.vue')
        .namespace,
    ).toBe('settings')
    expect(deriveNamespace('web/src/components/AppHeader/AppHeader.vue').namespace).toBe('nav')
  })
  it('falls back to common with nsGuess for unknown paths', () => {
    expect(deriveNamespace('web/src/components/MarkdownText/MarkdownText.vue')).toEqual({
      namespace: 'common',
      nsGuess: true,
    })
  })
})

describe('deriveSubject / attrSuffix', () => {
  it('lowercases the leading char of the component base name', () => {
    expect(deriveSubject('web/src/components/AppHeader/AppHeader.vue')).toBe('appHeader')
  })
  it('maps attributes to UI-role suffixes', () => {
    expect(attrSuffix('title')).toBe('tooltip')
    expect(attrSuffix('placeholder')).toBe('placeholder')
    expect(attrSuffix('aria-label')).toBe('label')
    expect(attrSuffix(null)).toBe(null)
  })
})

describe('suggestKey', () => {
  it('assembles <namespace>.<subject>.<slug>.<suffix>', () => {
    const { key, nsGuess } = suggestKey({
      filePath: 'web/src/components/AppHeader/AppHeader.vue',
      text: 'System settings',
      attr: 'title',
    })
    expect(key).toBe('nav.appHeader.systemSettings.tooltip')
    expect(nsGuess).toBe(false)
  })
  it('omits suffix for plain text and flags guessed namespace', () => {
    const { key, nsGuess } = suggestKey({
      filePath: 'web/src/components/MarkdownText/MarkdownText.vue',
      text: 'No content',
      attr: null,
    })
    expect(key).toBe('common.markdownText.noContent')
    expect(nsGuess).toBe(true)
  })
})

describe('TRANSLATABLE_ATTRS', () => {
  it('includes text-bearing attrs and excludes ARIA state attrs', () => {
    for (const a of ['title', 'placeholder', 'alt', 'aria-label', 'badge'])
      expect(TRANSLATABLE_ATTRS.has(a)).toBe(true)
    for (const a of ['aria-hidden', 'aria-expanded', 'aria-pressed', 'class', 'role']) {
      expect(TRANSLATABLE_ATTRS.has(a)).toBe(false)
    }
  })
})

describe('extractFromSfc', () => {
  const sfc = (tpl) => ({
    file: 'web/src/components/Demo/Demo.vue',
    code: `<template>${tpl}</template>`,
  })

  it('picks up text nodes, whitelisted static attrs, and bound string literals', () => {
    const { candidates } = extractFromSfc(
      sfc(
        `<button title="Open settings" aria-hidden="true">Save</button><i :placeholder="'Type here'" />`,
      ),
    )
    const kinds = candidates.map((c) => `${c.kind}:${c.attr ?? ''}:${c.text}`)
    expect(kinds).toContain('text::Save')
    expect(kinds).toContain('attr:title:Open settings')
    expect(kinds).toContain('bind-literal:placeholder:Type here')
    // aria-hidden is a state attr — never extracted
    expect(kinds.some((k) => k.includes('aria-hidden'))).toBe(false)
  })

  it('skips pure punctuation/number/symbol text', () => {
    const { candidates } = extractFromSfc(sfc(`<span>⚙</span><span>42</span><span>—</span>`))
    expect(candidates).toEqual([])
  })

  it('records dynamic bound attrs without a suggested key', () => {
    const { candidates } = extractFromSfc(sfc(`<input :placeholder="ph" />`))
    expect(candidates).toHaveLength(1)
    expect(candidates[0].kind).toBe('dynamic')
    expect(candidates[0].suggestedKey).toBe(null)
  })

  it('extracts mustache string literals but treats variable mustache as dynamic', () => {
    const lit = extractFromSfc(sfc(`<span>{{ 'Hello' }}</span>`)).candidates
    expect(lit[0].kind).toBe('mustache-literal')
    expect(lit[0].text).toBe('Hello')
    const dyn = extractFromSfc(sfc(`<span>{{ count }}</span>`)).candidates
    expect(dyn).toEqual([])
  })
})

describe('buildCandidates', () => {
  it('dedupes repeated text per file with an occurrences count and sorts files', () => {
    const files = [
      { file: 'web/src/b.vue', code: `<template><span>Zeta</span></template>` },
      { file: 'web/src/a.vue', code: `<template><span>Save</span><span>Save</span></template>` },
    ]
    const report = buildCandidates(files)
    expect(Object.keys(report.byFile)).toEqual(['web/src/a.vue', 'web/src/b.vue'])
    expect(report.byFile['web/src/a.vue']).toHaveLength(1)
    expect(report.byFile['web/src/a.vue'][0].occurrences).toBe(2)
    expect(report.summary.candidates).toBe(2)
  })

  it('is stable across runs (byte-identical JSON)', () => {
    const files = [
      { file: 'web/src/a.vue', code: `<template><button title="Hi">Save</button></template>` },
    ]
    expect(JSON.stringify(buildCandidates(files))).toBe(JSON.stringify(buildCandidates(files)))
  })
})

describe('setDeep / mergeIntoLocale', () => {
  it('expands dotted keys into a nested object', () => {
    const obj = {}
    setDeep(obj, 'a.b.c', 'x')
    expect(obj).toEqual({ a: { b: { c: 'x' } } })
  })
  it('treats identical re-emit as a no-op', () => {
    const obj = { a: { b: 'x' } }
    expect(() => setDeep(obj, 'a.b', 'x')).not.toThrow()
  })
  it('throws on leaf/branch collisions and conflicting values', () => {
    expect(() => setDeep({ a: 'x' }, 'a.b', 'y')).toThrow(/collision/)
    expect(() => setDeep({ a: { b: 'x' } }, 'a', 'y')).toThrow(/collision/)
    expect(() => setDeep({ a: { b: 'x' } }, 'a.b', 'y')).toThrow(/collision/)
  })
  it('merges a flat mapping into a base locale without mutating the input', () => {
    const base = { common: { ok: 'OK' } }
    const merged = mergeIntoLocale(base, { 'common.cancel': 'Cancel', 'nav.home': 'Home' })
    expect(merged).toEqual({ common: { ok: 'OK', cancel: 'Cancel' }, nav: { home: 'Home' } })
    expect(base).toEqual({ common: { ok: 'OK' } })
  })
})
