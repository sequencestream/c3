/**
 * Business-logic tests for the shared, framing-free WorkNote tool cores
 * `runAppendWorknote` / `runListWorknotes`, driven DIRECTLY (no MCP wrapper).
 * These back both surfaces that expose `append_intent_worknote` /
 * `list_intent_worknotes` (the work-session HTTP MCP route and the
 * unattended-automation c3 tool set), so the coverage is kept once here:
 *  - a successful append returns the stored record; a successful list returns
 *    the newest-first array (empty when no notes match);
 *  - the closed `kind` enum and 1–200 limit are re-validated at the core even
 *    when the transport's zod layer is bypassed;
 *  - an unknown or a cross-workspace id reads as a friendly not-found (no leak);
 *  - a store failure surfaces as `isError` text rather than a receipt.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IntentWorknoteKind } from '@ccc/shared/protocol'
// Stub only the registry id↔path mapping (identity): synthetic test workspaces
// are unregistered, so resolve/pathToName/workspaceNameFor would otherwise return
// null. This makes `findOwnedIntent`'s cross-workspace guard resolve predictably.
vi.mock('../../state.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../state.js')>()),
  resolveWorkspaceRoot: (id: string) => id,
  pathToName: (p: string) => p,
  workspaceNameFor: (value: string) => value,
}))
import { resetDbForTests } from '../../kernel/infra/db.js'
import { insertIntents, resetStoreForTests } from './store.js'
import {
  runAppendWorknote,
  runListWorknotes,
  type WorknoteToolResult,
} from './worknote-tool-defs.js'

const proj = '/abs/worknote-tools-proj'
const otherProj = '/abs/worknote-tools-other'
let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'c3-worknote-tools-'))
  process.env.C3_DB_PATH = join(dir, 'c3.db')
  resetDbForTests()
  resetStoreForTests()
})

afterEach(() => {
  resetDbForTests()
  delete process.env.C3_DB_PATH
  rmSync(dir, { recursive: true, force: true })
})

function seedIntent(workspace = proj): string {
  const [intent] = insertIntents(workspace, [
    { title: '目标意图', shortEnTitle: 'auto', content: '正文', priority: 'P1' },
  ])
  return intent.id
}

/** Success result: assert !isError and return the parsed JSON (object or array). */
function payload(r: WorknoteToolResult): Record<string, unknown> | unknown[] {
  expect(r.isError).toBeFalsy()
  return JSON.parse(r.content[0].text) as Record<string, unknown> | unknown[]
}

function errorText(r: WorknoteToolResult): string {
  expect(r.isError).toBe(true)
  return r.content[0].text
}

/** A not-found result is a friendly prompt, NOT an error. */
function notFoundText(r: WorknoteToolResult): string {
  expect(r.isError).toBeFalsy()
  return r.content[0].text
}

describe('append_intent_worknote core', () => {
  it('returns the stored record as JSON', () => {
    const id = seedIntent()
    const out = payload(runAppendWorknote(proj, { intentId: id, kind: 'work', note: '开发总结' }))
    expect(out).toMatchObject({
      intentId: id,
      kind: 'work',
      note: '开发总结',
      sessionId: null,
    })
    expect((out as Record<string, unknown>).id).toBeTruthy()
    expect(typeof (out as Record<string, unknown>).createdAt).toBe('number')
  })

  it('carries a model-supplied sessionId verbatim', () => {
    const id = seedIntent()
    const out = payload(
      runAppendWorknote(proj, { intentId: id, kind: 'review', note: '评审', sessionId: 'sess-9' }),
    )
    expect(out).toMatchObject({ sessionId: 'sess-9' })
  })

  it('re-validates the closed kind enum even without the transport layer', () => {
    const id = seedIntent()
    expect(
      errorText(
        runAppendWorknote(proj, { intentId: id, kind: 'bogus' as IntentWorknoteKind, note: 'x' }),
      ),
    ).toContain('非法 worknote kind')
  })

  it('rejects a blank body', () => {
    const id = seedIntent()
    expect(
      errorText(runAppendWorknote(proj, { intentId: id, kind: 'work', note: '   ' })),
    ).toContain('空白')
  })

  it('reads an unknown id as a friendly not-found (no error)', () => {
    const text = notFoundText(
      runAppendWorknote(proj, { intentId: 'nope', kind: 'work', note: 'x' }),
    )
    expect(text).toContain('未找到')
    expect(text).toContain('nope')
  })

  it('refuses an id from another workspace (not found, no leak)', () => {
    const other = seedIntent(otherProj)
    const text = notFoundText(runAppendWorknote(proj, { intentId: other, kind: 'work', note: 'x' }))
    expect(text).toContain('未找到')
    expect(text).not.toContain('目标意图')
  })
})

describe('list_intent_worknotes core', () => {
  it('returns a newest-first array, empty when no notes match', () => {
    const id = seedIntent()
    expect(payload(runListWorknotes(proj, { intentId: id }))).toEqual([])
    runAppendWorknote(proj, { intentId: id, kind: 'work', note: '第一条' })
    runAppendWorknote(proj, { intentId: id, kind: 'fix', note: '第二条' })
    const rows = payload(runListWorknotes(proj, { intentId: id })) as Array<{ note: string }>
    expect(rows.map((r) => r.note)).toEqual(['第二条', '第一条'])
  })

  it('applies the kind filter and limit', () => {
    const id = seedIntent()
    runAppendWorknote(proj, { intentId: id, kind: 'work', note: 'w-1' })
    runAppendWorknote(proj, { intentId: id, kind: 'review', note: 'r-1' })
    const rows = payload(runListWorknotes(proj, { intentId: id, kind: 'review' })) as Array<{
      note: string
    }>
    expect(rows.map((r) => r.note)).toEqual(['r-1'])
    expect((payload(runListWorknotes(proj, { intentId: id, limit: 1 })) as unknown[]).length).toBe(
      1,
    )
  })

  it('re-validates an out-of-range limit even without the transport layer', () => {
    const id = seedIntent()
    expect(errorText(runListWorknotes(proj, { intentId: id, limit: 201 }))).toContain('1–200')
  })

  it('reads an unknown id as a friendly not-found (no error)', () => {
    expect(notFoundText(runListWorknotes(proj, { intentId: 'nope' }))).toContain('未找到')
  })

  it('refuses an id from another workspace (not found, no leak)', () => {
    const other = seedIntent(otherProj)
    expect(notFoundText(runListWorknotes(proj, { intentId: other }))).toContain('未找到')
  })
})

describe('store failure surfaces as an error (not a receipt)', () => {
  beforeEach(() => {
    process.env.C3_DB_PATH = '/dev/null/cannot/c3.db'
    resetDbForTests()
    resetStoreForTests()
  })

  it('append and list both report isError with a store-unavailable reason', () => {
    expect(
      errorText(runAppendWorknote(proj, { intentId: 'x', kind: 'work', note: 'x' })),
    ).toContain('不可用')
    expect(errorText(runListWorknotes(proj, { intentId: 'x' }))).toContain('不可用')
  })
})
