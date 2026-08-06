/**
 * Migration test for the v17 → v18 additive `intents.spec_status` column.
 *
 * A legacy db whose `intents` table predates `spec_status` must converge on the
 * new schema when the store next initializes: the constrained, non-null column is
 * added idempotently (PRAGMA-guarded `ensureColumn`), then backfilled ONCE from
 * the only facts a historic row still has. The three classes map conservatively:
 *
 *   spec_approved=1                          → approved
 *   spec_approved=0 AND spec_path IS NOT NULL → pending
 *   otherwise                                 → raw
 *
 * The backfill runs exactly at the moment the column appears, so a restart can
 * never overwrite a status a newer write has since set. Seeding is raw SQL on the
 * live connection; `resetStoreForTests()` re-arms the once-only schema-ensure.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getDb, resetDbForTests, type Db } from '../../kernel/infra/db.js'
import { approveSpecIfPending, getIntent, resetStoreForTests } from './store.js'

const proj = '/abs/workspace-spec-status'
let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'c3-spec-status-'))
  process.env.C3_DB_PATH = join(dir, 'c3.db')
  resetDbForTests()
  resetStoreForTests()
})

afterEach(() => {
  resetDbForTests()
  delete process.env.C3_DB_PATH
  rmSync(dir, { recursive: true, force: true })
})

function userVersion(raw: Db): number {
  return raw.get<{ user_version: number }>('PRAGMA user_version')?.user_version ?? -1
}

/** The full v17 intents schema — every column EXCEPT spec_status. */
const V17_INTENTS = `
  CREATE TABLE intents (
    id TEXT PRIMARY KEY, workspace_path TEXT NOT NULL, title TEXT NOT NULL,
    short_en_title TEXT, content TEXT NOT NULL, priority TEXT NOT NULL,
    status TEXT NOT NULL, module TEXT NOT NULL DEFAULT '', last_work_session_id TEXT,
    automate INTEGER NOT NULL DEFAULT 0, branch_name TEXT, latest_commit_hash TEXT,
    pr_id TEXT, pr_status TEXT, pr_url TEXT, spec_path TEXT,
    spec_approved INTEGER NOT NULL DEFAULT 0, spec_approve_user TEXT,
    spec_session_id TEXT, spec_review_session_id TEXT, spec_review_verdict TEXT,
    spec_review_reason TEXT, spec_review_at INTEGER, spec_review_fingerprint TEXT,
    spec_review_rework_rounds INTEGER NOT NULL DEFAULT 0,
    spec_review_machine_blocked INTEGER NOT NULL DEFAULT 0, intent_session_id TEXT,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, completed_at INTEGER
  );
`

function seedRow(raw: Db, id: string, specPath: string | null, specApproved: number): void {
  raw.run(
    `INSERT INTO intents
       (id, workspace_path, title, content, priority, status, module, spec_path, spec_approved, spec_approve_user, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    id,
    proj,
    `Intent ${id}`,
    'body',
    'P1',
    'todo',
    '',
    specPath,
    specApproved,
    specApproved === 1 ? 'alice' : null,
    1,
    1,
  )
}

describe('intents v17 → v18 spec_status migration', () => {
  it('adds a constrained non-null column defaulting to raw and backfills the three historic classes', () => {
    const raw = getDb()!
    raw.exec(V17_INTENTS)
    raw.exec('PRAGMA user_version=17;')
    // 1) approved, 2) written-but-unapproved (path + no approval), 3) never written.
    seedRow(raw, 'approved', '/s/a.md', 1)
    seedRow(raw, 'written', '/s/w.md', 0)
    seedRow(raw, 'bare', null, 0)

    const specCol = (): { notnull: number; dflt_value: string | null }[] =>
      raw
        .all<{ name: string; notnull: number; dflt_value: string | null }>(
          'PRAGMA table_info(intents)',
        )
        .filter((c) => c.name === 'spec_status')
    expect(specCol()).toHaveLength(0)

    resetStoreForTests()
    expect(getIntent('approved')?.specStatus).toBe('approved')
    expect(getIntent('written')?.specStatus).toBe('pending')
    expect(getIntent('bare')?.specStatus).toBe('raw')

    const after = specCol()
    expect(after).toHaveLength(1)
    expect(after[0].notnull).toBe(1)
    expect(after[0].dflt_value).toMatch(/raw/)
    expect(userVersion(raw)).toBe(19)

    // Compatibility fields were left alone by the backfill.
    expect(getIntent('approved')?.specApproveUser).toBe('alice')
    expect(getIntent('approved')?.specApproved).toBe(true)
    expect(getIntent('written')?.specPath).toBe('/s/w.md')
    expect(getIntent('written')?.specApproved).toBe(false)
  })

  it('does not overwrite a status set after the migration on a later restart', () => {
    const raw = getDb()!
    raw.exec(V17_INTENTS)
    seedRow(raw, 'written', '/s/w.md', 0)
    resetStoreForTests()
    // First init backfilled the legacy row to pending.
    expect(getIntent('written')?.specStatus).toBe('pending')

    // A newer write moves it to approved — and a restart must not reset it back.
    approveSpecIfPending('written', 'bob')
    expect(getIntent('written')?.specStatus).toBe('approved')

    resetStoreForTests()
    expect(getIntent('written')?.specStatus).toBe('approved')
    expect(getIntent('written')?.specApproved).toBe(true)
  })

  it('re-running the ensure is a no-op and keeps every status', () => {
    const raw = getDb()!
    raw.exec(V17_INTENTS)
    seedRow(raw, 'approved', '/s/a.md', 1)
    seedRow(raw, 'bare', null, 0)
    resetStoreForTests()
    getIntent('bare') // first init

    resetStoreForTests()
    getIntent('approved') // second init — must not re-add or re-run anything destructive
    expect(getIntent('approved')?.specStatus).toBe('approved')
    expect(getIntent('bare')?.specStatus).toBe('raw')
    expect(userVersion(raw)).toBe(19)
  })
})
