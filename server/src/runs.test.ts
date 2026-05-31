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
  resolvePending,
  clearPending,
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

  it('holds a team runtime at `team` on turn_end instead of idle', () => {
    ensureRuntime('s-team', '/ws', 'default', []).team = true
    setStatus('s-team', 'running')
    // A lead turn finishing does not idle a team — the lead stays alive.
    emit('s-team', { type: 'turn_end', reason: 'complete' })
    expect(getRuntime('s-team')!.status).toBe('team')
    // Non-team runtime still idles on turn_end.
    ensureRuntime('s-plain', '/ws', 'default', [])
    setStatus('s-plain', 'running')
    emit('s-plain', { type: 'turn_end', reason: 'complete' })
    expect(getRuntime('s-plain')!.status).toBe('idle')
    removeRuntime('s-team')
    removeRuntime('s-plain')
  })

  // The consensus-window race: a permission prompt is emitted, then a stray
  // `turn_end` arrives before the human answers. While the run is alive the prompt
  // must keep the session in `awaiting_permission` so its answer panel stays
  // actionable; only a real teardown (run nulled) may settle it to idle.
  describe('pending-permission guard (consensus-window race)', () => {
    const withRun = (id: string) => {
      const rt = ensureRuntime(id, '/ws', 'default', [])
      rt.run = { abort: new AbortController(), handle: null }
      return rt
    }

    it('holds awaiting_permission when turn_end arrives with a prompt still pending and run alive', () => {
      withRun('s-race')
      emit('s-race', {
        type: 'permission_request',
        requestId: 'q1',
        toolName: 'AskUserQuestion',
        input: {},
      })
      expect(getRuntime('s-race')!.status).toBe('awaiting_permission')
      // A stray turn_end (the bug trigger) must NOT collapse to idle.
      emit('s-race', { type: 'turn_end', reason: 'complete' })
      expect(getRuntime('s-race')!.status).toBe('awaiting_permission')
      removeRuntime('s-race')
    })

    it('settles to idle once the prompt is answered (resolvePending), then turn_end', () => {
      withRun('s-ans')
      emit('s-ans', {
        type: 'permission_request',
        requestId: 'q2',
        toolName: 'AskUserQuestion',
        input: {},
      })
      // Human answers: the guard releases.
      resolvePending('q2')
      emit('s-ans', { type: 'turn_end', reason: 'complete' })
      expect(getRuntime('s-ans')!.status).toBe('idle')
      removeRuntime('s-ans')
    })

    it('idles on turn_end when the run is already torn down (rt.run null), even with a pending prompt', () => {
      const rt = ensureRuntime('s-dead', '/ws', 'default', [])
      rt.run = { abort: new AbortController(), handle: null }
      emit('s-dead', {
        type: 'permission_request',
        requestId: 'q3',
        toolName: 'AskUserQuestion',
        input: {},
      })
      // Teardown order mirrors server.ts finally: run nulled before the turn_end.
      rt.run = null
      emit('s-dead', { type: 'turn_end', reason: 'complete' })
      expect(getRuntime('s-dead')!.status).toBe('idle')
      removeRuntime('s-dead')
    })

    it('a pending prompt outranks the team-hold (panel must stay actionable)', () => {
      const rt = withRun('s-team-pend')
      rt.team = true
      emit('s-team-pend', {
        type: 'permission_request',
        requestId: 'q4',
        toolName: 'Write',
        input: {},
      })
      emit('s-team-pend', { type: 'turn_end', reason: 'complete' })
      expect(getRuntime('s-team-pend')!.status).toBe('awaiting_permission')
      removeRuntime('s-team-pend')
    })

    it('clearPending drops a stale prompt so a later turn_end can idle the live run', () => {
      withRun('s-clear')
      emit('s-clear', {
        type: 'permission_request',
        requestId: 'q5',
        toolName: 'AskUserQuestion',
        input: {},
      })
      clearPending('s-clear')
      emit('s-clear', { type: 'turn_end', reason: 'complete' })
      expect(getRuntime('s-clear')!.status).toBe('idle')
      removeRuntime('s-clear')
    })

    it('resolvePending finds the prompt across runtimes by request id', () => {
      withRun('s-r-a')
      withRun('s-r-b')
      emit('s-r-a', {
        type: 'permission_request',
        requestId: 'uniq-a',
        toolName: 'AskUserQuestion',
        input: {},
      })
      emit('s-r-b', {
        type: 'permission_request',
        requestId: 'uniq-b',
        toolName: 'AskUserQuestion',
        input: {},
      })
      // Answer B from any connection; only B releases.
      resolvePending('uniq-b')
      emit('s-r-a', { type: 'turn_end', reason: 'complete' })
      emit('s-r-b', { type: 'turn_end', reason: 'complete' })
      expect(getRuntime('s-r-a')!.status).toBe('awaiting_permission')
      expect(getRuntime('s-r-b')!.status).toBe('idle')
      removeRuntime('s-r-a')
      removeRuntime('s-r-b')
    })
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
