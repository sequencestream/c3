/**
 * Migration test for the v13 → v14 additive `intents.pr_url` column (MSC-R5).
 *
 * A legacy db whose `intents` table predates `pr_url` must converge on the new
 * schema when the store next initializes: the column is added idempotently
 * (PRAGMA-guarded `ensureColumn`), historic rows default to NULL, no data is
 * lost, and re-running the init is a no-op. Seeding is raw SQL on the live
 * connection; `resetStoreForTests()` re-arms the once-only schema-ensure so the
 * next store call runs the migration path.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../state.js', () => ({
  pathToId: vi.fn(() => 'ws-prurl-id'),
}))
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getDb, resetDbForTests, type Db } from '../../kernel/infra/db.js'
import { getIntent, resetStoreForTests } from './store.js'

const proj = '/abs/workspace-prurl'
let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'c3-prurl-'))
  process.env.C3_DB_PATH = join(dir, 'c3.db')
  resetDbForTests()
  resetStoreForTests()
})

afterEach(() => {
  resetDbForTests()
  delete process.env.C3_DB_PATH
  rmSync(dir, { recursive: true, force: true })
})

function cols(raw: Db, table: string): string[] {
  return raw.all<{ name: string }>(`PRAGMA table_info(${table})`).map((c) => c.name)
}
function userVersion(raw: Db): number {
  return raw.get<{ user_version: number }>('PRAGMA user_version')?.user_version ?? -1
}

/** Build a legacy intents table with every v13 column EXCEPT pr_url, plus one row. */
function seedLegacy(raw: Db): void {
  raw.exec(`
    CREATE TABLE intents (
      id TEXT PRIMARY KEY, workspace_path TEXT NOT NULL, title TEXT NOT NULL,
      short_en_title TEXT, content TEXT NOT NULL, priority TEXT NOT NULL,
      status TEXT NOT NULL, module TEXT NOT NULL DEFAULT '', last_dev_session_id TEXT,
      automate INTEGER NOT NULL DEFAULT 0, branch_name TEXT, latest_commit_hash TEXT,
      pr_id TEXT, pr_status TEXT, spec_path TEXT, spec_approved INTEGER NOT NULL DEFAULT 0,
      spec_approve_user TEXT, spec_session_id TEXT, intent_session_id TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, completed_at INTEGER
    );
  `)
  raw.run(
    `INSERT INTO intents (id, workspace_path, title, content, priority, status, pr_id, pr_status, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    'hist-1',
    proj,
    'Historic',
    'old content',
    'P1',
    'in_progress',
    '99',
    'reviewing',
    1,
    1,
  )
}

describe('intents v13 → v14 pr_url migration', () => {
  it('adds pr_url to a legacy table; historic rows read back null; existing data preserved', () => {
    const raw = getDb()!
    seedLegacy(raw)
    expect(cols(raw, 'intents')).not.toContain('pr_url')

    // Re-arm the once-only ensure so the next store call runs ensureColumn.
    resetStoreForTests()
    const got = getIntent('hist-1')

    expect(cols(raw, 'intents')).toContain('pr_url')
    expect(got?.prUrl).toBeNull() // historic row defaults to null
    expect(got?.prId).toBe('99') // pre-existing data preserved
    expect(got?.prStatus).toBe('reviewing')
    expect(userVersion(raw)).toBe(15)
  })

  it('is idempotent — re-init does not duplicate the column or throw', () => {
    const raw = getDb()!
    seedLegacy(raw)

    resetStoreForTests()
    getIntent('hist-1') // first init adds the column
    resetStoreForTests()
    expect(() => getIntent('hist-1')).not.toThrow() // second init is a no-op

    expect(cols(raw, 'intents').filter((c) => c === 'pr_url')).toHaveLength(1)
    expect(userVersion(raw)).toBe(15)
  })
})
