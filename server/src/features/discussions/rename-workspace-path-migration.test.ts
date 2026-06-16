/**
 * Migration test for the discussion store's v3 → v4 in-place rename
 * `project_path` → `workspace_path` (`migrateProjectPathToWorkspacePath`). A legacy
 * v3 db (project_path column, idx_disc_project_status) must converge on the
 * workspace_path terminal state with NO data loss and NO DROP TABLE, idempotently.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// Identity-stub the registry id↔path mapping (the synthetic path is unregistered).
vi.mock('../../state.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../state.js')>()),
  resolveWorkspaceRoot: (id: string) => id,
  pathToId: (p: string) => p,
}))
import { getDb, resetDbForTests, type Db } from '../../kernel/infra/db.js'
import { getDiscussion, listDiscussions, resetStoreForTests } from './store.js'

const proj = '/abs/disc-wsmig'
let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'c3-disc-wsmig-'))
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

/** Build a v3 legacy db: discussions.project_path + idx_disc_project_status, one row. */
function seedLegacyV3(raw: Db): void {
  raw.exec(`
    CREATE TABLE discussions (
      id TEXT PRIMARY KEY, project_path TEXT NOT NULL, title TEXT NOT NULL,
      type TEXT NOT NULL, goal TEXT NOT NULL DEFAULT '', context TEXT NOT NULL DEFAULT '',
      research_result TEXT NOT NULL DEFAULT '', status TEXT NOT NULL,
      agenda TEXT NOT NULL DEFAULT '[]', agenda_index INTEGER NOT NULL DEFAULT 0,
      participant_agent_ids TEXT NOT NULL DEFAULT '[]', conclusion TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, completed_at INTEGER
    );
    CREATE INDEX idx_disc_project_status ON discussions(project_path, status);
    PRAGMA user_version=3;
  `)
  raw.run(
    `INSERT INTO discussions (id, project_path, title, type, status, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?)`,
    'd1',
    proj,
    'Legacy discussion',
    'brainstorm',
    'active',
    1,
    1,
  )
}

function expectTerminalSchema(raw: Db): void {
  expect(cols(raw, 'discussions').has('workspace_path')).toBe(true)
  expect(cols(raw, 'discussions').has('project_path')).toBe(false)
  const idx = indexes(raw)
  expect(idx.has('idx_disc_workspace_status')).toBe(true)
  expect(idx.has('idx_disc_project_status')).toBe(false)
}

describe('discussion v3 → v4 rename: legacy project_path db migrates in place', () => {
  it('renames column/index and preserves the row', () => {
    seedLegacyV3(getDb()!)
    resetStoreForTests()
    const list = listDiscussions(proj)

    expectTerminalSchema(getDb()!)
    expect(list).toHaveLength(1)
    expect(list[0].id).toBe('d1')
    expect(list[0].title).toBe('Legacy discussion')
    expect(list[0].workspaceId).toBe(proj)
    expect(getDiscussion('d1')?.status).toBe('active')
  })

  it('is idempotent: re-running the ensure is a no-op (no throw, row intact)', () => {
    seedLegacyV3(getDb()!)
    resetStoreForTests()
    expect(listDiscussions(proj)).toHaveLength(1)

    resetStoreForTests()
    expect(() => listDiscussions(proj)).not.toThrow()
    expectTerminalSchema(getDb()!)
    expect(getDiscussion('d1')?.title).toBe('Legacy discussion')
  })
})
