import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getDb, resetDbForTests } from '../../kernel/infra/db.js'
import {
  canTransition,
  findIntents,
  getChatSession,
  getIntent,
  getIntentSession,
  insertDependency,
  insertIntentSession,
  insertIntents,
  isHiddenSession,
  isStoreAvailable,
  listChatSessions,
  listDependencies,
  listHiddenSessions,
  listIntentSessions,
  listIntents,
  rebindChatSession,
  renameChatSession,
  deleteChatSession,
  resetStoreForTests,
  resolveBatchDependencies,
  setBranchName,
  setChatSession,
  setLastDevSession,
  setLatestCommitHash,
  setPrInfo,
  updateIntent,
  updateStatus,
  upsertIntents,
} from './store.js'
import { emit, ensureRuntime, setOnEmit, removeRuntime } from '../../runs.js'

let dir: string
const proj = '/abs/project-a'

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'c3-db-'))
  process.env.C3_DB_PATH = join(dir, 'c3.db')
  resetDbForTests()
  resetStoreForTests()
})

afterEach(() => {
  resetDbForTests()
  delete process.env.C3_DB_PATH
  rmSync(dir, { recursive: true, force: true })
})

describe('intents CRUD', () => {
  it('inserts a batch as todo and lists with dependsOn, in insertion order', () => {
    expect(isStoreAvailable()).toBe(true)
    const saved = insertIntents(proj, [
      { title: 'A', content: 'ca', priority: 'P1' },
      { title: 'B', content: 'cb', priority: 'P0', dependsOn: ['x', 'y'] },
    ])
    expect(saved).toHaveLength(2)
    expect(saved[0].title).toBe('A')
    expect(saved[0].status).toBe('todo')
    expect(saved[0].dependsOn).toEqual([])
    expect(saved[1].dependsOn.sort()).toEqual(['x', 'y'])
    expect(saved[1].lastDevSessionId).toBeNull()
    // listed sorted by priority asc then recency — B (P0) before A (P1)
    const list = listIntents(proj)
    expect(list.map((r) => r.title)).toEqual(['B', 'A'])
  })

  it('filters by status', () => {
    const [a] = insertIntents(proj, [{ title: 'A', content: '', priority: 'P2' }])
    insertIntents(proj, [{ title: 'B', content: '', priority: 'P2' }])
    updateStatus(a.id, 'in_progress')
    expect(listIntents(proj, 'todo').map((r) => r.title)).toEqual(['B'])
    expect(listIntents(proj, 'in_progress').map((r) => r.title)).toEqual(['A'])
  })

  it('scopes by project', () => {
    insertIntents(proj, [{ title: 'A', content: '', priority: 'P0' }])
    insertIntents('/abs/project-b', [{ title: 'B', content: '', priority: 'P0' }])
    expect(listIntents(proj).map((r) => r.title)).toEqual(['A'])
    expect(listIntents('/abs/project-b').map((r) => r.title)).toEqual(['B'])
  })

  it('normalizes project paths (resolve)', () => {
    insertIntents('/abs/project-a/', [{ title: 'A', content: '', priority: 'P0' }])
    // trailing slash resolves to the same key
    expect(listIntents('/abs/project-a').map((r) => r.title)).toEqual(['A'])
  })

  it('records last dev session and updates status', () => {
    const [r] = insertIntents(proj, [{ title: 'A', content: '', priority: 'P0' }])
    setLastDevSession(r.id, 'sess-123')
    updateStatus(r.id, 'in_progress')
    const got = getIntent(r.id)
    expect(got?.lastDevSessionId).toBe('sess-123')
    expect(got?.status).toBe('in_progress')
  })

  it('patches fields and replaces dependencies', () => {
    const [r] = insertIntents(proj, [
      { title: 'A', content: 'old', priority: 'P2', dependsOn: ['x'] },
    ])
    updateIntent(r.id, { content: 'new', priority: 'P0', dependsOn: ['y', 'z'] })
    const got = getIntent(r.id)
    expect(got?.content).toBe('new')
    expect(got?.priority).toBe('P0')
    expect(got?.dependsOn.sort()).toEqual(['y', 'z'])
    expect(got?.title).toBe('A') // untouched
  })

  it('stamps completedAt when marked done and clears it when reverted', () => {
    const [r] = insertIntents(proj, [{ title: 'A', content: '', priority: 'P0' }])
    expect(getIntent(r.id)?.completedAt).toBeNull() // todo → no completion time

    updateStatus(r.id, 'done')
    const done = getIntent(r.id)
    expect(typeof done?.completedAt).toBe('number') // done → stamped
    expect(done?.completedAt).toBeGreaterThan(0)

    updateStatus(r.id, 'in_progress')
    expect(getIntent(r.id)?.completedAt).toBeNull() // reverted → cleared
  })

  it('keeps completedAt in sync when status is patched via updateIntent', () => {
    const [r] = insertIntents(proj, [{ title: 'A', content: '', priority: 'P0' }])
    updateIntent(r.id, { status: 'done' })
    expect(typeof getIntent(r.id)?.completedAt).toBe('number')
    updateIntent(r.id, { status: 'cancelled' })
    expect(getIntent(r.id)?.completedAt).toBeNull()
  })

  it('stores the inferred module and defaults to "" when omitted', () => {
    const saved = insertIntents(proj, [
      { title: 'A', content: '', priority: 'P0', module: '认证' },
      { title: 'B', content: '', priority: 'P0' }, // module omitted → '' fallback
    ])
    const byTitle = new Map(saved.map((r) => [r.title, r]))
    expect(byTitle.get('A')?.module).toBe('认证')
    expect(byTitle.get('B')?.module).toBe('')
    // module survives a re-read
    expect(getIntent(byTitle.get('A')!.id)?.module).toBe('认证')
  })

  it('persists across a cache reset (real file)', () => {
    const [r] = insertIntents(proj, [{ title: 'A', content: '', priority: 'P0' }])
    resetDbForTests()
    resetStoreForTests()
    expect(getIntent(r.id)?.title).toBe('A')
  })

  it('migrates a pre-v2 db: adds the module column, keeps historic rows, is idempotent', () => {
    // Build an old-schema intents table (no `module` column) with one
    // historic row, mimicking a db created before this change.
    const raw = getDb()!
    raw.exec(`
      CREATE TABLE intents (
        id              TEXT PRIMARY KEY,
        project_path    TEXT NOT NULL,
        title           TEXT NOT NULL,
        content         TEXT NOT NULL,
        priority        TEXT NOT NULL,
        status          TEXT NOT NULL,
        last_dev_session_id TEXT,
        created_at      INTEGER NOT NULL,
        updated_at      INTEGER NOT NULL
      );
      PRAGMA user_version=1;
    `)
    raw.run(
      `INSERT INTO intents
         (id, project_path, title, content, priority, status, last_dev_session_id, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      'old-1',
      proj,
      'Legacy',
      'body',
      'P0',
      'todo',
      null,
      1,
      1,
    )

    // First store access triggers the schema-ensure / migration path.
    resetStoreForTests()
    const got = getIntent('old-1')
    expect(got?.title).toBe('Legacy') // historic row survives
    expect(got?.module).toBe('') // backfilled default
    expect(got?.completedAt).toBeNull() // new nullable column, null for historic rows
    expect(got?.automate).toBe(false) // backfilled default (opt-in to automation)

    // The legacy `intents` table was renamed in place to `intents` (v5 → v6).
    const cols = raw.all<{ name: string }>('PRAGMA table_info(intents)')
    expect(cols.some((c) => c.name === 'module')).toBe(true)
    expect(cols.some((c) => c.name === 'completed_at')).toBe(true)
    expect(cols.some((c) => c.name === 'automate')).toBe(true)
    const version = raw.get<{ user_version: number }>('PRAGMA user_version')
    expect(version?.user_version).toBe(10)

    // Idempotent: a second ensure must not try to re-add the column (would throw).
    resetStoreForTests()
    expect(() => listIntents(proj)).not.toThrow()
    expect(getIntent('old-1')?.module).toBe('')
  })

  it('migrates to v10: adds dep_type + created_at to intent_deps, adds git tracking columns (branch_name, commit hash, pr_id, pr_status), is idempotent', () => {
    // Build a v7 schema (no git columns) with one historic row.
    const raw = getDb()!
    raw.exec(`
      CREATE TABLE intents (
        id              TEXT PRIMARY KEY,
        project_path    TEXT NOT NULL,
        title           TEXT NOT NULL,
        content         TEXT NOT NULL,
        priority        TEXT NOT NULL,
        status          TEXT NOT NULL,
        module          TEXT NOT NULL DEFAULT '',
        last_dev_session_id TEXT,
        automate        INTEGER NOT NULL DEFAULT 0,
        created_at      INTEGER NOT NULL,
        updated_at      INTEGER NOT NULL,
        completed_at    INTEGER
      );
      CREATE TABLE intent_deps (
        intent_id       TEXT NOT NULL,
        depends_on_id   TEXT NOT NULL,
        PRIMARY KEY (intent_id, depends_on_id)
      );
      PRAGMA user_version=7;
    `)
    raw.run(
      `INSERT INTO intents
         (id, project_path, title, content, priority, status, module, last_dev_session_id, automate, created_at, updated_at, completed_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      'old-v7',
      proj,
      'Pre-git',
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

    // First access triggers the v7→v8 migration.
    resetStoreForTests()
    const got = getIntent('old-v7')
    expect(got?.title).toBe('Pre-git') // historic row survives
    expect(got?.branchName).toBeNull() // backfilled null
    expect(got?.latestCommitHash).toBeNull()
    expect(got?.prId).toBeNull()
    expect(got?.prStatus).toBeNull()

    const cols = raw.all<{ name: string }>('PRAGMA table_info(intents)')
    expect(cols.some((c) => c.name === 'branch_name')).toBe(true)
    expect(cols.some((c) => c.name === 'latest_commit_hash')).toBe(true)
    expect(cols.some((c) => c.name === 'pr_id')).toBe(true)
    expect(cols.some((c) => c.name === 'pr_status')).toBe(true)
    // intent_deps columns migrated from v8→v9.
    const depsCols = raw.all<{ name: string }>('PRAGMA table_info(intent_deps)')
    expect(depsCols.some((c) => c.name === 'dep_type')).toBe(true)
    expect(depsCols.some((c) => c.name === 'created_at')).toBe(true)
    const version = raw.get<{ user_version: number }>('PRAGMA user_version')
    expect(version?.user_version).toBe(10)

    // Idempotent: re-run must not throw.
    resetStoreForTests()
    expect(() => listIntents(proj)).not.toThrow()
    expect(getIntent('old-v7')?.branchName).toBeNull()
  })

  it('round-trips git fields: setBranchName, setLatestCommitHash, setPrInfo + read-back', () => {
    const [r] = insertIntents(proj, [{ title: 'GitFieldTest', content: '', priority: 'P1' }])
    // New insertions default all git fields to null.
    expect(r.branchName).toBeNull()
    expect(r.latestCommitHash).toBeNull()
    expect(r.prId).toBeNull()
    expect(r.prStatus).toBeNull()

    // Set branch name.
    setBranchName(r.id, 'feat/my-feature')
    let got = getIntent(r.id)
    expect(got?.branchName).toBe('feat/my-feature')
    expect(got?.prId).toBeNull() // other fields still null

    // Set commit hash.
    setLatestCommitHash(r.id, 'a1b2c3d')
    got = getIntent(r.id)
    expect(got?.latestCommitHash).toBe('a1b2c3d')
    expect(got?.branchName).toBe('feat/my-feature') // earlier field preserved

    // Set PR info.
    setPrInfo(r.id, '42', 'reviewing')
    got = getIntent(r.id)
    expect(got?.prId).toBe('42')
    expect(got?.prStatus).toBe('reviewing')
    expect(got?.branchName).toBe('feat/my-feature') // earlier fields preserved
    expect(got?.latestCommitHash).toBe('a1b2c3d')
  })
})

describe('resolveBatchDependencies (pure)', () => {
  const ids = ['id-0', 'id-1', 'id-2']

  it('resolves intra-batch indexes to sibling ids', () => {
    const out = resolveBatchDependencies(
      [{ dependsOnIndexes: [] }, { dependsOnIndexes: [0] }, { dependsOnIndexes: [0, 1] }],
      ids,
    )
    expect(out).toEqual([[], ['id-0'], ['id-0', 'id-1']])
  })

  it('merges existing-id deps with resolved indexes, de-duplicated', () => {
    const out = resolveBatchDependencies(
      [{ dependsOn: ['ext'] }, { dependsOn: ['ext', 'id-0'], dependsOnIndexes: [0] }],
      ['id-0', 'id-1'],
    )
    expect(out[0]).toEqual(['ext'])
    // 'id-0' appears via both dependsOn and dependsOnIndexes → kept once
    expect(out[1].sort()).toEqual(['ext', 'id-0'])
  })

  it('leaves existing-id-only batches untouched (back-compat)', () => {
    const out = resolveBatchDependencies([{ dependsOn: ['x', 'y'] }, {}], ['id-0', 'id-1'])
    expect(out).toEqual([['x', 'y'], []])
  })

  it('rejects an out-of-range index', () => {
    expect(() => resolveBatchDependencies([{}, { dependsOnIndexes: [5] }], ids)).toThrow(/越界/)
    expect(() => resolveBatchDependencies([{ dependsOnIndexes: [-1] }, {}], ids)).toThrow(/越界/)
  })

  it('rejects a self reference', () => {
    expect(() => resolveBatchDependencies([{ dependsOnIndexes: [0] }], ['id-0'])).toThrow(/自引用/)
  })

  it('rejects a direct cycle', () => {
    expect(() =>
      resolveBatchDependencies(
        [{ dependsOnIndexes: [1] }, { dependsOnIndexes: [0] }],
        ['id-0', 'id-1'],
      ),
    ).toThrow(/成环/)
  })

  it('rejects a transitive cycle', () => {
    // 0 → 1 → 2 → 0
    expect(() =>
      resolveBatchDependencies(
        [{ dependsOnIndexes: [1] }, { dependsOnIndexes: [2] }, { dependsOnIndexes: [0] }],
        ids,
      ),
    ).toThrow(/成环/)
  })
})

describe('insertIntents — intra-batch dependencies', () => {
  it('resolves dependsOnIndexes to the sibling real id on save', () => {
    const [a, b] = insertIntents(proj, [
      { title: 'A', content: '', priority: 'P0' },
      { title: 'B', content: '', priority: 'P0', dependsOnIndexes: [0] }, // depends on A
    ])
    expect(a.dependsOn).toEqual([])
    expect(b.dependsOn).toEqual([a.id])
  })

  it('merges existing-id deps with intra-batch index deps', () => {
    const [, b] = insertIntents(proj, [
      { title: 'A', content: '', priority: 'P0' },
      { title: 'B', content: '', priority: 'P0', dependsOn: ['ext-id'], dependsOnIndexes: [0] },
    ])
    const a = listIntents(proj).find((r) => r.title === 'A')!
    expect(b.dependsOn.sort()).toEqual(['ext-id', a.id].sort())
  })

  it('staggers created_at by batch index so submission order is stable', () => {
    const [a, b, c] = insertIntents(proj, [
      { title: 'A', content: '', priority: 'P0' },
      { title: 'B', content: '', priority: 'P0' },
      { title: 'C', content: '', priority: 'P0' },
    ])
    expect(a.createdAt).toBeLessThan(b.createdAt)
    expect(b.createdAt).toBeLessThan(c.createdAt)
  })

  it('rejects the whole batch atomically on an out-of-range index (nothing persisted)', () => {
    expect(() =>
      insertIntents(proj, [
        { title: 'A', content: '', priority: 'P0' },
        { title: 'B', content: '', priority: 'P0', dependsOnIndexes: [9] },
      ]),
    ).toThrow(/越界/)
    expect(listIntents(proj)).toEqual([])
  })

  it('rejects the whole batch atomically on a self reference (nothing persisted)', () => {
    expect(() =>
      insertIntents(proj, [{ title: 'A', content: '', priority: 'P0', dependsOnIndexes: [0] }]),
    ).toThrow(/自引用/)
    expect(listIntents(proj)).toEqual([])
  })

  it('rejects the whole batch atomically on a cycle (nothing persisted)', () => {
    expect(() =>
      insertIntents(proj, [
        { title: 'A', content: '', priority: 'P0', dependsOnIndexes: [1] },
        { title: 'B', content: '', priority: 'P0', dependsOnIndexes: [0] },
      ]),
    ).toThrow(/成环/)
    expect(listIntents(proj)).toEqual([])
  })
})

describe('intent_deps dep_type', () => {
  it('insertIntents inserts deps with dep_type blocks by default', () => {
    const [a, b] = insertIntents(proj, [
      { title: 'A', content: '', priority: 'P0' },
      { title: 'B', content: '', priority: 'P0', dependsOnIndexes: [0] },
    ])
    const deps = listDependencies(b.id)
    expect(deps).toHaveLength(1)
    expect(deps[0].dependsOnId).toBe(a.id)
    expect(deps[0].depType).toBe('blocks')
    expect(deps[0].createdAt).toBeGreaterThan(0)
  })

  it('upsertIntents inserts deps with dep_type blocks', () => {
    const [a] = insertIntents(proj, [{ title: 'A', content: '', priority: 'P0' }])
    const [b] = insertIntents(proj, [{ title: 'B', content: '', priority: 'P0' }])
    // Update B to depend on A (via updateIntent).
    updateIntent(b.id, { dependsOn: [a.id] })
    const deps = listDependencies(b.id)
    expect(deps).toHaveLength(1)
    expect(deps[0].dependsOnId).toBe(a.id)
    expect(deps[0].depType).toBe('blocks')
  })

  it('upsertIntents in upsert path inserts deps with dep_type blocks', () => {
    const [a, b] = upsertIntents(proj, [
      { title: 'A', content: '', priority: 'P0' },
      { title: 'B', content: '', priority: 'P0', dependsOnIndexes: [0] },
    ])
    const bDeps = listDependencies(b.id)
    expect(bDeps).toHaveLength(1)
    expect(bDeps[0].dependsOnId).toBe(a.id)
    expect(bDeps[0].depType).toBe('blocks')
    expect(bDeps[0].createdAt).toBeGreaterThan(0)
  })

  it('listDependencies returns empty for intent with no deps', () => {
    const [a] = insertIntents(proj, [{ title: 'A', content: '', priority: 'P0' }])
    expect(listDependencies(a.id)).toEqual([])
  })

  it('listDependencies returns multiple deps sorted by created_at', () => {
    const [a] = insertIntents(proj, [{ title: 'A', content: '', priority: 'P0' }])
    const [b] = insertIntents(proj, [{ title: 'B', content: '', priority: 'P0' }])
    const [c] = insertIntents(proj, [{ title: 'C', content: '', priority: 'P0' }])
    // Manually add deps via insertDependency.
    insertDependency(c.id, a.id)
    insertDependency(c.id, b.id)
    const deps = listDependencies(c.id)
    expect(deps).toHaveLength(2)
    expect(deps[0].depType).toBe('blocks')
    expect(deps[1].depType).toBe('blocks')
  })

  it('insertDependency defaults dep_type to blocks', () => {
    const [a, b] = insertIntents(proj, [
      { title: 'A', content: '', priority: 'P0' },
      { title: 'B', content: '', priority: 'P0' },
    ])
    insertDependency(b.id, a.id)
    const deps = listDependencies(b.id)
    expect(deps).toHaveLength(1)
    expect(deps[0].depType).toBe('blocks')
  })

  it('insertDependency accepts dep_type informs', () => {
    const [a, b] = insertIntents(proj, [
      { title: 'A', content: '', priority: 'P0' },
      { title: 'B', content: '', priority: 'P0' },
    ])
    insertDependency(b.id, a.id, 'informs')
    const deps = listDependencies(b.id)
    expect(deps).toHaveLength(1)
    expect(deps[0].depType).toBe('informs')
  })

  it('insertDependency accepts dep_type soft_after', () => {
    const [a, b] = insertIntents(proj, [
      { title: 'A', content: '', priority: 'P0' },
      { title: 'B', content: '', priority: 'P0' },
    ])
    insertDependency(b.id, a.id, 'soft_after')
    const deps = listDependencies(b.id)
    expect(deps).toHaveLength(1)
    expect(deps[0].depType).toBe('soft_after')
  })

  it('insertDependency is idempotent (INSERT OR IGNORE)', () => {
    const [a, b] = insertIntents(proj, [
      { title: 'A', content: '', priority: 'P0' },
      { title: 'B', content: '', priority: 'P0' },
    ])
    insertDependency(b.id, a.id, 'blocks')
    insertDependency(b.id, a.id, 'blocks') // second insert is ignored
    const deps = listDependencies(b.id)
    expect(deps).toHaveLength(1)
  })

  it('dep_type on existing deps has correct default after migration', () => {
    const [a, b] = insertIntents(proj, [
      { title: 'A', content: '', priority: 'P0' },
      { title: 'B', content: '', priority: 'P0', dependsOnIndexes: [0] },
    ])
    // Re-initialize store to simulate "re-migration" (idempotency check).
    resetStoreForTests()
    const deps = listDependencies(b.id)
    expect(deps).toHaveLength(1)
    expect(deps[0].depType).toBe('blocks')
    expect(deps[0].createdAt).toBeGreaterThan(0)
  })

  it('cycle detection still works regardless of dep_type', () => {
    expect(() =>
      resolveBatchDependencies(
        [
          { dependsOnIndexes: [1] },
          { dependsOnIndexes: [0] },
        ],
        ['id-0', 'id-1'],
      ),
    ).toThrow(/成环/)
  })
})

describe('communication session mapping / hidden set', () => {
  it('tracks one current session per project and switches it', () => {
    setChatSession(proj, 's1')
    expect(getChatSession(proj)).toBe('s1')
    setChatSession(proj, 's2')
    expect(getChatSession(proj)).toBe('s2')
    // both ids stay in the hidden set even though only s2 is current
    expect(listHiddenSessions(proj).sort()).toEqual(['s1', 's2'])
    expect(isHiddenSession('s1')).toBe(true)
    expect(isHiddenSession('s2')).toBe(true)
    expect(isHiddenSession('other')).toBe(false)
  })

  it('rebinds a pending session id to the real one, keeping current + hidden', () => {
    setChatSession(proj, 'pending:abc')
    rebindChatSession('pending:abc', 'real-xyz')
    expect(getChatSession(proj)).toBe('real-xyz')
    expect(isHiddenSession('pending:abc')).toBe(false)
    expect(isHiddenSession('real-xyz')).toBe(true)
  })

  it('keeps hidden sets project-scoped', () => {
    setChatSession(proj, 's1')
    setChatSession('/abs/project-b', 's2')
    expect(listHiddenSessions(proj)).toEqual(['s1'])
    expect(listHiddenSessions('/abs/project-b')).toEqual(['s2'])
  })

  // ── Session-collection upgrade (multi-session CRUD) ──

  it('lists all sessions — setChatSession does NOT clear old rows', () => {
    setChatSession(proj, 's1')
    setChatSession(proj, 's2')
    const list = listChatSessions(proj)
    expect(list).toHaveLength(2)
    // Both session ids are present (order may be the same timestamp).
    expect(list.map((s) => s.sessionId)).toEqual(expect.arrayContaining(['s1', 's2']))
  })

  it('renames a session', () => {
    setChatSession(proj, 's1')
    renameChatSession('s1', 'My chat')
    const list = listChatSessions(proj)
    expect(list).toHaveLength(1)
    expect(list[0].sessionId).toBe('s1')
    expect(list[0].title).toBe('My chat')
  })

  it('deletes a session physically and clears its runtime entry', () => {
    setChatSession(proj, 's1')
    setChatSession(proj, 's2')
    deleteChatSession(proj, 's1')
    const list = listChatSessions(proj)
    expect(list.map((s) => s.sessionId)).toEqual(['s2'])
    expect(isHiddenSession('s1')).toBe(false)
  })

  it('falls back is_current to the latest session when the current one is deleted', () => {
    setChatSession(proj, 's1') // s1 becomes is_current=1
    setChatSession(proj, 's2') // s2 becomes is_current=1, s1→0
    // Delete s2 (the current one) → s1 becomes the new default
    deleteChatSession(proj, 's2')
    expect(getChatSession(proj)).toBe('s1')
    // Only s1 remains in the hidden set
    expect(listHiddenSessions(proj)).toEqual(['s1'])
  })

  it('deleting the only session leaves no is_current', () => {
    setChatSession(proj, 's1')
    deleteChatSession(proj, 's1')
    expect(getChatSession(proj)).toBeNull()
    expect(listChatSessions(proj)).toEqual([])
  })

  // ── Session title (auto-naming on creation) ──

  it('setChatSession with title stores it and listChatSessions returns it', () => {
    setChatSession(proj, 's1', 'My title')
    const list = listChatSessions(proj)
    expect(list).toHaveLength(1)
    expect(list[0].sessionId).toBe('s1')
    expect(list[0].title).toBe('My title')
  })

  it('setChatSession without title stores null title', () => {
    setChatSession(proj, 's1')
    const list = listChatSessions(proj)
    expect(list).toHaveLength(1)
    expect(list[0].title).toBeNull()
  })

  it('ON CONFLICT does not overwrite existing title when called without title', () => {
    setChatSession(proj, 's1', 'Persistent')
    // Second call without title — ON CONFLICT triggers but must NOT clear the title.
    setChatSession(proj, 's1')
    const list = listChatSessions(proj)
    expect(list).toHaveLength(1)
    expect(list[0].title).toBe('Persistent')
  })

  it('rebindChatSession preserves title', () => {
    setChatSession(proj, 'pending:abc', 'Bound title')
    rebindChatSession('pending:abc', 'real-xyz')
    const list = listChatSessions(proj)
    expect(list).toHaveLength(1)
    expect(list[0].sessionId).toBe('real-xyz')
    expect(list[0].title).toBe('Bound title')
  })

  // ── Auto-title derivation (2026-06-08-001) ──

  it('derives title from first user message on first assistant_text event', () => {
    setChatSession(proj, 's1')
    ensureRuntime('s1', proj, 'default', [], 'intent')

    const titled = new Set<string>()
    setOnEmit((rt, event) => {
      if (rt.kind !== 'intent') return
      if (event.type !== 'assistant_text') return
      if (titled.has(rt.sessionId)) return
      titled.add(rt.sessionId)
      const sessions = listChatSessions(proj)
      const session = sessions.find((s) => s.sessionId === rt.sessionId)
      if (session?.title) return
      let firstUserText = ''
      for (const item of rt.baseline) {
        if (item.kind === 'user' && item.text?.trim()) {
          firstUserText = item.text.trim()
          break
        }
      }
      if (!firstUserText) {
        for (const ev of rt.buffer) {
          if (ev.type === 'user_text' && ev.text?.trim()) {
            firstUserText = ev.text.trim()
            break
          }
        }
      }
      if (!firstUserText) return
      renameChatSession(rt.sessionId, firstUserText.substring(0, 64))
    })

    // Emit user_text then assistant_text — first user message is in the buffer.
    emit('s1', { type: 'user_text', text: 'Implement authentication flow' })
    emit('s1', { type: 'assistant_text', text: 'I will help implement authentication' })

    const updated = listChatSessions(proj).find((s) => s.sessionId === 's1')
    expect(updated?.title).toBe('Implement authentication flow')

    setOnEmit(null)
    removeRuntime('s1')
  })

  it('derives title from baseline when session has history', () => {
    setChatSession(proj, 's2')
    ensureRuntime('s2', proj, 'default', [{ kind: 'user', text: 'Fix the login bug' }], 'intent')

    const titled = new Set<string>()
    setOnEmit((rt, event) => {
      if (rt.kind !== 'intent') return
      if (event.type !== 'assistant_text') return
      if (titled.has(rt.sessionId)) return
      titled.add(rt.sessionId)
      const sessions = listChatSessions(proj)
      const session = sessions.find((s) => s.sessionId === rt.sessionId)
      if (session?.title) return
      let firstUserText = ''
      for (const item of rt.baseline) {
        if (item.kind === 'user' && item.text?.trim()) {
          firstUserText = item.text.trim()
          break
        }
      }
      if (!firstUserText) {
        for (const ev of rt.buffer) {
          if (ev.type === 'user_text' && ev.text?.trim()) {
            firstUserText = ev.text.trim()
            break
          }
        }
      }
      if (!firstUserText) return
      renameChatSession(rt.sessionId, firstUserText.substring(0, 64))
    })

    emit('s2', { type: 'assistant_text', text: 'Analyzing the bug report...' })

    const updated = listChatSessions(proj).find((s) => s.sessionId === 's2')
    expect(updated?.title).toBe('Fix the login bug')

    setOnEmit(null)
    removeRuntime('s2')
  })

  it('truncates title to 64 characters', () => {
    setChatSession(proj, 's3')
    ensureRuntime('s3', proj, 'default', [], 'intent')
    const longMessage = 'a'.repeat(100)
    const expected = 'a'.repeat(64)

    const titled = new Set<string>()
    setOnEmit((rt, event) => {
      if (rt.kind !== 'intent') return
      if (event.type !== 'assistant_text') return
      if (titled.has(rt.sessionId)) return
      titled.add(rt.sessionId)
      const sessions = listChatSessions(proj)
      const session = sessions.find((s) => s.sessionId === rt.sessionId)
      if (session?.title) return
      let firstUserText = ''
      for (const item of rt.baseline) {
        if (item.kind === 'user' && item.text?.trim()) {
          firstUserText = item.text.trim()
          break
        }
      }
      if (!firstUserText) {
        for (const ev of rt.buffer) {
          if (ev.type === 'user_text' && ev.text?.trim()) {
            firstUserText = ev.text.trim()
            break
          }
        }
      }
      if (!firstUserText) return
      renameChatSession(rt.sessionId, firstUserText.substring(0, 64))
    })

    emit('s3', { type: 'user_text', text: longMessage })
    emit('s3', { type: 'assistant_text', text: 'OK' })

    const updated = listChatSessions(proj).find((s) => s.sessionId === 's3')
    expect(updated?.title).toBe(expected)
    expect(updated?.title?.length).toBe(64)

    setOnEmit(null)
    removeRuntime('s3')
  })

  it('does not overwrite an existing title', () => {
    setChatSession(proj, 's4', 'Existing Title')
    ensureRuntime('s4', proj, 'default', [], 'intent')

    const titled = new Set<string>()
    setOnEmit((rt, event) => {
      if (rt.kind !== 'intent') return
      if (event.type !== 'assistant_text') return
      if (titled.has(rt.sessionId)) return
      titled.add(rt.sessionId)
      const sessions = listChatSessions(proj)
      const session = sessions.find((s) => s.sessionId === rt.sessionId)
      if (session?.title) return // This should short-circuit
      renameChatSession(rt.sessionId, 'Should Not Overwrite')
    })

    emit('s4', { type: 'user_text', text: 'Some message' })
    emit('s4', { type: 'assistant_text', text: 'Reply' })

    const session = listChatSessions(proj).find((s) => s.sessionId === 's4')
    expect(session?.title).toBe('Existing Title')

    setOnEmit(null)
    removeRuntime('s4')
  })

  it('does not fire twice for the same session', () => {
    setChatSession(proj, 's5')
    ensureRuntime('s5', proj, 'default', [], 'intent')

    let callCount = 0
    const titled = new Set<string>()
    setOnEmit((rt, event) => {
      if (rt.kind !== 'intent') return
      if (event.type !== 'assistant_text') return
      if (titled.has(rt.sessionId)) return
      titled.add(rt.sessionId)
      callCount++
      const sessions = listChatSessions(proj)
      if (sessions.find((s) => s.sessionId === rt.sessionId)?.title) return
      renameChatSession(rt.sessionId, 'Auto-titled')
    })

    emit('s5', { type: 'user_text', text: 'Hello' })
    emit('s5', { type: 'assistant_text', text: 'First reply' })
    emit('s5', { type: 'assistant_text', text: 'Second reply text chunk' })

    // After two assistant_text events, renameChatSession was called exactly once.
    expect(callCount).toBe(1)

    setOnEmit(null)
    removeRuntime('s5')
  })
})

describe('findIntents (read-only intent-agent query)', () => {
  it('matches keyword as a substring over BOTH title and content', () => {
    insertIntents(proj, [
      { title: '登录鉴权', content: 'OAuth flow', priority: 'P0' },
      { title: '会话管理', content: '处理 token 刷新', priority: 'P1' },
      { title: '导出报表', content: 'CSV export', priority: 'P2' },
    ])
    // hits the title of the first item
    expect(findIntents(proj, { keyword: '鉴权' }).map((r) => r.title)).toEqual(['登录鉴权'])
    // hits the content of the second item
    expect(findIntents(proj, { keyword: 'token' }).map((r) => r.title)).toEqual(['会话管理'])
    // no match → empty
    expect(findIntents(proj, { keyword: 'nope' })).toEqual([])
  })

  it('returns the full project ledger when no filter is given (priority then recency order)', () => {
    insertIntents(proj, [
      { title: 'A', content: '', priority: 'P2' },
      { title: 'B', content: '', priority: 'P0' },
    ])
    expect(findIntents(proj).map((r) => r.title)).toEqual(['B', 'A'])
  })

  it('filters by module (exact) and by status, composing with AND', () => {
    const [a] = insertIntents(proj, [{ title: 'A', content: 'x', priority: 'P0', module: '认证' }])
    insertIntents(proj, [
      { title: 'B', content: 'x', priority: 'P0', module: '会话' },
      { title: 'C', content: 'x', priority: 'P0', module: '认证' },
    ])
    updateStatus(a.id, 'in_progress')
    // module filter
    expect(
      findIntents(proj, { module: '认证' })
        .map((r) => r.title)
        .sort(),
    ).toEqual(['A', 'C'])
    // status filter
    expect(findIntents(proj, { status: 'in_progress' }).map((r) => r.title)).toEqual(['A'])
    // module AND status (+ keyword) all compose
    expect(
      findIntents(proj, { module: '认证', status: 'todo', keyword: 'x' }).map((r) => r.title),
    ).toEqual(['C'])
  })

  it('hydrates dependsOn on the returned rows', () => {
    insertIntents(proj, [{ title: 'Dep', content: '', priority: 'P0', dependsOn: ['ext-1'] }])
    expect(findIntents(proj, { keyword: 'Dep' })[0].dependsOn).toEqual(['ext-1'])
  })

  it('never leaks another project (project-scoped, resolve-normalized)', () => {
    insertIntents(proj, [{ title: 'Mine', content: 'secret', priority: 'P0' }])
    insertIntents('/abs/project-b', [{ title: 'Theirs', content: 'secret', priority: 'P0' }])
    // a keyword common to both only returns this project's rows
    expect(findIntents(proj, { keyword: 'secret' }).map((r) => r.title)).toEqual(['Mine'])
    // trailing slash resolves to the same key
    expect(findIntents('/abs/project-a/', { keyword: 'secret' }).map((r) => r.title)).toEqual([
      'Mine',
    ])
  })

  it('treats LIKE wildcards in the keyword literally (escaped)', () => {
    insertIntents(proj, [
      { title: '100% done', content: '', priority: 'P0' },
      { title: 'anything', content: '', priority: 'P0' },
    ])
    // '%' must match literally, not as a wildcard (else it would match both)
    expect(findIntents(proj, { keyword: '100%' }).map((r) => r.title)).toEqual(['100% done'])
  })
})

describe('canTransition (status guard, 7-state graph)', () => {
  // ── same-state (no-op) ──
  it('allows same-state transitions (no-op)', () => {
    const all: import('@ccc/shared/protocol').IntentStatus[] = [
      'draft', 'todo', 'in_progress', 'done', 'cancelled', 'blocked', 'failed',
    ]
    for (const s of all) expect(canTransition(s, s)).toBe(true)
  })

  // ── forward transitions ──
  it('draft → todo, cancelled, blocked', () => {
    expect(canTransition('draft', 'todo')).toBe(true)
    expect(canTransition('draft', 'cancelled')).toBe(true)
    expect(canTransition('draft', 'blocked')).toBe(true)
  })

  it('todo → in_progress, cancelled, blocked', () => {
    expect(canTransition('todo', 'in_progress')).toBe(true)
    expect(canTransition('todo', 'cancelled')).toBe(true)
    expect(canTransition('todo', 'blocked')).toBe(true)
  })

  it('in_progress → done, cancelled, blocked, failed', () => {
    expect(canTransition('in_progress', 'done')).toBe(true)
    expect(canTransition('in_progress', 'cancelled')).toBe(true)
    expect(canTransition('in_progress', 'blocked')).toBe(true)
    expect(canTransition('in_progress', 'failed')).toBe(true)
  })

  it('blocked → todo, cancelled', () => {
    expect(canTransition('blocked', 'todo')).toBe(true)
    expect(canTransition('blocked', 'cancelled')).toBe(true)
  })

  it('failed → todo, cancelled', () => {
    expect(canTransition('failed', 'todo')).toBe(true)
    expect(canTransition('failed', 'cancelled')).toBe(true)
  })

  // ── illegal outgoing from terminal ──
  it('done transitions nowhere', () => {
    const nonTerminal: import('@ccc/shared/protocol').IntentStatus[] = [
      'draft', 'todo', 'in_progress', 'blocked', 'failed',
    ]
    for (const s of nonTerminal) expect(canTransition('done', s)).toBe(false)
  })

  it('cancelled transitions nowhere', () => {
    const nonTerminal: import('@ccc/shared/protocol').IntentStatus[] = [
      'draft', 'todo', 'in_progress', 'blocked', 'failed',
    ]
    for (const s of nonTerminal) expect(canTransition('cancelled', s)).toBe(false)
  })

  // ── illegal skip transitions ──
  it('draft cannot skip to in_progress, done, failed', () => {
    expect(canTransition('draft', 'in_progress')).toBe(false)
    expect(canTransition('draft', 'done')).toBe(false)
    expect(canTransition('draft', 'failed')).toBe(false)
  })

  it('todo cannot skip to done, failed', () => {
    expect(canTransition('todo', 'done')).toBe(false)
    expect(canTransition('todo', 'failed')).toBe(false)
  })

  it('in_progress cannot go back to draft, todo', () => {
    expect(canTransition('in_progress', 'draft')).toBe(false)
    expect(canTransition('in_progress', 'todo')).toBe(false)
  })

  it('blocked cannot go to in_progress, done, draft, failed', () => {
    expect(canTransition('blocked', 'in_progress')).toBe(false)
    expect(canTransition('blocked', 'done')).toBe(false)
    expect(canTransition('blocked', 'draft')).toBe(false)
    expect(canTransition('blocked', 'failed')).toBe(false)
  })

  it('failed cannot go to in_progress, done, draft, blocked', () => {
    expect(canTransition('failed', 'in_progress')).toBe(false)
    expect(canTransition('failed', 'done')).toBe(false)
    expect(canTransition('failed', 'draft')).toBe(false)
    expect(canTransition('failed', 'blocked')).toBe(false)
  })
})

describe('intent_sessions CRUD (dev session execution records)', () => {
  it('inserts a record and returns auto-increment id', () => {
    const id1 = insertIntentSession('intent-1', 'sess-001', 'claude', 'agent-a')
    expect(id1).toBeGreaterThan(0)
    const id2 = insertIntentSession('intent-1', 'sess-002', 'codex', 'agent-b')
    expect(id2).toBeGreaterThan(id1) // auto-increment
  })

  it('inserts optional fields as null when omitted', () => {
    const id = insertIntentSession('intent-2', 'sess-003', 'claude')
    const got = getIntentSession(id)
    expect(got).not.toBeNull()
    expect(got!.agentId).toBeNull()
    expect(got!.summary).toBeNull()
    expect(got!.startAt).toBeNull()
    expect(got!.endAt).toBeNull()
    expect(got!.exitCode).toBeNull()
    expect(got!.vendor).toBe('claude')
    expect(got!.intentId).toBe('intent-2')
    expect(got!.sessionId).toBe('sess-003')
    expect(got!.createdAt).toBeGreaterThan(0)
  })

  it('listIntentSessions returns records for an intent, newest first', () => {
    insertIntentSession('intent-3', 'sess-a', 'claude')
    // slight delay to ensure ordering
    insertIntentSession('intent-3', 'sess-b', 'opencode')
    insertIntentSession('intent-3', 'sess-c', 'codex')

    const list = listIntentSessions('intent-3')
    expect(list).toHaveLength(3)
    // newest first by created_at
    expect(list[0].sessionId).toBe('sess-c')
    expect(list[1].sessionId).toBe('sess-b')
    expect(list[2].sessionId).toBe('sess-a')
    // each record has the right vendor
    expect(list[0].vendor).toBe('codex')
    expect(list[1].vendor).toBe('opencode')
    expect(list[2].vendor).toBe('claude')
  })

  it('listIntentSessions scopes by intent (no cross-contamination)', () => {
    insertIntentSession('intent-A', 'sess-a1', 'claude')
    insertIntentSession('intent-B', 'sess-b1', 'codex')

    const aList = listIntentSessions('intent-A')
    expect(aList).toHaveLength(1)
    expect(aList[0].sessionId).toBe('sess-a1')

    expect(listIntentSessions('intent-B')).toHaveLength(1)
    expect(listIntentSessions('intent-Z')).toEqual([]) // non-existent intent
  })

  it('getIntentSession returns null for non-existent id', () => {
    expect(getIntentSession(99999)).toBeNull()
  })

  it('persists across a cache reset (real db file)', () => {
    const id = insertIntentSession('intent-4', 'sess-persist', 'claude')
    resetDbForTests()
    resetStoreForTests()
    const got = getIntentSession(id)
    expect(got).not.toBeNull()
    expect(got!.sessionId).toBe('sess-persist')
    expect(got!.intentId).toBe('intent-4')
  })

  it('inserts with agentId when provided', () => {
    const id = insertIntentSession('intent-5', 'sess-004', 'codex', 'agent-x')
    const got = getIntentSession(id)
    expect(got!.agentId).toBe('agent-x')
  })
})
