/**
 * CodexTaskStore behaviour (ADR-0011 TaskStore amendment). Hermetic: `todo_list`
 * frames are fed via `ingest` directly, so no `codex` process spawns. Covers the
 * snapshot-replace + change-push logic, id synthesis, and the observe-only write
 * rejections.
 */
import { describe, it, expect, vi } from 'vitest'
import type { TodoListItem } from '@openai/codex-sdk'
import { CodexTaskStore } from './task-store.js'

/** Build a `todo_list` thread-item frame from `[text, completed]` tuples. */
function frame(id: string, items: Array<[string, boolean]>): TodoListItem {
  return {
    id,
    type: 'todo_list',
    items: items.map(([text, completed]) => ({ text, completed })),
  }
}

describe('CodexTaskStore.ingest + list', () => {
  it('maps a todo_list frame to neutral tasks with synthesised ids', async () => {
    const store = new CodexTaskStore()
    store.ingest(
      frame('plan-1', [
        ['Read code', true],
        ['Write code', false],
      ]),
    )
    expect(await store.list()).toEqual([
      { id: 'plan-1#0', subject: 'Read code', status: 'completed' },
      { id: 'plan-1#1', subject: 'Write code', status: 'pending' },
    ])
  })

  it('replaces the snapshot wholesale on a later frame (stale items drop)', async () => {
    const store = new CodexTaskStore()
    store.ingest(
      frame('p', [
        ['a', false],
        ['b', false],
      ]),
    )
    store.ingest(frame('p', [['a', true]])) // shorter plan
    expect(await store.list()).toEqual([{ id: 'p#0', subject: 'a', status: 'completed' }])
  })

  it('yields an empty list for an empty frame', async () => {
    const store = new CodexTaskStore()
    store.ingest(frame('p', []))
    expect(await store.list()).toEqual([])
  })
})

describe('CodexTaskStore.get', () => {
  it('returns a task by synthesised id, undefined for an unknown id', async () => {
    const store = new CodexTaskStore()
    store.ingest(frame('p', [['only', false]]))
    expect(await store.get('p#0')).toEqual({ id: 'p#0', subject: 'only', status: 'pending' })
    expect(await store.get('p#9')).toBeUndefined()
  })
})

describe('CodexTaskStore.onUpdate', () => {
  it('pushes only new/changed tasks across frames', () => {
    const store = new CodexTaskStore()
    const seen: Array<{ id: string; status: string }> = []
    store.onUpdate((t) => seen.push({ id: t.id, status: t.status }))

    store.ingest(
      frame('p', [
        ['a', false],
        ['b', false],
      ]),
    ) // both new ⇒ 2 pushes
    store.ingest(
      frame('p', [
        ['a', false],
        ['b', true],
      ]),
    ) // only b changed ⇒ 1 push

    expect(seen).toEqual([
      { id: 'p#0', status: 'pending' },
      { id: 'p#1', status: 'pending' },
      { id: 'p#1', status: 'completed' },
    ])
  })

  it('does not push when an identical frame re-arrives', () => {
    const store = new CodexTaskStore()
    const handler = vi.fn()
    store.onUpdate(handler)
    store.ingest(frame('p', [['a', true]]))
    handler.mockClear()
    store.ingest(frame('p', [['a', true]])) // identical ⇒ no change
    expect(handler).not.toHaveBeenCalled()
  })

  it('stops pushing after the disposer runs', () => {
    const store = new CodexTaskStore()
    const handler = vi.fn()
    const dispose = store.onUpdate(handler)
    dispose()
    store.ingest(frame('p', [['a', false]]))
    expect(handler).not.toHaveBeenCalled()
  })
})

describe('CodexTaskStore observe-only writes', () => {
  it('rejects create and update', async () => {
    const store = new CodexTaskStore()
    await expect(store.create('default', 'x')).rejects.toThrow(/observe-only/)
    await expect(store.update('p#0', { status: 'completed' })).rejects.toThrow(/observe-only/)
  })
})
