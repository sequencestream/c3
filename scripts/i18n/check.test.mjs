import { describe, it, expect } from 'vitest'
import {
  flatten,
  extractTokens,
  comparePlaceholders,
  diffKeys,
  scanCodeKeys,
  runCheck,
  scanServerCodes,
  runCodeCheck,
} from './check.mjs'

describe('flatten', () => {
  it('flattens nested objects into dot-joined leaf keys', () => {
    expect(flatten({ a: { b: 'x' }, c: 'y' })).toEqual({ 'a.b': 'x', c: 'y' })
  })
  it('treats empty object as no keys', () => {
    expect(flatten({})).toEqual({})
  })
})

describe('extractTokens', () => {
  it('extracts named placeholders', () => {
    expect(extractTokens('Hello {name}, {count} left').placeholders).toEqual(['{name}', '{count}'])
  })
  it('counts pipe plural branches at top level', () => {
    expect(extractTokens('no items | one item | {count} items').pluralBranches).toBe(3)
  })
  it('keeps a nested ICU block as one token and ignores its inner pipes/braces', () => {
    const { placeholders, pluralBranches } = extractTokens(
      '{count, plural, one {# item} other {# items}}',
    )
    expect(placeholders).toEqual(['{count, plural, one {# item} other {# items}}'])
    expect(pluralBranches).toBe(1)
  })
})

describe('comparePlaceholders', () => {
  it('passes when placeholders + plural branches match', () => {
    expect(comparePlaceholders('{n} files', '{n} fichiers').ok).toBe(true)
  })
  it('fails when a placeholder is renamed', () => {
    expect(comparePlaceholders('{name}', '{naam}').ok).toBe(false)
  })
  it('fails when a placeholder is dropped', () => {
    expect(comparePlaceholders('{a} {b}', '{a}').ok).toBe(false)
  })
  it('fails when plural-branch count changes', () => {
    expect(comparePlaceholders('a | b | c', 'a | b').ok).toBe(false)
  })
})

describe('diffKeys', () => {
  it('reports missing and extra keys', () => {
    expect(diffKeys({ a: 1, b: 2 }, { a: 1, c: 3 })).toEqual({ missing: ['b'], extra: ['c'] })
  })
})

describe('scanCodeKeys', () => {
  it('captures literal t / $t / .t keys', () => {
    const { literal } = scanCodeKeys([
      { file: 'a.vue', content: `t('common.a')\n$t("nav.b")\nfoo.t('session.c')` },
    ])
    expect(literal.map((l) => l.key).sort()).toEqual(['common.a', 'nav.b', 'session.c'])
  })
  it('does not match identifiers ending in t', () => {
    const { literal, dynamic } = scanCodeKeys([
      { file: 'a.ts', content: `count('x'); format('y')` },
    ])
    expect(literal).toEqual([])
    expect(dynamic).toEqual([])
  })
  it('flags dynamic keys', () => {
    const { literal, dynamic } = scanCodeKeys([{ file: 'a.ts', content: `t(key)\nt(\`x\${y}\`)` }])
    expect(literal).toEqual([])
    expect(dynamic.length).toBe(2)
  })
})

describe('runCheck', () => {
  const base = { common: { ok: 'OK' }, greet: 'Hi {name}' }

  it('empty en.json with no code is green', () => {
    const { errors, warnings } = runCheck({ locales: { en: {} }, codeFiles: [] })
    expect(errors).toEqual([])
    expect(warnings).toEqual([])
  })

  it('missing key in a target locale is an error', () => {
    const { errors } = runCheck({ locales: { en: base, fr: { greet: 'Salut {name}' } } })
    expect(errors.some((e) => e.startsWith('[coverage]') && e.includes('common.ok'))).toBe(true)
  })

  it('extra key in a target locale is a warning, not an error', () => {
    const fr = { common: { ok: 'OK' }, greet: 'Salut {name}', orphan: 'x' }
    const { errors, warnings } = runCheck({ locales: { en: base, fr } })
    expect(errors).toEqual([])
    expect(warnings.some((w) => w.startsWith('[extra]') && w.includes('orphan'))).toBe(true)
  })

  it('tampered placeholder in a target locale is an error', () => {
    const fr = { common: { ok: 'OK' }, greet: 'Salut {nom}' }
    const { errors } = runCheck({ locales: { en: base, fr } })
    expect(errors.some((e) => e.startsWith('[placeholder]') && e.includes('greet'))).toBe(true)
  })

  it('code references a non-existent key -> error', () => {
    const { errors } = runCheck({
      locales: { en: base },
      codeFiles: [{ file: 'x.vue', content: `t('common.ok')\nt('nope.missing')` }],
    })
    expect(errors.some((e) => e.startsWith('[code->key]') && e.includes('nope.missing'))).toBe(true)
    expect(errors.some((e) => e.includes('common.ok'))).toBe(false)
  })

  it('unused base key -> warning only', () => {
    const { errors, warnings } = runCheck({
      locales: { en: base },
      codeFiles: [{ file: 'x.vue', content: `t('common.ok')` }],
    })
    expect(errors).toEqual([])
    expect(warnings.some((w) => w.startsWith('[unused]') && w.includes('greet'))).toBe(true)
  })

  it('fully consistent input -> no errors', () => {
    const fr = { common: { ok: 'Oui' }, greet: 'Salut {name}' }
    const { errors } = runCheck({
      locales: { en: base, fr },
      codeFiles: [{ file: 'x.vue', content: `t('common.ok')\nt('greet')` }],
    })
    expect(errors).toEqual([])
  })
})

describe('scanServerCodes', () => {
  it("captures error: { code: '...' } literals with line numbers", () => {
    const sites = scanServerCodes([
      {
        file: 'server.ts',
        content:
          `send(ws, { type: 'error', error: { code: 'requirement.notFound' } })\n` +
          `send(ws, { type: 'error', error: { code: 'session.listFailed', params: { detail } } })`,
      },
    ])
    expect(sites.map((s) => s.code)).toEqual(['requirement.notFound', 'session.listFailed'])
    expect(sites[1].line).toBe(2)
  })
  it('ignores raw `message` error sends (no code)', () => {
    expect(scanServerCodes([{ file: 'a.ts', content: `{ type: 'error', message: 'x' }` }])).toEqual(
      [],
    )
  })
})

describe('runCodeCheck', () => {
  const base = flatten({
    error: {
      requirement: { notFound: 'Requirement not found.' },
      session: { listFailed: 'Failed: {detail}' },
    },
  })
  const uiCodes = {
    'requirement.notFound': { key: 'error.requirement.notFound' },
    'session.listFailed': { key: 'error.session.listFailed', params: ['detail'] },
  }

  it('passes when SoT keys exist and params match placeholders', () => {
    const { errors } = runCodeCheck({
      uiCodes,
      base,
      serverCodeSites: [{ file: 's', code: 'requirement.notFound', line: 1 }],
    })
    expect(errors).toEqual([])
  })
  it('errors when a code maps to a key missing from en.json', () => {
    const { errors } = runCodeCheck({ uiCodes: { 'x.y': { key: 'error.x.y' } }, base })
    expect(
      errors.some((e) => e.startsWith('[code->locale]') && e.includes("'error.x.y' not in")),
    ).toBe(true)
  })
  it('errors when declared params diverge from key placeholders', () => {
    const { errors } = runCodeCheck({
      uiCodes: { 'session.listFailed': { key: 'error.session.listFailed', params: ['oops'] } },
      base,
    })
    expect(errors.some((e) => e.includes('diverge from key'))).toBe(true)
  })
  it('errors when server emits a code not in the SoT', () => {
    const { errors } = runCodeCheck({
      uiCodes,
      base,
      serverCodeSites: [{ file: 's', code: 'ghost.code', line: 9 }],
    })
    expect(errors.some((e) => e.includes("emits code 'ghost.code' not in"))).toBe(true)
  })
  it('warns (not errors) when a SoT code is never emitted by the server', () => {
    const { errors, warnings } = runCodeCheck({ uiCodes, base, serverCodeSites: [] })
    expect(errors).toEqual([])
    expect(warnings.some((w) => w.startsWith('[unused-code]'))).toBe(true)
  })
})
