/**
 * The console's read-and-remove handlers.
 *
 * The store runs for real against a temp database (its own rules are pinned in
 * `store.test.ts`); only the workspace registry is stubbed, because what these
 * handlers own is the boundary: which workspace a request may reach, what the
 * listing is allowed to carry, and that a refused delete leaves the row exactly
 * where it was.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ServerToClient } from '@ccc/shared/protocol'
import type { KernelContext } from '../../kernel/types.js'
import type { Conn } from '../../transport/handler-registry.js'
import { resetDbForTests } from '../../kernel/infra/db.js'
import {
  createMemory,
  getMemory,
  listActiveMemories,
  resetMemoryStoreForTests,
  type MemoryCreateInput,
} from './store.js'
import { deleteWorkspaceMemoryHandler, listWorkspaceMemoriesHandler } from './handlers.js'

const h = vi.hoisted(() => ({
  /** Workspace names this deployment can resolve; anything else is unknown. */
  registry: new Map<string, string>([
    ['alpha', '/canon/alpha'],
    ['beta', '/canon/beta'],
  ]),
}))

vi.mock('../../state.js', () => ({
  resolveWorkspaceRoot: (name: string) => h.registry.get(name) ?? null,
}))

let home: string
let sent: ServerToClient[]

const ctx = {} as KernelContext
const conn = { send: (m: ServerToClient) => sent.push(m) } as unknown as Conn

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'c3-memory-handlers-'))
  process.env.C3_DB_PATH = join(home, 'c3.db')
  resetDbForTests()
  resetMemoryStoreForTests()
  sent = []
})

afterEach(() => {
  resetDbForTests()
  delete process.env.C3_DB_PATH
  resetMemoryStoreForTests()
  rmSync(home, { recursive: true, force: true })
})

function save(over: Partial<MemoryCreateInput> = {}, now?: number) {
  const input: MemoryCreateInput = {
    workspaceName: 'alpha',
    sourceSessionId: 'sess-1',
    type: 'preference',
    title: '提交信息用中文',
    content: '用户明确要求提交信息正文使用中文。',
    ...over,
  }
  return createMemory(input, now)
}

function list(workspaceName = 'alpha') {
  listWorkspaceMemoriesHandler(ctx, conn, { type: 'list_workspace_memories', workspaceName })
  return sent.at(-1)
}

function del(id: string, workspaceName = 'alpha') {
  deleteWorkspaceMemoryHandler(ctx, conn, { type: 'delete_workspace_memory', workspaceName, id })
  return sent.at(-1)
}

describe('list_workspace_memories', () => {
  it('summarizes the workspace active memories, newest first, without the body', () => {
    const older = save({ title: '早一点' }, 1_000)
    const newer = save({ title: '晚一点', type: 'lesson' }, 2_000)

    const reply = list()
    expect(reply).toEqual({
      type: 'workspace_memories',
      workspaceName: 'alpha',
      items: [
        { id: newer.id, title: '晚一点', type: 'lesson', status: 'active', updatedAt: 2_000 },
        { id: older.id, title: '早一点', type: 'preference', status: 'active', updatedAt: 1_000 },
      ],
    })
    // The listing is a summary: the prose never leaves the store for this page.
    const items = reply?.type === 'workspace_memories' ? reply.items : []
    for (const item of items) expect(item).not.toHaveProperty('content')
  })

  it('never lets one workspace see another workspace memories', () => {
    save({ title: 'alpha 的' })
    save({ workspaceName: 'beta', title: 'beta 的' })

    const alpha = list('alpha')
    const beta = list('beta')
    expect(alpha?.type === 'workspace_memories' && alpha.items.map((i) => i.title)).toEqual([
      'alpha 的',
    ])
    expect(beta?.type === 'workspace_memories' && beta.items.map((i) => i.title)).toEqual([
      'beta 的',
    ])
  })

  it('refuses a workspace this deployment cannot resolve', () => {
    expect(list('ghost')).toEqual({
      type: 'error',
      error: { code: 'workspace.unknown', params: { path: 'ghost' } },
    })
  })

  it('answers an empty workspace with an empty list rather than an error', () => {
    expect(list()).toEqual({ type: 'workspace_memories', workspaceName: 'alpha', items: [] })
  })
})

describe('delete_workspace_memory', () => {
  it('soft-deletes and reports the title the store actually removed', () => {
    const m = save({ title: '要被删掉的' })
    expect(del(m.id)).toEqual({
      type: 'workspace_memory_deleted',
      workspaceName: 'alpha',
      id: m.id,
      title: '要被删掉的',
    })
    // Soft: the row is still there, just no longer active — the janitor's
    // recovery window is what physically removes it.
    expect(getMemory('alpha', m.id)?.status).toBe('deleted')
  })

  it('drops the row from every later listing', () => {
    const kept = save({ title: '留下的' }, 2_000)
    const gone = save({ title: '删掉的' }, 1_000)
    del(gone.id)

    const reply = list()
    expect(reply?.type === 'workspace_memories' && reply.items.map((i) => i.id)).toEqual([kept.id])
  })

  it('is idempotent — deleting twice still confirms the same title', () => {
    const m = save({ title: '删两次' })
    expect(del(m.id)).toEqual(del(m.id))
  })

  it('refuses an id from another workspace and changes nothing', () => {
    const foreign = save({ workspaceName: 'beta', title: 'beta 的' })
    expect(del(foreign.id, 'alpha')).toEqual({ type: 'error', error: { code: 'memory.notFound' } })
    expect(listActiveMemories('beta').map((m) => m.id)).toEqual([foreign.id])
  })

  it('refuses an id that does not exist', () => {
    expect(del('no-such-id')).toEqual({ type: 'error', error: { code: 'memory.notFound' } })
  })

  it('refuses a workspace this deployment cannot resolve, before touching the store', () => {
    const m = save({ title: '不该被碰' })
    expect(del(m.id, 'ghost')).toEqual({
      type: 'error',
      error: { code: 'workspace.unknown', params: { path: 'ghost' } },
    })
    expect(getMemory('alpha', m.id)?.status).toBe('active')
  })

  it('reports an unavailable store as a refusal, never as a delete that happened', () => {
    const m = save({ title: '库挂了' })
    // A database path whose parent is a regular FILE cannot be opened on any
    // platform: the delete must fail loudly rather than answer a receipt.
    writeFileSync(join(home, 'blocker'), 'not a directory')
    process.env.C3_DB_PATH = join(home, 'blocker', 'c3.db')
    resetDbForTests()
    resetMemoryStoreForTests()

    expect(del(m.id)).toEqual({ type: 'error', error: { code: 'memory.unavailable' } })
  })
})
