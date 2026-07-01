/**
 * Integration tests for the wait-user-involve event store over the shared c3.db adapter.
 *
 * Covers: schema/index creation, the migration paradigm (an old db with NO events
 * table → created on first access; the v4→v5 `source/source_id` →
 * `session_kind/session_id` column rename), the `toEvent` unregistered-workspace
 * drop, the `session_id` → intent reverse-lookup derivation (`intentId`/`intentTitle`),
 * and full CRUD (create → get → list with status filter + project scope +
 * resolve()-normalization, status updates, cancelBySessionId batch cancel). Runs under
 * Node's `node:sqlite` branch via real temp files.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
// Stub the workspace registry: the store maps its `workspace_path` column to an
// opaque `workspaceId` via `pathToId`. In isolation these synthetic paths are
// unregistered, so mock `pathToId` as identity — the round-trip assertions then
// hold against the resolved path the rows store. A path containing 'unregistered'
// resolves to `null`, exercising the `toEvent` drop-on-unregistered-workspace path.
vi.mock('../../state.js', () => ({
  pathToId: (p: string) => (p.includes('unregistered') ? null : p),
}))
// Stub the intents store: `toEvent` reverse-looks-up the owning intent from an
// event's `session_id`. Default to "no owning intent" so ordinary events derive
// `intentId`/`intentTitle` as null; the derivation test overrides these.
const findIntentIdByAnySessionId = vi.fn<(sessionId: string) => string | null>(() => null)
const getIntent = vi.fn<(id: string) => { title: string } | null>(() => null)
vi.mock('../intents/store.js', () => ({
  findIntentIdByAnySessionId: (id: string) => findIntentIdByAnySessionId(id),
  getIntent: (id: string) => getIntent(id),
}))
import { getDb, resetDbForTests } from '../../kernel/infra/db.js'
import {
  cancelBySessionId,
  createEvent,
  getEvent,
  getEventByRequestId,
  isStoreAvailable,
  listEvents,
  listEventsPage,
  resetStoreForTests,
  retentionDelete,
  updateStatus,
} from './store.js'

let dir: string
const proj = '/abs/project-a'

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'c3-wui-'))
  process.env.C3_DB_PATH = join(dir, 'c3.db')
  resetDbForTests()
  resetStoreForTests()
  findIntentIdByAnySessionId.mockReset()
  findIntentIdByAnySessionId.mockReturnValue(null)
  getIntent.mockReset()
  getIntent.mockReturnValue(null)
})

afterEach(() => {
  resetDbForTests()
  delete process.env.C3_DB_PATH
  rmSync(dir, { recursive: true, force: true })
})

describe('schema', () => {
  it('creates the events table and its indexes on first access', () => {
    expect(isStoreAvailable()).toBe(true)
    // First store call triggers schema-ensure.
    expect(listEvents(proj)).toEqual([])
    const raw = getDb()!
    const tables = raw
      .all<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table'")
      .map((r) => r.name)
    expect(tables).toContain('wait_user_involve_events')
    const indexes = raw
      .all<{ name: string }>("SELECT name FROM sqlite_master WHERE type='index'")
      .map((r) => r.name)
    expect(indexes).toContain('idx_wui_workspace_status')
    expect(indexes).toContain('idx_wui_session_status')
  })
})

describe('events CRUD', () => {
  it('creates an event with defaults and reads it back', () => {
    const ev = createEvent({ workspacePath: proj, sessionKind: 'work' })
    expect(ev.status).toBe('todo') // default
    expect(ev.sessionKind).toBe('work')
    expect(ev.title).toBeNull()
    expect(ev.sessionId).toBeNull()
    expect(ev.intentId).toBeNull()
    expect(ev.intentTitle).toBeNull()
    expect(ev.requestId).toBeNull()
    expect(ev.toolName).toBeNull()
    expect(ev.toolInput).toBeNull()
    expect(ev.createdAt).toBe(ev.updatedAt)

    const got = getEvent(ev.id)
    expect(got?.id).toBe(ev.id)
    expect(got?.workspaceId).toBe(resolve(proj))
  })

  it('honors all explicit fields and persists toolInput as JSON', () => {
    const ev = createEvent({
      workspacePath: proj,
      sessionKind: 'discussion',
      sessionId: 'disc-1',
      title: '需要审批文件写入',
      requestId: 'req-abc',
      toolName: 'Write',
      toolInput: { file: '/tmp/a.txt', content: 'data' },
    })
    expect(ev.sessionKind).toBe('discussion')
    expect(ev.sessionId).toBe('disc-1')
    expect(ev.title).toBe('需要审批文件写入')
    expect(ev.requestId).toBe('req-abc')
    expect(ev.toolName).toBe('Write')
    expect(ev.toolInput).toEqual({ file: '/tmp/a.txt', content: 'data' })
  })

  it("persists a 'auto' record with its consensus outcome and reads it back", () => {
    const outcome = {
      kind: 'tool' as const,
      votes: [{ agentId: 'a2', agentName: 'Reviewer', decision: 'allow' as const, reason: 'ok' }],
      summary: 'unanimous allow',
      unanimous: true,
      decision: 'allow' as const,
    }
    const ev = createEvent({
      workspacePath: proj,
      sessionKind: 'work',
      toolName: 'edit_file',
      status: 'auto',
      outcome,
    })
    expect(ev.status).toBe('auto')
    expect(ev.outcome).toEqual(outcome)
    // Round-trips through a fresh read (JSON column parse).
    expect(getEvent(ev.id)?.outcome).toEqual(outcome)
    // 'auto' records never appear in the 'todo' badge list.
    expect(listEvents(proj, 'todo')).toHaveLength(0)
    expect(listEvents(proj, 'auto')).toHaveLength(1)
  })

  it('leaves outcome null for ordinary human-decided events', () => {
    const ev = createEvent({ workspacePath: proj, sessionKind: 'work' })
    expect(ev.outcome).toBeNull()
  })

  it('lists events for a project, ordered by created_at descending', () => {
    createEvent({ workspacePath: proj, sessionKind: 'work' })
    createEvent({ workspacePath: proj, sessionKind: 'intent' })
    const list = listEvents(proj)
    // b was created after a, so b should come first (DESC order)
    const titles = list.map((x) => x.id)
    expect(titles.length).toBe(2)
    // Contract: the array is ordered by created_at DESC (idempotent: created
    // at sub-millisecond granularity, so assert the property, not permutation).
    for (let i = 1; i < list.length; i++) {
      expect(list[i - 1].createdAt).toBeGreaterThanOrEqual(list[i].createdAt)
    }
  })

  it('filters by status when provided', () => {
    const a = createEvent({ workspacePath: proj, sessionKind: 'work' }) // todo
    const b = createEvent({ workspacePath: proj, sessionKind: 'intent' }) // todo
    updateStatus(a.id, 'done')

    const todo = listEvents(proj, 'todo')
    expect(todo.map((x) => x.id)).toEqual([b.id])

    const done = listEvents(proj, 'done')
    expect(done.map((x) => x.id)).toEqual([a.id])
  })

  it('pages events by created_at and id without duplicating equal timestamps', () => {
    const raw = getDb()!
    const ids = ['a', 'b', 'c', 'd', 'e']
    for (const id of ids) createEvent({ workspacePath: proj, sessionKind: 'work', title: id })
    for (const id of ids) {
      raw.run('UPDATE wait_user_involve_events SET id=?, created_at=? WHERE title=?', id, 100, id)
    }

    const first = listEventsPage(proj, undefined, undefined, undefined, 2)
    expect(first.items.map((event) => event.id)).toEqual(['e', 'd'])
    expect(first.hasMore).toBe(true)

    const last = first.items.at(-1)!
    const second = listEventsPage(proj, undefined, last.createdAt, last.id, 2)
    expect(second.items.map((event) => event.id)).toEqual(['c', 'b'])
    expect(second.hasMore).toBe(true)

    const thirdLast = second.items.at(-1)!
    const third = listEventsPage(proj, undefined, thirdLast.createdAt, thirdLast.id, 2)
    expect(third.items.map((event) => event.id)).toEqual(['a'])
    expect(third.hasMore).toBe(false)
  })

  it('retentionDelete removes only old resolved and audit events', () => {
    const raw = getDb()!
    const old = 10
    const recent = 1_000
    const oldTodo = createEvent({ workspacePath: proj, sessionKind: 'work', title: 'old-todo' })
    const oldDone = createEvent({
      workspacePath: proj,
      sessionKind: 'work',
      title: 'old-done',
      status: 'done',
    })
    const oldCanceled = createEvent({
      workspacePath: proj,
      sessionKind: 'work',
      title: 'old-canceled',
      status: 'canceled',
    })
    const oldAuto = createEvent({
      workspacePath: proj,
      sessionKind: 'work',
      title: 'old-auto',
      status: 'auto',
    })
    const recentDone = createEvent({
      workspacePath: proj,
      sessionKind: 'work',
      title: 'recent-done',
      status: 'done',
    })
    for (const event of [oldTodo, oldDone, oldCanceled, oldAuto]) {
      raw.run('UPDATE wait_user_involve_events SET created_at=? WHERE id=?', old, event.id)
    }
    raw.run('UPDATE wait_user_involve_events SET created_at=? WHERE id=?', recent, recentDone.id)

    expect(retentionDelete(100, ['done', 'canceled', 'auto'])).toBe(3)
    expect(getEvent(oldTodo.id)?.status).toBe('todo')
    expect(getEvent(oldDone.id)).toBeNull()
    expect(getEvent(oldCanceled.id)).toBeNull()
    expect(getEvent(oldAuto.id)).toBeNull()
    expect(getEvent(recentDone.id)?.status).toBe('done')
  })

  it('scopes by project and normalizes the path (resolve)', () => {
    createEvent({ workspacePath: '/abs/project-a/', sessionKind: 'work' }) // trailing slash
    createEvent({ workspacePath: '/abs/project-b', sessionKind: 'work' })
    expect(listEvents('/abs/project-a').map((x) => x.sessionKind)).toEqual(['work'])
    expect(listEvents('/abs/project-b').map((x) => x.sessionKind)).toEqual(['work'])
  })

  it('updateStatus changes the status and bumps updated_at', () => {
    const ev = createEvent({ workspacePath: proj, sessionKind: 'work' })
    updateStatus(ev.id, 'done')
    const got = getEvent(ev.id)
    expect(got?.status).toBe('done')
    expect(got!.updatedAt).toBeGreaterThanOrEqual(ev.updatedAt)
  })

  it('getEventByRequestId finds an event by requestId and returns null for unknown ids', () => {
    const ev = createEvent({
      workspacePath: proj,
      sessionKind: 'work',
      sessionId: 'sess-1',
      requestId: 'req-abc',
      toolName: 'Write',
      toolInput: { file: '/tmp/a.txt', content: 'data' },
    })
    const found = getEventByRequestId('req-abc')
    expect(found?.id).toBe(ev.id)
    expect(found?.requestId).toBe('req-abc')
    expect(found?.toolName).toBe('Write')
    expect(found?.toolInput).toEqual({ file: '/tmp/a.txt', content: 'data' })

    // Unknown requestId returns null.
    expect(getEventByRequestId('no-such-id')).toBeNull()
  })

  it('cancelBySessionId cancels all todo events for a session and skips others', () => {
    // Two todo events for session 'sess-1', one for 'sess-2', one done for 'sess-1'.
    const todo1 = createEvent({
      workspacePath: proj,
      sessionKind: 'work',
      sessionId: 'sess-1',
      title: '待处理 1',
    })
    const todo2 = createEvent({
      workspacePath: proj,
      sessionKind: 'work',
      sessionId: 'sess-1',
      title: '待处理 2',
    })
    const other = createEvent({
      workspacePath: proj,
      sessionKind: 'work',
      sessionId: 'sess-2',
      title: '其他 session',
    })
    // Manually mark todo2 as done so it shouldn't be canceled
    updateStatus(todo2.id, 'done')

    cancelBySessionId('sess-1')

    // todo1 was todo → canceled
    expect(getEvent(todo1.id)?.status).toBe('canceled')
    // todo2 was already done → stays done
    expect(getEvent(todo2.id)?.status).toBe('done')
    // other was todo for different session → stays todo
    expect(getEvent(other.id)?.status).toBe('todo')
  })
})

describe('intent reverse-lookup derivation', () => {
  it('derives intentId + intentTitle from an event session_id bound to an intent', () => {
    findIntentIdByAnySessionId.mockImplementation((id) =>
      id === 'sess-intent' ? 'intent-9' : null,
    )
    getIntent.mockImplementation((id) => (id === 'intent-9' ? { title: 'My intent' } : null))

    const ev = createEvent({
      workspacePath: proj,
      sessionKind: 'intent',
      sessionId: 'sess-intent',
    })
    expect(ev.intentId).toBe('intent-9')
    expect(ev.intentTitle).toBe('My intent')
    expect(findIntentIdByAnySessionId).toHaveBeenCalledWith('sess-intent')
  })

  it('leaves intentId + intentTitle null for a session with no owning intent (work session)', () => {
    const ev = createEvent({
      workspacePath: proj,
      sessionKind: 'work',
      sessionId: 'sess-work',
    })
    expect(ev.intentId).toBeNull()
    expect(ev.intentTitle).toBeNull()
  })

  it('leaves intentTitle null when the intent id resolves but the intent is gone', () => {
    findIntentIdByAnySessionId.mockReturnValue('intent-x')
    getIntent.mockReturnValue(null)
    const ev = createEvent({
      workspacePath: proj,
      sessionKind: 'intent',
      sessionId: 'sess-x',
    })
    expect(ev.intentId).toBe('intent-x')
    expect(ev.intentTitle).toBeNull()
  })

  it('does not run the lookup when session_id is null', () => {
    const ev = createEvent({ workspacePath: proj, sessionKind: 'work' })
    expect(ev.intentId).toBeNull()
    expect(findIntentIdByAnySessionId).not.toHaveBeenCalled()
  })

  it('derives intentLevel=true when sessionKind=intent and sessionId equals the intent id (pushFailureEvent path)', () => {
    findIntentIdByAnySessionId.mockImplementation((id) =>
      id === 'intent-obj-id' ? 'intent-obj-id' : null,
    )
    const ev = createEvent({
      workspacePath: proj,
      sessionKind: 'intent',
      sessionId: 'intent-obj-id',
    })
    expect(ev.intentLevel).toBe(true)
  })

  it('derives intentLevel=false when sessionKind=intent but sessionId differs from intent id (real session)', () => {
    findIntentIdByAnySessionId.mockImplementation((id) =>
      id === 'real-session-id' ? 'intent-42' : null,
    )
    const ev = createEvent({
      workspacePath: proj,
      sessionKind: 'intent',
      sessionId: 'real-session-id',
    })
    expect(ev.intentLevel).toBe(false)
  })

  it('derives intentLevel=false/absent for non-intent sessionKinds', () => {
    const ev = createEvent({ workspacePath: proj, sessionKind: 'work', sessionId: 'ws-1' })
    expect(ev.intentLevel).toBeFalsy()
  })
})

describe('migration', () => {
  it('creates the events table on an old db that lacks it', () => {
    const raw = getDb()!
    raw.exec('CREATE TABLE unrelated (id TEXT PRIMARY KEY); PRAGMA user_version=7;')

    resetStoreForTests()
    expect(() => createEvent({ workspacePath: proj, sessionKind: 'work' })).not.toThrow()
    const tables = raw
      .all<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table'")
      .map((r) => r.name)
    expect(tables).toContain('wait_user_involve_events')
  })

  it('renames legacy source/source_id columns to session_kind/session_id (v4→v5)', () => {
    const raw = getDb()!
    // A pre-v5 table carrying the old column names + index, schema not yet ensured.
    raw.exec(`CREATE TABLE wait_user_involve_events (
      id TEXT PRIMARY KEY, workspace_path TEXT NOT NULL, source TEXT NOT NULL, source_id TEXT,
      title TEXT, request_id TEXT, tool_name TEXT, tool_input TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL, outcome TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE INDEX idx_wui_source_status ON wait_user_involve_events(source_id, status);
    PRAGMA user_version=4;`)
    raw.run(
      `INSERT INTO wait_user_involve_events
         (id, workspace_path, source, source_id, status, tool_input, created_at, updated_at)
       VALUES ('legacy-1', ?, 'spec', 'sess-legacy', 'todo', '', 1, 1)`,
      resolve(proj),
    )

    resetStoreForTests()
    // First store access runs the v4→v5 column rename in place (values preserved).
    const list = listEvents(proj)
    expect(list).toHaveLength(1)
    expect(list[0].sessionKind).toBe('spec')
    expect(list[0].sessionId).toBe('sess-legacy')

    // Columns + index reflect the new names.
    const cols = raw
      .all<{ name: string }>('PRAGMA table_info(wait_user_involve_events)')
      .map((c) => c.name)
    expect(cols).toContain('session_kind')
    expect(cols).toContain('session_id')
    expect(cols).not.toContain('source')
    expect(cols).not.toContain('source_id')
    const indexes = raw
      .all<{ name: string }>("SELECT name FROM sqlite_master WHERE type='index'")
      .map((r) => r.name)
    expect(indexes).toContain('idx_wui_session_status')
    expect(indexes).not.toContain('idx_wui_source_status')
  })
})

describe('unregistered-workspace degradation', () => {
  it('omits an event whose workspace is no longer registered (no broken id emitted)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const unreg = '/abs/unregistered-ws'
    // The row persists, but `pathToId` returns null for an unregistered workspace, so
    // `toEvent` must drop it rather than emit `workspaceId: null as string`.
    createEvent({ workspacePath: unreg, sessionKind: 'work' })
    expect(listEvents(unreg)).toEqual([])
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})

describe('degradation', () => {
  it('reads return empty/null and writes throw when the db is unavailable', () => {
    process.env.C3_DB_PATH = '/dev/null/nope/c3.db' // open fails
    resetDbForTests()
    resetStoreForTests()
    expect(isStoreAvailable()).toBe(false)
    expect(listEvents(proj)).toEqual([])
    expect(getEvent('x')).toBeNull()
    expect(() => createEvent({ workspacePath: proj, sessionKind: 'work' })).toThrow(
      /待处理事件库不可用/,
    )
  })
})
