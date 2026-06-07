/**
 * OpencodeTaskStore behaviour (ADR-0011 TaskStore amendment). Hermetic: the
 * `session.todo` REST call is mocked and `todo.updated` events are fed via
 * `handleTodoUpdated`, so no OpenCode server runs. Covers the REST seed, status
 * normalisation (cancelled/unknown), the session-scoped live feed, change-push,
 * and the observe-only write rejections.
 */
import { describe, it, expect, vi } from 'vitest'
import type { OpencodeClient, Todo } from '@opencode-ai/sdk'
import { OpencodeTaskStore } from './task-store.js'

const todo = (id: string, content: string, status: string, priority = 'medium'): Todo => ({
  id,
  content,
  status,
  priority,
})

/** A mock client whose `session.todo` returns a scripted body, recording its args. */
function mockClient(data: Todo[] | undefined): {
  client: OpencodeClient
  calls: Array<{ path: { id: string }; query?: { directory?: string } }>
} {
  const calls: Array<{ path: { id: string }; query?: { directory?: string } }> = []
  const client = {
    session: {
      todo: vi.fn(async (opts: { path: { id: string }; query?: { directory?: string } }) => {
        calls.push(opts)
        return { data }
      }),
    },
  } as unknown as OpencodeClient
  return { client, calls }
}

describe('OpencodeTaskStore.init', () => {
  it('seeds the cache from the REST full-fetch and threads path/directory', async () => {
    const { client, calls } = mockClient([todo('t1', 'Build', 'in_progress', 'high')])
    const store = new OpencodeTaskStore(() => client, 'sess-1', { directory: '/repo' })
    await store.init()
    expect(await store.list()).toEqual([
      { id: 't1', subject: 'Build', status: 'in_progress', vendorExtra: { priority: 'high' } },
    ])
    expect(calls[0]).toEqual({ path: { id: 'sess-1' }, query: { directory: '/repo' } })
  })

  it('omits directory from the query when none is given', async () => {
    const { client, calls } = mockClient([])
    const store = new OpencodeTaskStore(() => client, 'sess-1')
    await store.init()
    expect(calls[0]).toEqual({ path: { id: 'sess-1' }, query: {} })
  })

  it('tolerates an empty REST body (no data ⇒ empty list)', async () => {
    const { client } = mockClient(undefined)
    const store = new OpencodeTaskStore(() => client, 'sess-1')
    await store.init()
    expect(await store.list()).toEqual([])
  })
})

describe('OpencodeTaskStore status normalisation', () => {
  it('folds cancelled to completed and unknown to pending, preserving the raw value', async () => {
    const { client } = mockClient([todo('a', 'x', 'cancelled'), todo('b', 'y', 'weird-status')])
    const store = new OpencodeTaskStore(() => client, 's')
    await store.init()
    expect(await store.get('a')).toEqual({
      id: 'a',
      subject: 'x',
      status: 'completed',
      vendorExtra: { priority: 'medium', rawStatus: 'cancelled' },
    })
    expect(await store.get('b')).toEqual({
      id: 'b',
      subject: 'y',
      status: 'pending',
      vendorExtra: { priority: 'medium', rawStatus: 'weird-status' },
    })
  })
})

describe('OpencodeTaskStore.handleTodoUpdated', () => {
  it('replaces the snapshot and pushes only changed tasks for the matching session', async () => {
    const { client } = mockClient([todo('a', 'A', 'pending'), todo('b', 'B', 'pending')])
    const store = new OpencodeTaskStore(() => client, 'sess-1')
    await store.init()
    const seen: string[] = []
    store.onUpdate((t) => seen.push(`${t.id}:${t.status}`))

    store.handleTodoUpdated({
      sessionID: 'sess-1',
      todos: [todo('a', 'A', 'pending'), todo('b', 'B', 'completed')],
    })

    expect(seen).toEqual(['b:completed']) // only b changed
    expect(await store.list()).toEqual([
      { id: 'a', subject: 'A', status: 'pending', vendorExtra: { priority: 'medium' } },
      { id: 'b', subject: 'B', status: 'completed', vendorExtra: { priority: 'medium' } },
    ])
  })

  it('ignores events for a different session', async () => {
    const { client } = mockClient([])
    const store = new OpencodeTaskStore(() => client, 'sess-1')
    await store.init()
    const handler = vi.fn()
    store.onUpdate(handler)
    store.handleTodoUpdated({ sessionID: 'other', todos: [todo('z', 'Z', 'pending')] })
    expect(handler).not.toHaveBeenCalled()
    expect(await store.list()).toEqual([])
  })

  it('stops pushing after the disposer runs', async () => {
    const { client } = mockClient([])
    const store = new OpencodeTaskStore(() => client, 's')
    await store.init()
    const handler = vi.fn()
    store.onUpdate(handler)()
    store.handleTodoUpdated({ sessionID: 's', todos: [todo('a', 'A', 'pending')] })
    expect(handler).not.toHaveBeenCalled()
  })
})

describe('OpencodeTaskStore observe-only writes', () => {
  it('rejects create and update', async () => {
    const { client } = mockClient([])
    const store = new OpencodeTaskStore(() => client, 's')
    await expect(store.create('default', 'x')).rejects.toThrow(/observe-only/)
    await expect(store.update('a', { status: 'completed' })).rejects.toThrow(/observe-only/)
  })
})
