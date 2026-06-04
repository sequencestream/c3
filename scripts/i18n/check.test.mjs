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
  checkPlaceholderNames,
} from './check.mjs'
import { checkFreeze } from './check-freeze.mjs'
import { hash } from './freeze.mjs'

describe('flatten', () => {
  it('flattens nested objects into dot-joined leaf keys', () => {
    expect(flatten({ a: { b: 'x' }, c: 'y' })).toEqual({ 'a.b': 'x', c: 'y' })
  })
  it('treats empty object as no keys', () => {
    expect(flatten({})).toEqual({})
  })
  it('skips top-level `__*__` metadata keys (e.g. `__humanReviewed__`)', () => {
    // Meta keys are file-level flags, not translations. Surfacing them as leaf
    // keys would flag every locale file as `[extra]` against the base.
    const out = flatten({ __humanReviewed__: true, common: { ok: 'OK' } })
    expect(out).toEqual({ 'common.ok': 'OK' })
    expect(out).not.toHaveProperty('__humanReviewed__')
  })
  it('does NOT skip nested `__*__` keys (only top-level is metadata)', () => {
    // A nested `__foo__` is a real key, just unusually named. The meta
    // convention is scoped to the file's top level.
    const out = flatten({ a: { __foo__: 'x' } })
    expect(out).toEqual({ 'a.__foo__': 'x' })
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
  it('counts 3+ pipe branches correctly', () => {
    // Edge: more than the 2-branch case in the simple "1 vs other" plural.
    // Some locales (e.g. Arabic) use 6 branches; the brace counter must not
    // miscount `|` inside ICU sub-blocks.
    const { pluralBranches } = extractTokens('zero | one | two | few | many | other')
    expect(pluralBranches).toBe(6)
  })
  it('keeps a multi-branch nested ICU plural as ONE outer token', () => {
    // A whole ICU plural block at the top level counts as a single placeholder
    // token (its inner pipes are NOT a top-level branch count).
    const { placeholders, pluralBranches } = extractTokens(
      '{n, plural, =0 {none} =1 {one} other {many}}',
    )
    expect(placeholders).toHaveLength(1)
    expect(placeholders[0]).toMatch(/^\{n, plural,/)
    expect(pluralBranches).toBe(1)
  })
  it('handles list placeholders like {0} and {1}', () => {
    // vue-i18n list mode uses positional {0}, {1}; verify they are tokenized.
    const { placeholders } = extractTokens('{0} and {1}')
    expect(placeholders).toEqual(['{0}', '{1}'])
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
  it('allows differing plural-branch counts when base is plural (CLDR per-locale)', () => {
    // Plural cardinality is language-specific: en=2, ru=3, zh/ja/ko=1. A plural base
    // must NOT force the target to the same branch count.
    expect(comparePlaceholders('a | b | c', 'a | b').ok).toBe(true)
    expect(comparePlaceholders('one item | {count} items', '{count} 项').ok).toBe(true) // en→zh (1 branch)
    expect(
      comparePlaceholders('one item | {count} items', '{count} a | {count} b | {count} c').ok, // en→ru (3 branches)
    ).toBe(true)
  })
  it('catches a stray pipe added to a NON-plural base key', () => {
    // Base has no plural; a target sneaking in a `|` is still an error.
    expect(comparePlaceholders('just text', 'just | text').ok).toBe(false)
  })
  it('catches a real (non-counter) placeholder dropped from a plural message', () => {
    // {count}/{n} are excluded as per-branch counters, but {name} must survive.
    expect(comparePlaceholders('one {name} | {count} {name}s', '{count} items').ok).toBe(false)
  })
  it('passes a 3+ plural branch in both base and target', () => {
    expect(comparePlaceholders('a | b | c | d', 'A | B | C | D').ok).toBe(true)
  })
  it('FLAGS translating text INSIDE an ICU block (known checker limitation)', () => {
    // The whole ICU block is captured as ONE token and compared verbatim, so any
    // change to its inner sub-messages (incl. legitimate translation) trips the
    // check. en.json currently has NO ICU plural/select blocks, so this is moot
    // for the ja/ko milestone — but if ICU is introduced later, inner text can't
    // be translated through this gate as-is. Documented in the spec's risk table.
    const base = '{n, plural, =0 {none} =1 {one} other {many}}'
    const tgt = '{n, plural, =0 {ゼロ} =1 {一} other {多}}'
    expect(comparePlaceholders(base, tgt).ok).toBe(false)
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

describe('checkPlaceholderNames', () => {
  it('passes whitelisted lowerCamel names', () => {
    const w = checkPlaceholderNames({ a: 'Hi {name}, {userCount} left' }, {}, null)
    expect(w).toEqual([])
  })
  it('passes positional list placeholders {0} {1}', () => {
    const w = checkPlaceholderNames({ a: '{0} of {1}' }, {}, null)
    expect(w).toEqual([])
  })
  it('warns on a capitalized / off-baseline placeholder name', () => {
    const w = checkPlaceholderNames({ a: 'Hi {Name}' }, {}, null)
    expect(w).toHaveLength(1)
    expect(w[0]).toMatch(/\[placeholder-name\]/)
    expect(w[0]).toContain("'Name'")
  })
  it('does NOT warn on ICU blocks (not a bare identifier)', () => {
    const w = checkPlaceholderNames({ a: '{count, plural, one {#} other {#}}' }, {}, null)
    expect(w).toEqual([])
  })
  it('scans the target locale too when given', () => {
    const w = checkPlaceholderNames({}, { a: 'Hola {Nombre}' }, 'es')
    expect(w.some((x) => x.includes("locale 'es'") && x.includes("'Nombre'"))).toBe(true)
  })
})

describe('Cyrillic (ru) placeholder integrity', () => {
  // M3: ru is the first Cyrillic locale. Placeholder names stay ASCII even when
  // the surrounding text is Cyrillic — these assertions pin that the integrity
  // gate is script-agnostic (the {name} token survives, a Cyrillicized name is
  // caught, and Cyrillic body text does not trip the ASCII name whitelist).
  it('preserves an ASCII placeholder inside Cyrillic text', () => {
    expect(comparePlaceholders('Open chat: {title}', 'Открыть чат: {title}').ok).toBe(true)
  })
  it('catches a placeholder accidentally Cyrillicized (renamed)', () => {
    // {title} -> {заголовок}: the token multiset diverges, so it must fail.
    expect(comparePlaceholders('Open chat: {title}', 'Открыть чат: {заголовок}').ok).toBe(false)
  })
  it('does NOT warn on Cyrillic body text with ASCII placeholder names', () => {
    const w = checkPlaceholderNames({}, { a: 'Завершено {count} из {total}' }, 'ru')
    expect(w).toEqual([])
  })
  it('runCheck: a Cyrillic target with intact placeholders has no errors', () => {
    const base = { greet: 'Hi {name}', done: 'Completed {count}' }
    const ru = { greet: 'Привет, {name}', done: 'Завершено {count}' }
    const { errors } = runCheck({ locales: { en: base, ru } })
    expect(errors).toEqual([])
  })
  it('runCheck: a Cyrillicized placeholder in ru is a [placeholder] error', () => {
    const base = { greet: 'Hi {name}' }
    const ru = { greet: 'Привет, {имя}' }
    const { errors } = runCheck({ locales: { en: base, ru } })
    expect(errors.some((e) => e.startsWith('[placeholder]') && e.includes('greet'))).toBe(true)
  })
})

describe('checkFreeze', () => {
  const en = '{"common":{"ok":"OK"}}'
  it('warns (not errors) when there is no manifest', () => {
    const { ok, errors, warnings } = checkFreeze(null, en)
    expect(ok).toBe(true)
    expect(errors).toEqual([])
    expect(warnings.some((w) => w.startsWith('[freeze]'))).toBe(true)
  })
  it('passes when the hash matches', () => {
    const { ok, errors } = checkFreeze({ hash: hash(en) }, en)
    expect(ok).toBe(true)
    expect(errors).toEqual([])
  })
  it('errors when en.json has drifted from the manifest hash', () => {
    const { ok, errors } = checkFreeze({ hash: hash(en) }, en + ' ')
    expect(ok).toBe(false)
    expect(errors.some((e) => e.includes('drifted from freeze manifest'))).toBe(true)
  })
  it('errors when manifest present but en content unavailable', () => {
    const { ok, errors } = checkFreeze({ hash: 'abc' }, null)
    expect(ok).toBe(false)
    expect(errors.some((e) => e.includes('content unavailable'))).toBe(true)
  })
})
