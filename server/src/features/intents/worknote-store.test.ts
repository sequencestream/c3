/**
 * `intent_worknotes` store layer — schema idempotency, the append-only shape
 * (uuid / ms-epoch / verbatim body / nullable sessionId), the closed `kind`
 * enum + non-blank body + owning-intent-exists validation, per-intent isolation,
 * newest-first ordering (created_at DESC, then rowid DESC for same-ms rows),
 * kind-filter-then-limit semantics, default/boundary limits, cascade delete via
 * both physical delete paths, and the db-unavailable degradation contract
 * (`listIntentWorknotes` → `[]`, `appendIntentWorknote` → throw).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IntentWorknoteKind } from '@ccc/shared/protocol'
// Stub only the registry id↔path mapping (identity): synthetic test workspaces
// are unregistered, so resolve/pathToName/workspaceNameFor would otherwise touch
// the workspace registry or return null. This lets `insertIntents` seed a clean
// intent row under a predictable `workspace_name` for the append/list probes.
vi.mock('../../state.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../state.js')>()),
  resolveWorkspaceRoot: (id: string) => id,
  pathToName: (p: string) => p,
  workspaceNameFor: (value: string) => value,
}))
import { resetDbForTests } from '../../kernel/infra/db.js'
import {
  appendIntentWorknote,
  deleteEmptyDraftIntent,
  deleteIntentRecords,
  getIntent,
  insertIntents,
  listIntentWorknotes,
  resetStoreForTests,
} from './store.js'

const proj = '/abs/worknote-store-proj'
let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'c3-worknote-store-'))
  process.env.C3_DB_PATH = join(dir, 'c3.db')
  resetDbForTests()
  resetStoreForTests()
})

afterEach(() => {
  vi.restoreAllMocks()
  resetDbForTests()
  delete process.env.C3_DB_PATH
  rmSync(dir, { recursive: true, force: true })
})

/** Make Date.now strictly increasing so created_at ordering is deterministic. */
function tickClock(start = 1_000_000): void {
  let now = start
  vi.spyOn(Date, 'now').mockImplementation(() => ++now)
}

function seedIntent(initialStatus: 'draft' | 'todo' = 'todo'): string {
  const [intent] = insertIntents(
    proj,
    [{ title: '目标意图', shortEnTitle: 'auto', content: '正文', priority: 'P1' }],
    initialStatus,
  )
  return intent.id
}

describe('intent_worknotes schema', () => {
  it('re-ensures idempotently on the same db file (no duplicate-table error)', () => {
    const id = seedIntent()
    appendIntentWorknote(id, 'work', '第一次')
    // Re-open the same file: SCHEMA runs again over the existing tables.
    resetDbForTests()
    resetStoreForTests()
    expect(() => appendIntentWorknote(id, 'review', '第二次')).not.toThrow()
    expect(listIntentWorknotes(id)).toHaveLength(2)
  })
})

describe('appendIntentWorknote / listIntentWorknotes', () => {
  it('appends all three kinds and carries the full projection shape', () => {
    const id = seedIntent()
    appendIntentWorknote(id, 'work', '开发总结')
    appendIntentWorknote(id, 'review', '评审发现')
    appendIntentWorknote(id, 'fix', '修复说明')
    const rows = listIntentWorknotes(id)
    expect(rows).toHaveLength(3)
    for (const r of rows) {
      expect(r.id).toBeTruthy()
      expect(r.intentId).toBe(id)
      expect(typeof r.createdAt).toBe('number')
      expect(['work', 'review', 'fix']).toContain(r.kind)
    }
    expect(rows.map((r) => r.kind).sort()).toEqual(['fix', 'review', 'work'])
  })

  it('preserves the body verbatim (leading/trailing whitespace and newlines) and keeps sessionId nullable', () => {
    const id = seedIntent()
    const body = '  前后有空白\n第二行  '
    appendIntentWorknote(id, 'work', body, 'sess-1')
    appendIntentWorknote(id, 'fix', '无会话', null)
    appendIntentWorknote(id, 'review', '也省略会话')
    const rows = listIntentWorknotes(id)
    expect(rows.find((r) => r.kind === 'work')!.note).toBe(body)
    expect(rows.find((r) => r.kind === 'work')!.sessionId).toBe('sess-1')
    expect(rows.find((r) => r.kind === 'fix')!.sessionId).toBeNull()
    expect(rows.find((r) => r.kind === 'review')!.sessionId).toBeNull()
  })

  it('rejects an illegal kind and leaves no row behind', () => {
    const id = seedIntent()
    expect(() => appendIntentWorknote(id, 'bogus' as IntentWorknoteKind, 'x')).toThrow(
      /非法 worknote kind/,
    )
    expect(listIntentWorknotes(id)).toHaveLength(0)
  })

  it('rejects a blank body and leaves no row behind', () => {
    const id = seedIntent()
    expect(() => appendIntentWorknote(id, 'work', '')).toThrow(/空白/)
    expect(() => appendIntentWorknote(id, 'work', '   ')).toThrow(/空白/)
    expect(listIntentWorknotes(id)).toHaveLength(0)
  })

  it('rejects an unknown owning intent and never creates an orphan row', () => {
    expect(() => appendIntentWorknote('no-such-intent', 'work', 'x')).toThrow(/不存在/)
    expect(listIntentWorknotes('no-such-intent')).toEqual([])
  })

  it('keeps different intents isolated', () => {
    const a = seedIntent()
    const b = seedIntent()
    appendIntentWorknote(a, 'work', 'A 的正文')
    appendIntentWorknote(b, 'review', 'B 的正文')
    expect(listIntentWorknotes(a).map((r) => r.note)).toEqual(['A 的正文'])
    expect(listIntentWorknotes(b).map((r) => r.note)).toEqual(['B 的正文'])
  })

  it('returns entries newest-first (created_at DESC)', () => {
    tickClock()
    const id = seedIntent()
    appendIntentWorknote(id, 'work', '第一条')
    appendIntentWorknote(id, 'review', '第二条')
    appendIntentWorknote(id, 'fix', '第三条')
    expect(listIntentWorknotes(id).map((r) => r.note)).toEqual(['第三条', '第二条', '第一条'])
  })

  it('breaks a same-millisecond tie by insertion order (rowid DESC)', () => {
    vi.spyOn(Date, 'now').mockReturnValue(5_000)
    const id = seedIntent()
    appendIntentWorknote(id, 'work', '先插入')
    appendIntentWorknote(id, 'review', '后插入')
    const rows = listIntentWorknotes(id)
    expect(rows).toHaveLength(2)
    expect(rows[0].createdAt).toBe(rows[1].createdAt)
    expect(rows.map((r) => r.note)).toEqual(['后插入', '先插入'])
  })

  it('applies the kind filter before the limit', () => {
    const id = seedIntent()
    appendIntentWorknote(id, 'work', 'w-1')
    appendIntentWorknote(id, 'review', 'r-1')
    appendIntentWorknote(id, 'work', 'w-2')
    expect(listIntentWorknotes(id, 'review').map((r) => r.note)).toEqual(['r-1'])
    // two work notes exist; limit=1 filters to work first, then caps to the newest one
    expect(listIntentWorknotes(id, 'work', 1).map((r) => r.note)).toEqual(['w-2'])
  })

  it('defaults to limit 50 and honors the 1–200 boundary', () => {
    const id = seedIntent()
    for (let i = 0; i < 51; i++) appendIntentWorknote(id, 'work', `note-${i}`)
    expect(listIntentWorknotes(id)).toHaveLength(50)
    expect(listIntentWorknotes(id, undefined, 1)).toHaveLength(1)
    expect(listIntentWorknotes(id, undefined, 200)).toHaveLength(51)
  })

  it('throws (rather than clamps) on an out-of-range limit', () => {
    const id = seedIntent()
    expect(() => listIntentWorknotes(id, undefined, 0)).toThrow(/1–200/)
    expect(() => listIntentWorknotes(id, undefined, 201)).toThrow(/1–200/)
    expect(() => listIntentWorknotes(id, undefined, 1.5)).toThrow(/1–200/)
  })
})

describe('cascade delete', () => {
  it('deleteIntentRecords clears the intent and its worknotes', () => {
    const id = seedIntent()
    appendIntentWorknote(id, 'work', '正文')
    deleteIntentRecords(id)
    expect(getIntent(id)).toBeNull()
    expect(listIntentWorknotes(id)).toEqual([])
  })

  it('deleteEmptyDraftIntent clears a clean draft and its worknotes', () => {
    const id = seedIntent('draft')
    appendIntentWorknote(id, 'work', '草稿正文')
    deleteEmptyDraftIntent(id)
    expect(getIntent(id)).toBeNull()
    expect(listIntentWorknotes(id)).toEqual([])
  })

  it('deleteEmptyDraftIntent refuses an intent with downstream assets', () => {
    const id = seedIntent() // status `todo`, not an empty draft
    appendIntentWorknote(id, 'work', '正文')
    expect(() => deleteEmptyDraftIntent(id)).toThrow()
    expect(getIntent(id)).not.toBeNull()
    expect(listIntentWorknotes(id)).toHaveLength(1)
  })

  it('cascade deletes only the target intent, preserving a sibling intent and its notes', () => {
    const a = seedIntent()
    const b = seedIntent()
    appendIntentWorknote(a, 'work', 'A')
    appendIntentWorknote(b, 'work', 'B')
    deleteIntentRecords(a)
    expect(getIntent(a)).toBeNull()
    expect(listIntentWorknotes(a)).toEqual([])
    expect(getIntent(b)).not.toBeNull()
    expect(listIntentWorknotes(b).map((r) => r.note)).toEqual(['B'])
  })
})

describe('db-unavailable degradation', () => {
  beforeEach(() => {
    process.env.C3_DB_PATH = '/dev/null/broken/c3.db'
    resetDbForTests()
    resetStoreForTests()
  })

  it('listIntentWorknotes returns [] and appendIntentWorknote throws', () => {
    expect(listIntentWorknotes('int-1')).toEqual([])
    expect(() => appendIntentWorknote('int-1', 'work', '正文')).toThrow()
  })
})
