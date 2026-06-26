/**
 * Migration test for the user-involve store's v1 → v2 in-place rename
 * `project_path` → `workspace_path` (`migrateProjectPathToWorkspacePath`). A legacy
 * v1 db (project_path column, idx_wui_project_status) must converge on the
 * workspace_path terminal state with NO data loss and NO DROP TABLE, idempotently.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
// Identity-stub the workspace registry mapping (see store.test.ts).
vi.mock('../../state.js', () => ({ pathToId: (p: string) => p }))
// `toEvent` reverse-looks-up the owning intent; isolate from the intents store.
vi.mock('../intents/store.js', () => ({
  findIntentIdByAnySessionId: () => null,
  getIntent: () => null,
}))
import { getDb, resetDbForTests, type Db } from '../../kernel/infra/db.js'
import { getEvent, listEvents, resetStoreForTests } from './store.js'

const proj = '/abs/wui-wsmig'
let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'c3-wui-wsmig-'))
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

/** Build a v1 legacy db: project_path column + idx_wui_project_status, one row. */
function seedLegacyV1(raw: Db): void {
  raw.exec(`
    CREATE TABLE wait_user_involve_events (
      id TEXT PRIMARY KEY, project_path TEXT NOT NULL, source TEXT NOT NULL,
      source_id TEXT, title TEXT, request_id TEXT, tool_name TEXT,
      tool_input TEXT NOT NULL DEFAULT '', status TEXT NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE INDEX idx_wui_project_status ON wait_user_involve_events(project_path, status);
    CREATE INDEX idx_wui_source_status ON wait_user_involve_events(source_id, status);
    PRAGMA user_version=1;
  `)
  raw.run(
    `INSERT INTO wait_user_involve_events
       (id, project_path, source, source_id, title, request_id, tool_name, tool_input, status, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    'e1',
    resolve(proj),
    'session',
    'sess-1',
    'Approve write',
    'req-1',
    'Write',
    '{}',
    'todo',
    1,
    1,
  )
}

function expectTerminalSchema(raw: Db): void {
  const c = cols(raw, 'wait_user_involve_events')
  expect(c.has('workspace_path')).toBe(true)
  expect(c.has('project_path')).toBe(false)
  // The v4→v5 source-column rename also runs on schema-ensure (both migrations land).
  expect(c.has('session_kind')).toBe(true)
  expect(c.has('session_id')).toBe(true)
  expect(c.has('source')).toBe(false)
  expect(c.has('source_id')).toBe(false)
  const idx = indexes(raw)
  expect(idx.has('idx_wui_workspace_status')).toBe(true)
  expect(idx.has('idx_wui_project_status')).toBe(false)
  expect(idx.has('idx_wui_session_status')).toBe(true)
  expect(idx.has('idx_wui_source_status')).toBe(false)
}

describe('user-involve v1 → v2 rename: legacy project_path db migrates in place', () => {
  it('renames column/index and preserves the row', () => {
    seedLegacyV1(getDb()!)
    resetStoreForTests()
    const list = listEvents(proj)

    expectTerminalSchema(getDb()!)
    expect(list).toHaveLength(1)
    expect(list[0].id).toBe('e1')
    expect(list[0].title).toBe('Approve write')
    expect(list[0].workspaceId).toBe(resolve(proj))
    expect(getEvent('e1')?.toolName).toBe('Write')
  })

  it('is idempotent: re-running the ensure is a no-op (no throw, row intact)', () => {
    seedLegacyV1(getDb()!)
    resetStoreForTests()
    expect(listEvents(proj)).toHaveLength(1)

    resetStoreForTests()
    expect(() => listEvents(proj)).not.toThrow()
    expectTerminalSchema(getDb()!)
    expect(getEvent('e1')?.title).toBe('Approve write')
  })
})
