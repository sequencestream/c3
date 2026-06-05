import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getDb, resetDbForTests } from '../../kernel/infra/db.js'
import {
  findRequirements,
  getChatSession,
  getRequirement,
  insertRequirements,
  isHiddenSession,
  isStoreAvailable,
  listHiddenSessions,
  listRequirements,
  rebindChatSession,
  resetStoreForTests,
  resolveBatchDependencies,
  setChatSession,
  setLastDevSession,
  updateRequirement,
  updateStatus,
} from './store.js'

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

describe('requirements CRUD', () => {
  it('inserts a batch as todo and lists with dependsOn, in insertion order', () => {
    expect(isStoreAvailable()).toBe(true)
    const saved = insertRequirements(proj, [
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
    const list = listRequirements(proj)
    expect(list.map((r) => r.title)).toEqual(['B', 'A'])
  })

  it('filters by status', () => {
    const [a] = insertRequirements(proj, [{ title: 'A', content: '', priority: 'P2' }])
    insertRequirements(proj, [{ title: 'B', content: '', priority: 'P2' }])
    updateStatus(a.id, 'in_progress')
    expect(listRequirements(proj, 'todo').map((r) => r.title)).toEqual(['B'])
    expect(listRequirements(proj, 'in_progress').map((r) => r.title)).toEqual(['A'])
  })

  it('scopes by project', () => {
    insertRequirements(proj, [{ title: 'A', content: '', priority: 'P0' }])
    insertRequirements('/abs/project-b', [{ title: 'B', content: '', priority: 'P0' }])
    expect(listRequirements(proj).map((r) => r.title)).toEqual(['A'])
    expect(listRequirements('/abs/project-b').map((r) => r.title)).toEqual(['B'])
  })

  it('normalizes project paths (resolve)', () => {
    insertRequirements('/abs/project-a/', [{ title: 'A', content: '', priority: 'P0' }])
    // trailing slash resolves to the same key
    expect(listRequirements('/abs/project-a').map((r) => r.title)).toEqual(['A'])
  })

  it('records last dev session and updates status', () => {
    const [r] = insertRequirements(proj, [{ title: 'A', content: '', priority: 'P0' }])
    setLastDevSession(r.id, 'sess-123')
    updateStatus(r.id, 'in_progress')
    const got = getRequirement(r.id)
    expect(got?.lastDevSessionId).toBe('sess-123')
    expect(got?.status).toBe('in_progress')
  })

  it('patches fields and replaces dependencies', () => {
    const [r] = insertRequirements(proj, [
      { title: 'A', content: 'old', priority: 'P2', dependsOn: ['x'] },
    ])
    updateRequirement(r.id, { content: 'new', priority: 'P0', dependsOn: ['y', 'z'] })
    const got = getRequirement(r.id)
    expect(got?.content).toBe('new')
    expect(got?.priority).toBe('P0')
    expect(got?.dependsOn.sort()).toEqual(['y', 'z'])
    expect(got?.title).toBe('A') // untouched
  })

  it('stamps completedAt when marked done and clears it when reverted', () => {
    const [r] = insertRequirements(proj, [{ title: 'A', content: '', priority: 'P0' }])
    expect(getRequirement(r.id)?.completedAt).toBeNull() // todo → no completion time

    updateStatus(r.id, 'done')
    const done = getRequirement(r.id)
    expect(typeof done?.completedAt).toBe('number') // done → stamped
    expect(done?.completedAt).toBeGreaterThan(0)

    updateStatus(r.id, 'in_progress')
    expect(getRequirement(r.id)?.completedAt).toBeNull() // reverted → cleared
  })

  it('keeps completedAt in sync when status is patched via updateRequirement', () => {
    const [r] = insertRequirements(proj, [{ title: 'A', content: '', priority: 'P0' }])
    updateRequirement(r.id, { status: 'done' })
    expect(typeof getRequirement(r.id)?.completedAt).toBe('number')
    updateRequirement(r.id, { status: 'cancelled' })
    expect(getRequirement(r.id)?.completedAt).toBeNull()
  })

  it('stores the inferred module and defaults to "" when omitted', () => {
    const saved = insertRequirements(proj, [
      { title: 'A', content: '', priority: 'P0', module: '认证' },
      { title: 'B', content: '', priority: 'P0' }, // module omitted → '' fallback
    ])
    const byTitle = new Map(saved.map((r) => [r.title, r]))
    expect(byTitle.get('A')?.module).toBe('认证')
    expect(byTitle.get('B')?.module).toBe('')
    // module survives a re-read
    expect(getRequirement(byTitle.get('A')!.id)?.module).toBe('认证')
  })

  it('persists across a cache reset (real file)', () => {
    const [r] = insertRequirements(proj, [{ title: 'A', content: '', priority: 'P0' }])
    resetDbForTests()
    resetStoreForTests()
    expect(getRequirement(r.id)?.title).toBe('A')
  })

  it('migrates a pre-v2 db: adds the module column, keeps historic rows, is idempotent', () => {
    // Build an old-schema requirements table (no `module` column) with one
    // historic row, mimicking a db created before this change.
    const raw = getDb()!
    raw.exec(`
      CREATE TABLE requirements (
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
      `INSERT INTO requirements
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
    const got = getRequirement('old-1')
    expect(got?.title).toBe('Legacy') // historic row survives
    expect(got?.module).toBe('') // backfilled default
    expect(got?.completedAt).toBeNull() // new nullable column, null for historic rows
    expect(got?.automate).toBe(false) // backfilled default (opt-in to automation)

    const cols = raw.all<{ name: string }>('PRAGMA table_info(requirements)')
    expect(cols.some((c) => c.name === 'module')).toBe(true)
    expect(cols.some((c) => c.name === 'completed_at')).toBe(true)
    expect(cols.some((c) => c.name === 'automate')).toBe(true)
    const version = raw.get<{ user_version: number }>('PRAGMA user_version')
    expect(version?.user_version).toBe(5)

    // Idempotent: a second ensure must not try to re-add the column (would throw).
    resetStoreForTests()
    expect(() => listRequirements(proj)).not.toThrow()
    expect(getRequirement('old-1')?.module).toBe('')
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

describe('insertRequirements — intra-batch dependencies', () => {
  it('resolves dependsOnIndexes to the sibling real id on save', () => {
    const [a, b] = insertRequirements(proj, [
      { title: 'A', content: '', priority: 'P0' },
      { title: 'B', content: '', priority: 'P0', dependsOnIndexes: [0] }, // depends on A
    ])
    expect(a.dependsOn).toEqual([])
    expect(b.dependsOn).toEqual([a.id])
  })

  it('merges existing-id deps with intra-batch index deps', () => {
    const [, b] = insertRequirements(proj, [
      { title: 'A', content: '', priority: 'P0' },
      { title: 'B', content: '', priority: 'P0', dependsOn: ['ext-id'], dependsOnIndexes: [0] },
    ])
    const a = listRequirements(proj).find((r) => r.title === 'A')!
    expect(b.dependsOn.sort()).toEqual(['ext-id', a.id].sort())
  })

  it('staggers created_at by batch index so submission order is stable', () => {
    const [a, b, c] = insertRequirements(proj, [
      { title: 'A', content: '', priority: 'P0' },
      { title: 'B', content: '', priority: 'P0' },
      { title: 'C', content: '', priority: 'P0' },
    ])
    expect(a.createdAt).toBeLessThan(b.createdAt)
    expect(b.createdAt).toBeLessThan(c.createdAt)
  })

  it('rejects the whole batch atomically on an out-of-range index (nothing persisted)', () => {
    expect(() =>
      insertRequirements(proj, [
        { title: 'A', content: '', priority: 'P0' },
        { title: 'B', content: '', priority: 'P0', dependsOnIndexes: [9] },
      ]),
    ).toThrow(/越界/)
    expect(listRequirements(proj)).toEqual([])
  })

  it('rejects the whole batch atomically on a self reference (nothing persisted)', () => {
    expect(() =>
      insertRequirements(proj, [
        { title: 'A', content: '', priority: 'P0', dependsOnIndexes: [0] },
      ]),
    ).toThrow(/自引用/)
    expect(listRequirements(proj)).toEqual([])
  })

  it('rejects the whole batch atomically on a cycle (nothing persisted)', () => {
    expect(() =>
      insertRequirements(proj, [
        { title: 'A', content: '', priority: 'P0', dependsOnIndexes: [1] },
        { title: 'B', content: '', priority: 'P0', dependsOnIndexes: [0] },
      ]),
    ).toThrow(/成环/)
    expect(listRequirements(proj)).toEqual([])
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
})

describe('findRequirements (read-only requirement-agent query)', () => {
  it('matches keyword as a substring over BOTH title and content', () => {
    insertRequirements(proj, [
      { title: '登录鉴权', content: 'OAuth flow', priority: 'P0' },
      { title: '会话管理', content: '处理 token 刷新', priority: 'P1' },
      { title: '导出报表', content: 'CSV export', priority: 'P2' },
    ])
    // hits the title of the first item
    expect(findRequirements(proj, { keyword: '鉴权' }).map((r) => r.title)).toEqual(['登录鉴权'])
    // hits the content of the second item
    expect(findRequirements(proj, { keyword: 'token' }).map((r) => r.title)).toEqual(['会话管理'])
    // no match → empty
    expect(findRequirements(proj, { keyword: 'nope' })).toEqual([])
  })

  it('returns the full project ledger when no filter is given (priority then recency order)', () => {
    insertRequirements(proj, [
      { title: 'A', content: '', priority: 'P2' },
      { title: 'B', content: '', priority: 'P0' },
    ])
    expect(findRequirements(proj).map((r) => r.title)).toEqual(['B', 'A'])
  })

  it('filters by module (exact) and by status, composing with AND', () => {
    const [a] = insertRequirements(proj, [
      { title: 'A', content: 'x', priority: 'P0', module: '认证' },
    ])
    insertRequirements(proj, [
      { title: 'B', content: 'x', priority: 'P0', module: '会话' },
      { title: 'C', content: 'x', priority: 'P0', module: '认证' },
    ])
    updateStatus(a.id, 'in_progress')
    // module filter
    expect(
      findRequirements(proj, { module: '认证' })
        .map((r) => r.title)
        .sort(),
    ).toEqual(['A', 'C'])
    // status filter
    expect(findRequirements(proj, { status: 'in_progress' }).map((r) => r.title)).toEqual(['A'])
    // module AND status (+ keyword) all compose
    expect(
      findRequirements(proj, { module: '认证', status: 'todo', keyword: 'x' }).map((r) => r.title),
    ).toEqual(['C'])
  })

  it('hydrates dependsOn on the returned rows', () => {
    insertRequirements(proj, [{ title: 'Dep', content: '', priority: 'P0', dependsOn: ['ext-1'] }])
    expect(findRequirements(proj, { keyword: 'Dep' })[0].dependsOn).toEqual(['ext-1'])
  })

  it('never leaks another project (project-scoped, resolve-normalized)', () => {
    insertRequirements(proj, [{ title: 'Mine', content: 'secret', priority: 'P0' }])
    insertRequirements('/abs/project-b', [{ title: 'Theirs', content: 'secret', priority: 'P0' }])
    // a keyword common to both only returns this project's rows
    expect(findRequirements(proj, { keyword: 'secret' }).map((r) => r.title)).toEqual(['Mine'])
    // trailing slash resolves to the same key
    expect(findRequirements('/abs/project-a/', { keyword: 'secret' }).map((r) => r.title)).toEqual([
      'Mine',
    ])
  })

  it('treats LIKE wildcards in the keyword literally (escaped)', () => {
    insertRequirements(proj, [
      { title: '100% done', content: '', priority: 'P0' },
      { title: 'anything', content: '', priority: 'P0' },
    ])
    // '%' must match literally, not as a wildcard (else it would match both)
    expect(findRequirements(proj, { keyword: '100%' }).map((r) => r.title)).toEqual(['100% done'])
  })
})
