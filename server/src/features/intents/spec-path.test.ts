/**
 * Unit tests for the spec path layout — slug derivation (incl. the id fallback),
 * the per-day sequence scan, and the assembled `<specPath>/yyyy/mm/dd/...` paths.
 * All pure: the only fs dependency (`listDay`) is injected.
 */
import { describe, it, expect } from 'vitest'
import { computeSpecLayout, nextSeq, slugify, specSlug } from './spec-path.js'

describe('slugify', () => {
  it('lowercases, replaces non-alnum runs with one hyphen, trims', () => {
    expect(slugify('Add Login Flow')).toBe('add-login-flow')
    expect(slugify('  Foo / Bar __ Baz!! ')).toBe('foo-bar-baz')
  })
  it('returns empty for null / blank / all-non-ascii', () => {
    expect(slugify(null)).toBe('')
    expect(slugify('   ')).toBe('')
    expect(slugify('登录流程')).toBe('')
  })
})

describe('specSlug — id fallback', () => {
  it('uses the slugged short title when present', () => {
    expect(specSlug('User Auth', 'abc')).toBe('user-auth')
  })
  it('falls back to the intent id prefix (sanitised, capped) when the title is empty', () => {
    // A UUID's hyphens are stripped so they never break the NNN-slug parse.
    expect(specSlug(null, '7cf40c48-3ef9-4d72')).toBe('7cf40c48')
    expect(specSlug('登录', 'A1B2C3D4E5F6')).toBe('a1b2c3d4')
  })
})

describe('nextSeq', () => {
  it('returns 001 for an empty / absent day directory', () => {
    expect(nextSeq([], '2026-06-18')).toBe('001')
  })
  it('returns max existing + 1, ignoring non-matching names', () => {
    const names = [
      '2026-06-18-001-foo',
      '2026-06-18-003-bar',
      '2026-06-18-002-baz',
      'README.md', // ignored
      '2026-06-17-009-other-day', // ignored (different date prefix)
    ]
    expect(nextSeq(names, '2026-06-18')).toBe('004')
  })
})

describe('computeSpecLayout', () => {
  const now = new Date(2026, 5, 18) // 2026-06-18 (month is 0-based)

  it('assembles the dated dir + spec.md (abs + workspace-relative)', () => {
    const layout = computeSpecLayout({
      workspacePath: '/proj',
      specPath: '.specs',
      shortEnTitle: 'Add Login',
      intentId: 'id-1',
      now,
      listDay: () => [],
    })
    expect(layout.dirName).toBe('2026-06-18-001-add-login')
    expect(layout.fileRel).toBe('.specs/2026/06/18/2026-06-18-001-add-login/spec.md')
    expect(layout.fileAbs).toBe('/proj/.specs/2026/06/18/2026-06-18-001-add-login/spec.md')
    expect(layout.dirAbs).toBe('/proj/.specs/2026/06/18/2026-06-18-001-add-login')
  })

  it('increments NNN against existing same-day dirs', () => {
    const layout = computeSpecLayout({
      workspacePath: '/proj',
      specPath: '.specs',
      shortEnTitle: 'Second',
      intentId: 'id-2',
      now,
      listDay: () => ['2026-06-18-001-add-login'],
    })
    expect(layout.dirName).toBe('2026-06-18-002-second')
  })

  it('falls back to the id prefix when shortEnTitle is empty (no throw)', () => {
    const layout = computeSpecLayout({
      workspacePath: '/proj',
      specPath: '.specs',
      shortEnTitle: null,
      intentId: 'deadbeef-cafe',
      now,
      listDay: () => [],
    })
    expect(layout.dirName).toBe('2026-06-18-001-deadbeef')
  })
})
