import { describe, it, expect, vi, afterEach } from 'vitest'
import type { ServerToClient } from '@ccc/shared/protocol'
import {
  addViewer,
  bindPending,
  emit,
  ensureRuntime,
  getRuntime,
  isRunning,
  listStatuses,
  removeRuntime,
  removeRuntimesForWorkspace,
  removeViewer,
  setOnStatusChange,
  setStatus,
  stopRun,
} from './runs.js'

// The registry is a module-level singleton; clean up the global status hook and
// any runtimes a test created so cases stay independent.
afterEach(() => setOnStatusChange(null))

describe('session-runtime registry', () => {
  it('seeds a runtime once and keeps its baseline on re-ensure', () => {
    const rt = ensureRuntime('s-seed', '/ws', 'plan', [{ kind: 'user', text: 'hi' }])
    expect(rt.status).toBe('idle')
    expect(rt.baseline).toEqual([{ kind: 'user', text: 'hi' }])
    // A second ensure returns the same object and ignores the new baseline.
    const again = ensureRuntime('s-seed', '/ws', 'default', [])
    expect(again).toBe(rt)
    expect(again.baseline).toEqual([{ kind: 'user', text: 'hi' }])
    removeRuntime('s-seed')
  })

  it('buffers events and replays them to a viewer that joins later', () => {
    ensureRuntime('s-buf', '/ws', 'default', [])
    emit('s-buf', { type: 'user_text', text: 'go' })
    emit('s-buf', { type: 'assistant_text', text: 'sure' })

    // A connection switching back replays the buffer, then receives live events.
    const seen: ServerToClient[] = []
    const rt = getRuntime('s-buf')!
    for (const e of rt.buffer) seen.push(e)
    const viewer = (e: ServerToClient) => seen.push(e)
    addViewer('s-buf', viewer)
    emit('s-buf', { type: 'turn_end', reason: 'complete' })

    expect(seen).toEqual([
      { type: 'user_text', text: 'go' },
      { type: 'assistant_text', text: 'sure' },
      { type: 'turn_end', reason: 'complete' },
    ])
    removeRuntime('s-buf')
  })

  it('fans out live events only to current viewers', () => {
    ensureRuntime('s-fan', '/ws', 'default', [])
    const a: ServerToClient[] = []
    const b: ServerToClient[] = []
    const va = (e: ServerToClient) => a.push(e)
    const vb = (e: ServerToClient) => b.push(e)
    addViewer('s-fan', va)
    addViewer('s-fan', vb)
    emit('s-fan', { type: 'assistant_text', text: 'one' })
    removeViewer('s-fan', vb) // b stops watching (switched away)
    emit('s-fan', { type: 'assistant_text', text: 'two' })

    expect(a.map((e) => (e.type === 'assistant_text' ? e.text : ''))).toEqual(['one', 'two'])
    expect(b.map((e) => (e.type === 'assistant_text' ? e.text : ''))).toEqual(['one'])
    // Both events are still in the buffer regardless of who was watching.
    expect(getRuntime('s-fan')!.buffer).toHaveLength(2)
    removeRuntime('s-fan')
  })

  it('advances status from events and notifies on change', () => {
    const onChange = vi.fn()
    setOnStatusChange(onChange)
    ensureRuntime('s-stat', '/ws', 'default', [])

    setStatus('s-stat', 'running')
    expect(getRuntime('s-stat')!.status).toBe('running')
    emit('s-stat', { type: 'permission_request', requestId: 'r', toolName: 'Write', input: {} })
    expect(getRuntime('s-stat')!.status).toBe('awaiting_permission')
    emit('s-stat', { type: 'tool_result', toolUseId: 't', content: 'ok', isError: false })
    expect(getRuntime('s-stat')!.status).toBe('running')
    emit('s-stat', { type: 'turn_end', reason: 'complete' })
    expect(getRuntime('s-stat')!.status).toBe('idle')

    // running → awaiting → running → idle = 4 changes (setStatus + 3 emits).
    expect(onChange).toHaveBeenCalledTimes(4)
    removeRuntime('s-stat')
  })

  it('does not notify when an event keeps the same status', () => {
    const onChange = vi.fn()
    setOnStatusChange(onChange)
    ensureRuntime('s-same', '/ws', 'default', [])
    emit('s-same', { type: 'assistant_text', text: 'a' }) // idle → running (1)
    emit('s-same', { type: 'assistant_text', text: 'b' }) // running → running (no change)
    expect(onChange).toHaveBeenCalledTimes(1)
    removeRuntime('s-same')
  })

  it('re-keys a pending runtime to its real id, carrying buffer and viewers', () => {
    const pending = 'pending:abc'
    ensureRuntime(pending, '/ws', 'acceptEdits', [])
    const seen: ServerToClient[] = []
    addViewer(pending, (e) => seen.push(e))
    emit(pending, { type: 'user_text', text: 'first' })

    bindPending(pending, 'real-1')
    expect(getRuntime(pending)).toBeUndefined()
    const rt = getRuntime('real-1')!
    expect(rt.sessionId).toBe('real-1')
    expect(rt.mode).toBe('acceptEdits')
    expect(rt.buffer).toHaveLength(1) // buffer moved with the runtime

    // Emitting under the real id still reaches the migrated viewer.
    emit('real-1', { type: 'assistant_text', text: 'second' })
    expect(seen.map((e) => e.type)).toEqual(['user_text', 'assistant_text'])
    removeRuntime('real-1')
  })

  it('stopRun aborts the in-flight run; isRunning reflects it', () => {
    const rt = ensureRuntime('s-stop', '/ws', 'default', [])
    const abort = new AbortController()
    rt.run = { abort, handle: null }
    expect(isRunning('s-stop')).toBe(true)
    stopRun('s-stop')
    expect(abort.signal.aborted).toBe(true)
    rt.run = null
    expect(isRunning('s-stop')).toBe(false)
    removeRuntime('s-stop')
  })

  it('removeRuntimesForWorkspace aborts and drops only that workspace', () => {
    const a = ensureRuntime('s-wa', '/ws-a', 'default', [])
    a.run = { abort: new AbortController(), handle: null }
    ensureRuntime('s-wb', '/ws-b', 'default', [])
    removeRuntimesForWorkspace('/ws-a')
    expect(a.run!.abort.signal.aborted).toBe(true)
    expect(getRuntime('s-wa')).toBeUndefined()
    expect(getRuntime('s-wb')).toBeDefined()
    removeRuntime('s-wb')
  })

  it('listStatuses reports every live runtime', () => {
    ensureRuntime('s-l1', '/ws', 'default', [])
    ensureRuntime('s-l2', '/ws', 'default', [])
    setStatus('s-l2', 'running')
    const map = new Map(listStatuses().map((s) => [s.sessionId, s.status]))
    expect(map.get('s-l1')).toBe('idle')
    expect(map.get('s-l2')).toBe('running')
    removeRuntime('s-l1')
    removeRuntime('s-l2')
  })
})
