/**
 * Migration tests for the v10 → v11 in-place rename `project_path` → `workspace_path`
 * (`migrateProjectPathToWorkspacePath` in store.ts). A legacy v10 db (project_path
 * columns, idx_intent_project_status) must converge on the workspace_path terminal
 * state with NO data loss and NO DROP TABLE, and the migration must be idempotent.
 *
 * This is the data-loss-level acceptance object: a user's existing ~/.c3/c3.db must
 * migrate in place. Seeding is raw SQL on the live connection; `resetStoreForTests()`
 * re-arms the once-only schema-ensure so the next store call runs the migration path.
 *
 * Deliberately diverges from the back-compat `projectConfigs` settings.json key (which
 * keeps its legacy name) — here the DB columns are renamed through. See migration 012.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../state.js', () => ({
  pathToId: vi.fn(() => 'ws-mig-id'),
}))
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

const proj = '/abs/workspace-mig'
let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'c3-wsmig-'))
  process.env.C3_DB_PATH = join(dir, 'c3.db')
  resetDbForTests()
  resetStoreForTests()
})

afterEach(() => {
  resetDbForTests()
  delete process.env.C3_DB_PATH
  rmSync(dir, { recursive: true, force: true })
})

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
function indexCols(raw: Db, index: string): string[] {
  return raw.all<{ name: string }>(`PRAGMA index_info(${index})`).map((r) => r.name)
}
function userVersion(raw: Db): number {
  return raw.get<{ user_version: number }>('PRAGMA user_version')?.user_version ?? -1
}

/** Build a v10 legacy db: project_path columns, idx_intent_project_status, one row each. */
function seedLegacyV10(raw: Db): void {
  raw.exec(`
    CREATE TABLE intents (
      id TEXT PRIMARY KEY, project_path TEXT NOT NULL, title TEXT NOT NULL,
      content TEXT NOT NULL, priority TEXT NOT NULL, status TEXT NOT NULL,
      module TEXT NOT NULL DEFAULT '', last_dev_session_id TEXT,
      automate INTEGER NOT NULL DEFAULT 0, branch_name TEXT, latest_commit_hash TEXT,
      pr_id TEXT, pr_status TEXT, created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL, completed_at INTEGER
    );
    CREATE INDEX idx_intent_project_status ON intents(project_path, status);
    CREATE TABLE intent_deps (
      intent_id TEXT NOT NULL, depends_on_id TEXT NOT NULL,
      dep_type TEXT NOT NULL DEFAULT 'blocks', created_at INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (intent_id, depends_on_id)
    );
    CREATE TABLE intent_chats (
      session_id TEXT PRIMARY KEY, project_path TEXT NOT NULL,
      is_current INTEGER NOT NULL, updated_at INTEGER NOT NULL, title TEXT
    );
    CREATE INDEX idx_chat_project ON intent_chats(project_path);
    PRAGMA user_version=10;
  `)
  raw.run(
    `INSERT INTO intents
       (id, project_path, title, content, priority, status, module, last_dev_session_id, automate, branch_name, latest_commit_hash, pr_id, pr_status, created_at, updated_at, completed_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    'i1',
    proj,
    'Legacy intent',
    'body',
    'P0',
    'todo',
    '认证',
    null,
    0,
    'feat/x',
    'abc123',
    null,
    null,
    1,
    1,
    null,
  )
  raw.run('INSERT INTO intent_deps (intent_id, depends_on_id) VALUES (?,?)', 'i1', 'i0')
  raw.run(
    'INSERT INTO intent_chats (session_id, project_path, is_current, updated_at, title) VALUES (?,?,1,?,?)',
    'chat-1',
    proj,
    1,
    'A chat',
  )
}

/** Assert the workspace_path terminal state (columns + index + version). */
function expectTerminalSchema(raw: Db): void {
  // Columns renamed on both tables.
  expect(cols(raw, 'intents').has('workspace_path')).toBe(true)
  expect(cols(raw, 'intents').has('project_path')).toBe(false)
  expect(cols(raw, 'intent_chats').has('workspace_path')).toBe(true)
  expect(cols(raw, 'intent_chats').has('project_path')).toBe(false)
  // Composite index renamed.
  const idx = indexes(raw)
  expect(idx.has('idx_intent_workspace_status')).toBe(true)
  expect(idx.has('idx_intent_project_status')).toBe(false)
  // Single-column index keeps its NAME but now references the renamed column.
  expect(idx.has('idx_chat_project')).toBe(true)
  expect(indexCols(raw, 'idx_chat_project')).toEqual(['workspace_path'])
  expect(userVersion(raw)).toBe(12)
}

describe('v10 → v11 rename: fresh db is born at the workspace_path terminal state', () => {
  it('a brand-new db has workspace_path columns and idx_intent_workspace_status', () => {
    listIntents(proj) // touch store → SCHEMA + migration run on empty db
    expectTerminalSchema(getDb()!)
  })
})

describe('v10 → v11 rename: a legacy project_path db migrates in place (no data loss)', () => {
  it('renames columns/index and preserves every row', () => {
    seedLegacyV10(getDb()!)
    resetStoreForTests()
    const list = listIntents(proj)

    expectTerminalSchema(getDb()!)
    // Row data survived the rename, fully hydrated by workspace_path.
    expect(list).toHaveLength(1)
    expect(list[0].id).toBe('i1')
    expect(list[0].title).toBe('Legacy intent')
    expect(list[0].module).toBe('认证')
    expect(list[0].workspaceId).toBe('ws-mig-id')
    expect(list[0].branchName).toBe('feat/x')
    expect(list[0].dependsOn).toEqual(['i0'])
    // intent_chats carried over (current pointer + hidden set both key on workspace_path).
    expect(getChatSession(proj)).toBe('chat-1')
    expect(isHiddenSession('chat-1')).toBe(true)
    expect(getIntent('i1')?.title).toBe('Legacy intent')
  })

  it('is idempotent: re-running the ensure on the migrated db is a no-op (no throw)', () => {
    seedLegacyV10(getDb()!)
    resetStoreForTests()
    expect(listIntents(proj)).toHaveLength(1) // run 1 migrates

    resetStoreForTests()
    expect(() => listIntents(proj)).not.toThrow() // run 2 on already-migrated db
    expectTerminalSchema(getDb()!)
    expect(getIntent('i1')?.title).toBe('Legacy intent') // still intact
    expect(getChatSession(proj)).toBe('chat-1')
  })
})
