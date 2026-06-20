/**
 * Integration tests for the wait-user-involve event store over the shared c3.db adapter.
 *
 * Covers: schema/index creation, the migration paradigm (an old db with NO
 * events table → created on first access), and full CRUD (create → get → list
 * with status filter + project scope + resolve()-normalization, status updates,
 * cancelBySourceId batch cancel). Runs under Node's `node:sqlite` branch via
 * real temp files.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
// Stub the workspace registry: the store maps its `workspace_path` column to an
// opaque `workspaceId` via `pathToId`. In isolation these synthetic paths are
// unregistered, so mock `pathToId` as identity — the round-trip assertions then
// hold against the resolved path the rows store.
vi.mock('../../state.js', () => ({ pathToId: (p: string) => p }))
import { getDb, resetDbForTests } from '../../kernel/infra/db.js'
import {
  cancelBySourceId,
  createEvent,
  getEvent,
  getEventByRequestId,
  isStoreAvailable,
  listEvents,
  resetStoreForTests,
  updateStatus,
} from './store.js'

let dir: string
const proj = '/abs/project-a'

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'c3-wui-'))
  process.env.C3_DB_PATH = join(dir, 'c3.db')
  resetDbForTests()
  resetStoreForTests()
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
    expect(indexes).toContain('idx_wui_source_status')
  })
})

describe('events CRUD', () => {
  it('creates an event with defaults and reads it back', () => {
    const ev = createEvent({ workspacePath: proj, source: 'session' })
    expect(ev.status).toBe('todo') // default
    expect(ev.source).toBe('session')
    expect(ev.title).toBeNull()
    expect(ev.sourceId).toBeNull()
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
      source: 'discussion',
      sourceId: 'disc-1',
      title: '需要审批文件写入',
      requestId: 'req-abc',
      toolName: 'Write',
      toolInput: { file: '/tmp/a.txt', content: 'data' },
    })
    expect(ev.source).toBe('discussion')
    expect(ev.sourceId).toBe('disc-1')
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
      source: 'session',
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
    const ev = createEvent({ workspacePath: proj, source: 'session' })
    expect(ev.outcome).toBeNull()
  })

  it('lists events for a project, ordered by created_at descending', () => {
    createEvent({ workspacePath: proj, source: 'session' })
    createEvent({ workspacePath: proj, source: 'intent' })
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
    const a = createEvent({ workspacePath: proj, source: 'session' }) // todo
    const b = createEvent({ workspacePath: proj, source: 'intent' }) // todo
    updateStatus(a.id, 'done')

    const todo = listEvents(proj, 'todo')
    expect(todo.map((x) => x.id)).toEqual([b.id])

    const done = listEvents(proj, 'done')
    expect(done.map((x) => x.id)).toEqual([a.id])
  })

  it('scopes by project and normalizes the path (resolve)', () => {
    createEvent({ workspacePath: '/abs/project-a/', source: 'session' }) // trailing slash
    createEvent({ workspacePath: '/abs/project-b', source: 'session' })
    expect(listEvents('/abs/project-a').map((x) => x.source)).toEqual(['session'])
    expect(listEvents('/abs/project-b').map((x) => x.source)).toEqual(['session'])
  })

  it('updateStatus changes the status and bumps updated_at', () => {
    const ev = createEvent({ workspacePath: proj, source: 'session' })
    updateStatus(ev.id, 'done')
    const got = getEvent(ev.id)
    expect(got?.status).toBe('done')
    expect(got!.updatedAt).toBeGreaterThanOrEqual(ev.updatedAt)
  })

  it('getEventByRequestId finds an event by requestId and returns null for unknown ids', () => {
    const ev = createEvent({
      workspacePath: proj,
      source: 'session',
      sourceId: 'sess-1',
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

  it('cancelBySourceId cancels all todo events for a source and skips others', () => {
    // Two todo events for source 'sess-1', one for 'sess-2', one done for 'sess-1'.
    const todo1 = createEvent({
      workspacePath: proj,
      source: 'session',
      sourceId: 'sess-1',
      title: '待处理 1',
    })
    const todo2 = createEvent({
      workspacePath: proj,
      source: 'session',
      sourceId: 'sess-1',
      title: '待处理 2',
    })
    const other = createEvent({
      workspacePath: proj,
      source: 'session',
      sourceId: 'sess-2',
      title: '其他 session',
    })
    // Manually mark todo2 as done so it shouldn't be canceled
    updateStatus(todo2.id, 'done')

    cancelBySourceId('sess-1')

    // todo1 was todo → canceled
    expect(getEvent(todo1.id)?.status).toBe('canceled')
    // todo2 was already done → stays done
    expect(getEvent(todo2.id)?.status).toBe('done')
    // other was todo for different source → stays todo
    expect(getEvent(other.id)?.status).toBe('todo')
  })
})

describe('migration', () => {
  it('creates the events table on an old db that lacks it', () => {
    const raw = getDb()!
    raw.exec('CREATE TABLE unrelated (id TEXT PRIMARY KEY); PRAGMA user_version=7;')

    resetStoreForTests()
    expect(() => createEvent({ workspacePath: proj, source: 'session' })).not.toThrow()
    const tables = raw
      .all<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table'")
      .map((r) => r.name)
    expect(tables).toContain('wait_user_involve_events')
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
    expect(() => createEvent({ workspacePath: proj, source: 'session' })).toThrow(
      /待处理事件库不可用/,
    )
  })
})
