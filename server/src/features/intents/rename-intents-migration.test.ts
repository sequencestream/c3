/**
 * Migration tests for the v5 → v6 in-place rename requirements* → intents*
 * (`migrateLegacyTablesToIntents` in store.ts). Three start points must all
 * converge on the intents* terminal state with NO data loss and NO DROP TABLE,
 * and the migration must be idempotent + re-entrant on a partial-migration db.
 *
 * Seeding is raw SQL on the live connection; `resetStoreForTests()` then re-arms
 * the once-only schema-ensure so the next store call runs the migration path on
 * that same connection (the pattern store.test.ts / module-field.test.ts use).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getDb, resetDbForTests, type Db } from '../../kernel/infra/db.js'
import {
  getChatSession,
  getIntent,
  isHiddenSession,
  listIntents,
  resetStoreForTests,
} from './store.js'

const proj = '/abs/intent-mig'
let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'c3-mig-'))
  process.env.C3_DB_PATH = join(dir, 'c3.db')
  resetDbForTests()
  resetStoreForTests()
})

afterEach(() => {
  resetDbForTests()
  delete process.env.C3_DB_PATH
  rmSync(dir, { recursive: true, force: true })
})

function tables(raw: Db): Set<string> {
  return new Set(
    raw
      .all<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table'")
      .map((r) => r.name),
  )
}
function indexes(raw: Db): Set<string> {
  return new Set(
    raw
      .all<{ name: string }>("SELECT name FROM sqlite_master WHERE type='index'")
      .map((r) => r.name),
  )
}
function cols(raw: Db, table: string): Set<string> {
  return new Set(raw.all<{ name: string }>(`PRAGMA table_info(${table})`).map((c) => c.name))
}
function userVersion(raw: Db): number {
  return raw.get<{ user_version: number }>('PRAGMA user_version')?.user_version ?? -1
}

/** Build a full v5-era legacy db (requirements* tables, requirement_id col, idx_req_*). */
function seedLegacyV5(raw: Db): void {
  raw.exec(`
    CREATE TABLE requirements (
      id TEXT PRIMARY KEY, project_path TEXT NOT NULL, title TEXT NOT NULL,
      content TEXT NOT NULL, priority TEXT NOT NULL, status TEXT NOT NULL,
      module TEXT NOT NULL DEFAULT '', last_dev_session_id TEXT,
      automate INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL, completed_at INTEGER
    );
    CREATE INDEX idx_req_project_status ON requirements(project_path, status);
    CREATE TABLE requirement_deps (
      requirement_id TEXT NOT NULL, depends_on_id TEXT NOT NULL,
      PRIMARY KEY (requirement_id, depends_on_id)
    );
    CREATE TABLE requirement_chats (
      session_id TEXT PRIMARY KEY, project_path TEXT NOT NULL,
      is_current INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE INDEX idx_chat_project ON requirement_chats(project_path);
    PRAGMA user_version=5;
  `)
  raw.run(
    `INSERT INTO requirements
       (id, project_path, title, content, priority, status, module, last_dev_session_id, automate, created_at, updated_at, completed_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    'r1',
    proj,
    'Legacy req',
    'body',
    'P0',
    'todo',
    '认证',
    null,
    0,
    1,
    1,
    null,
  )
  raw.run('INSERT INTO requirement_deps (requirement_id, depends_on_id) VALUES (?,?)', 'r1', 'r0')
  raw.run(
    'INSERT INTO requirement_chats (session_id, project_path, is_current, updated_at) VALUES (?,?,1,?)',
    'chat-1',
    proj,
    1,
  )
}

/** Assert the db reached the intents* terminal state (schema + version). */
function expectTerminalSchema(raw: Db): void {
  const t = tables(raw)
  expect(t.has('intents')).toBe(true)
  expect(t.has('intent_deps')).toBe(true)
  expect(t.has('intent_chats')).toBe(true)
  // Legacy names are gone (renamed away, never left as duplicates) — but NOT dropped:
  // the rename moved them, so no `requirements*` table remains.
  expect(t.has('requirements')).toBe(false)
  expect(t.has('requirement_deps')).toBe(false)
  expect(t.has('requirement_chats')).toBe(false)
  // Column renamed: intent_deps keys on intent_id, no leftover requirement_id.
  expect(cols(raw, 'intent_deps').has('intent_id')).toBe(true)
  expect(cols(raw, 'intent_deps').has('requirement_id')).toBe(false)
  // Index renamed (requirement → intent, then project → workspace at v10→v11).
  const idx = indexes(raw)
  expect(idx.has('idx_intent_workspace_status')).toBe(true)
  expect(idx.has('idx_intent_project_status')).toBe(false)
  expect(idx.has('idx_req_project_status')).toBe(false)
  // v10 → v11 column rename: intents/intent_chats key on workspace_path now.
  expect(cols(raw, 'intents').has('workspace_path')).toBe(true)
  expect(cols(raw, 'intents').has('project_path')).toBe(false)
  expect(cols(raw, 'intent_chats').has('workspace_path')).toBe(true)
  expect(cols(raw, 'intent_chats').has('project_path')).toBe(false)
  // v8: git tracking columns are present.
  const ic = cols(raw, 'intents')
  expect(ic.has('branch_name')).toBe(true)
  expect(ic.has('latest_commit_hash')).toBe(true)
  expect(ic.has('pr_id')).toBe(true)
  expect(ic.has('pr_status')).toBe(true)
  // v9: dep_type + created_at on intent_deps.
  const dc = cols(raw, 'intent_deps')
  expect(dc.has('dep_type')).toBe(true)
  expect(dc.has('created_at')).toBe(true)
  expect(userVersion(raw)).toBe(13)
}

describe('v5 → v6 rename: fresh db starts at the intents terminal state', () => {
  it('a brand-new db is born with intents* tables and version 6', () => {
    // Touch the store so SCHEMA + migration run on an empty db.
    listIntents(proj)
    expectTerminalSchema(getDb()!)
  })
})

describe('v5 → v6 rename: a legacy requirements db migrates in place (no data loss)', () => {
  it('renames all tables/column/index and preserves every row', () => {
    seedLegacyV5(getDb()!)

    // First store access triggers the migration path.
    resetStoreForTests()
    const list = listIntents(proj)

    expectTerminalSchema(getDb()!)
    // Data survived the rename, fully hydrated.
    expect(list).toHaveLength(1)
    expect(list[0].id).toBe('r1')
    expect(list[0].title).toBe('Legacy req')
    expect(list[0].module).toBe('认证')
    expect(list[0].dependsOn).toEqual(['r0']) // requirement_deps → intent_deps carried over
    expect(getIntent('r1')?.title).toBe('Legacy req')
    // requirement_chats → intent_chats carried over (current + hidden set).
    expect(getChatSession(proj)).toBe('chat-1')
    expect(isHiddenSession('chat-1')).toBe(true)
  })

  it('is idempotent: re-running the ensure on the migrated db is a no-op (no throw)', () => {
    seedLegacyV5(getDb()!)
    resetStoreForTests()
    expect(listIntents(proj)).toHaveLength(1) // run 1 migrates

    // Re-arm the once-only ensure and run again on the already-migrated db.
    resetStoreForTests()
    expect(() => listIntents(proj)).not.toThrow()
    expectTerminalSchema(getDb()!)
    expect(getIntent('r1')?.title).toBe('Legacy req') // still intact
  })
})

describe('v5 → v6 rename: a partial-migration db re-enters and converges', () => {
  it('finishes deps/chats/column rename when only the requirements table was renamed', () => {
    // Mid-rename interruption: step 1 (requirements → intents) done, but
    // requirement_deps / requirement_chats and the requirement_id column are still legacy.
    const raw = getDb()!
    raw.exec(`
      CREATE TABLE intents (
        id TEXT PRIMARY KEY, project_path TEXT NOT NULL, title TEXT NOT NULL,
        content TEXT NOT NULL, priority TEXT NOT NULL, status TEXT NOT NULL,
        module TEXT NOT NULL DEFAULT '', last_dev_session_id TEXT,
        automate INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL, completed_at INTEGER
      );
      CREATE INDEX idx_intent_project_status ON intents(project_path, status);
      CREATE TABLE requirement_deps (
        requirement_id TEXT NOT NULL, depends_on_id TEXT NOT NULL,
        PRIMARY KEY (requirement_id, depends_on_id)
      );
      CREATE TABLE requirement_chats (
        session_id TEXT PRIMARY KEY, project_path TEXT NOT NULL,
        is_current INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE INDEX idx_chat_project ON requirement_chats(project_path);
      PRAGMA user_version=5;
    `)
    raw.run(
      `INSERT INTO intents
         (id, project_path, title, content, priority, status, module, last_dev_session_id, automate, created_at, updated_at, completed_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      'r1',
      proj,
      'Half-migrated',
      'body',
      'P0',
      'todo',
      '',
      null,
      0,
      1,
      1,
      null,
    )
    raw.run('INSERT INTO requirement_deps (requirement_id, depends_on_id) VALUES (?,?)', 'r1', 'r0')
    raw.run(
      'INSERT INTO requirement_chats (session_id, project_path, is_current, updated_at) VALUES (?,?,1,?)',
      'chat-1',
      proj,
      1,
    )

    // Re-enter: the remaining steps must complete and the db converge.
    resetStoreForTests()
    const list = listIntents(proj)

    expectTerminalSchema(getDb()!)
    expect(list[0].title).toBe('Half-migrated')
    expect(list[0].dependsOn).toEqual(['r0'])
    expect(getChatSession(proj)).toBe('chat-1')
    expect(isHiddenSession('chat-1')).toBe(true)
  })

  it('renames a lingering requirement_id column when intent_deps was already created', () => {
    // Narrower partial state: intent_deps exists but still keys on requirement_id
    // (table rename ran, column rename did not). Re-entry must rename the column.
    const raw = getDb()!
    raw.exec(`
      CREATE TABLE intent_deps (
        requirement_id TEXT NOT NULL, depends_on_id TEXT NOT NULL,
        PRIMARY KEY (requirement_id, depends_on_id)
      );
      PRAGMA user_version=5;
    `)
    raw.run('INSERT INTO intent_deps (requirement_id, depends_on_id) VALUES (?,?)', 'a', 'b')

    resetStoreForTests()
    listIntents(proj) // trigger ensure

    const migrated = getDb()!
    expect(cols(migrated, 'intent_deps').has('intent_id')).toBe(true)
    expect(cols(migrated, 'intent_deps').has('requirement_id')).toBe(false)
    // The pre-existing edge survived the column rename.
    const edge = migrated.get<{ intent_id: string; depends_on_id: string }>(
      'SELECT intent_id, depends_on_id FROM intent_deps WHERE intent_id=?',
      'a',
    )
    expect(edge?.depends_on_id).toBe('b')
  })
})
