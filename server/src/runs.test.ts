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
  finalizeRun,
  reconcileLiveness,
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
      const rt = withRun('s-ans')
      emit('s-ans', {
        type: 'permission_request',
        requestId: 'q2',
        toolName: 'AskUserQuestion',
        input: {},
      })
      // Human answers: the pending guard releases. The run then finishes and tears
      // down — teardown order mirrors server.ts finally (run nulled before the
      // settling turn_end), so it idles instead of holding (see the flush-race test).
      resolvePending('q2')
      rt.run = null
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
      const rt = withRun('s-clear')
      emit('s-clear', {
        type: 'permission_request',
        requestId: 'q5',
        toolName: 'AskUserQuestion',
        input: {},
      })
      clearPending('s-clear')
      // Teardown order mirrors server.ts finally: run nulled before the turn_end so
      // the settling event lands on a torn-down run (otherwise it holds — see the
      // "holds running until teardown" race test below).
      rt.run = null
      emit('s-clear', { type: 'turn_end', reason: 'complete' })
      expect(getRuntime('s-clear')!.status).toBe('idle')
      removeRuntime('s-clear')
    })

    it('resolvePending finds the prompt across runtimes by request id', () => {
      withRun('s-r-a')
      const rtB = withRun('s-r-b')
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
      // Answer B from any connection; only B releases. A still has a live run with a
      // pending prompt, so its turn_end holds at awaiting_permission. B's run then
      // tears down (run nulled before the settling turn_end) and idles.
      resolvePending('uniq-b')
      emit('s-r-a', { type: 'turn_end', reason: 'complete' })
      rtB.run = null
      emit('s-r-b', { type: 'turn_end', reason: 'complete' })
      expect(getRuntime('s-r-a')!.status).toBe('awaiting_permission')
      expect(getRuntime('s-r-b')!.status).toBe('idle')
      removeRuntime('s-r-a')
      removeRuntime('s-r-b')
    })
  })

  // The pending-queue flush race: the normal `result` path emits `turn_end` from
  // inside the run, while `rt.run` is still set (teardown's `finally` hasn't run).
  // Broadcasting `idle` here would let the client flush its queued prompt as a new
  // `user_prompt` that the server then rejects ("a turn is already running"),
  // silently dropping it. So the session must HOLD until the run is torn down.
  describe('turn_end hold-until-teardown (pending-queue flush race)', () => {
    it('holds running on turn_end while the run is still live, then idles on finalizeRun', () => {
      const seen: ServerToClient[] = []
      const rt = ensureRuntime('s-hold', '/ws', 'default', [])
      addViewer('s-hold', (e) => seen.push(e))
      rt.run = { abort: new AbortController(), handle: null }
      setStatus('s-hold', 'running')
      // turn_end emitted from inside the run (rt.run NOT yet nulled): must NOT idle.
      emit('s-hold', { type: 'turn_end', reason: 'complete' })
      expect(getRuntime('s-hold')!.status).toBe('running')
      // The turn_end wire event still reached the viewer (the client renders it; it
      // just doesn't drive the input lock — that's sessionStatus's job).
      expect(seen.filter((e) => e.type === 'turn_end')).toHaveLength(1)
      // Teardown: finally nulls rt.run, then finalizeRun settles to idle (no dup).
      rt.run = null
      finalizeRun('s-hold')
      expect(getRuntime('s-hold')!.status).toBe('idle')
      expect(seen.filter((e) => e.type === 'turn_end')).toHaveLength(1)
      removeRuntime('s-hold')
    })

    it('an error turn_end also holds until teardown, then idles', () => {
      const rt = ensureRuntime('s-hold-err', '/ws', 'default', [])
      rt.run = { abort: new AbortController(), handle: null }
      setStatus('s-hold-err', 'running')
      emit('s-hold-err', { type: 'turn_end', reason: 'error', error: 'boom' })
      expect(getRuntime('s-hold-err')!.status).toBe('running')
      rt.run = null
      finalizeRun('s-hold-err')
      expect(getRuntime('s-hold-err')!.status).toBe('idle')
      removeRuntime('s-hold-err')
    })
  })

  // Authoritative terminal-state backstop. The server's run teardown calls
  // finalizeRun in its `finally`; it must always settle the session to idle AND
  // guarantee exactly one terminal turn_end reached viewers — even when the run
  // loop ended without a clean `result` (SDK iterator finished / process exited).
  describe('finalizeRun (terminal-state backstop)', () => {
    it('synthesizes a turn_end and idles when the turn never emitted one', () => {
      const seen: ServerToClient[] = []
      ensureRuntime('s-fin', '/ws', 'default', [])
      addViewer('s-fin', (e) => seen.push(e))
      setStatus('s-fin', 'running') // turn starts; arms the backstop
      emit('s-fin', { type: 'assistant_text', text: 'partial' })
      // Iterator ended without a `result`: no turn_end was ever sent.
      finalizeRun('s-fin')
      expect(getRuntime('s-fin')!.status).toBe('idle')
      // The viewer saw a synthesized terminal turn_end (so its input unlocks).
      expect(seen.filter((e) => e.type === 'turn_end')).toEqual([
        { type: 'turn_end', reason: 'complete' },
      ])
      removeRuntime('s-fin')
    })

    it('does not duplicate turn_end when the turn already emitted one', () => {
      const seen: ServerToClient[] = []
      ensureRuntime('s-fin2', '/ws', 'default', [])
      addViewer('s-fin2', (e) => seen.push(e))
      setStatus('s-fin2', 'running')
      // Normal `result` path: the run loop emitted its own turn_end.
      emit('s-fin2', { type: 'turn_end', reason: 'complete' })
      expect(getRuntime('s-fin2')!.status).toBe('idle')
      finalizeRun('s-fin2') // backstop must be a no-op for turn_end
      expect(seen.filter((e) => e.type === 'turn_end')).toHaveLength(1)
      expect(getRuntime('s-fin2')!.status).toBe('idle')
      removeRuntime('s-fin2')
    })

    it('settles an aborted run to idle with a synthesized turn_end', () => {
      const seen: ServerToClient[] = []
      const rt = ensureRuntime('s-fin-abort', '/ws', 'default', [])
      addViewer('s-fin-abort', (e) => seen.push(e))
      rt.run = { abort: new AbortController(), handle: null }
      setStatus('s-fin-abort', 'running')
      // Mirror server teardown order: the run is nulled before finalizeRun.
      rt.run = null
      finalizeRun('s-fin-abort')
      expect(getRuntime('s-fin-abort')!.status).toBe('idle')
      expect(seen.filter((e) => e.type === 'turn_end')).toHaveLength(1)
      removeRuntime('s-fin-abort')
    })

    it('idles a finished team run once its team flag is cleared (server teardown order)', () => {
      const rt = ensureRuntime('s-fin-team', '/ws', 'default', [])
      rt.team = true
      setStatus('s-fin-team', 'running')
      // Server teardown clears `team` before finalizing, so finalize idles cleanly.
      rt.team = false
      finalizeRun('s-fin-team')
      expect(getRuntime('s-fin-team')!.status).toBe('idle')
      removeRuntime('s-fin-team')
    })

    it('re-arms per turn: a fresh `running` makes the next finalize synthesize again', () => {
      const seen: ServerToClient[] = []
      ensureRuntime('s-fin-rearm', '/ws', 'default', [])
      addViewer('s-fin-rearm', (e) => seen.push(e))
      // Turn 1: clean result, then finalize (no duplicate).
      setStatus('s-fin-rearm', 'running')
      emit('s-fin-rearm', { type: 'turn_end', reason: 'complete' })
      finalizeRun('s-fin-rearm')
      // Turn 2: starts running (re-arms), ends without a result → finalize synthesizes.
      setStatus('s-fin-rearm', 'running')
      finalizeRun('s-fin-rearm')
      expect(seen.filter((e) => e.type === 'turn_end')).toHaveLength(2)
      removeRuntime('s-fin-rearm')
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

  describe('reconcileLiveness', () => {
    it('leaves a running session with recent activity alone', () => {
      const now = 5_000
      const staleMs = 10_000
      const rt = ensureRuntime('s-ok', '/ws', 'default', [])
      rt.run = { abort: new AbortController(), handle: null }
      setStatus('s-ok', 'running')
      // Emit simulates recent activity (updates lastActivityAt).
      emit('s-ok', { type: 'assistant_text', text: 'alive' })

      const result = reconcileLiveness(now, staleMs)
      expect(result).toEqual([])
      expect(isRunning('s-ok')).toBe(true)
      removeRuntime('s-ok')
    })

    it('converges a stale running session to idle', () => {
      const now = 20_000
      const staleMs = 10_000
      const rt = ensureRuntime('s-stale', '/ws', 'default', [])
      rt.run = { abort: new AbortController(), handle: null }
      setStatus('s-stale', 'running')
      // lastActivityAt was set by ensureRuntime to Date.now() at creation, but for
      // deterministic test we need a past value — set it directly.
      rt.lastActivityAt = 0

      const result = reconcileLiveness(now, staleMs)
      expect(result).toEqual(['s-stale'])
      expect(isRunning('s-stale')).toBe(false)
      expect(getRuntime('s-stale')?.status).toBe('idle')
      removeRuntime('s-stale')
    })

    it('converges a run pointer left dangling under an idle status', () => {
      // The inconsistency a stray turn_end leaves: status settled to idle while the
      // run pointer is still set. Broadcasts would advertise idle, but user_prompt
      // rejects with "a turn is already running" — so reconcile must reap it.
      const now = 5_000
      const staleMs = 10_000
      const rt = ensureRuntime('s-dangling', '/ws', 'default', [])
      rt.run = { abort: new AbortController(), handle: null }
      // Status is idle (never forced to running, or dropped there by a stray turn_end)
      // while the run pointer lingers — even with fresh activity, this is reaped.
      expect(rt.status).toBe('idle')

      const result = reconcileLiveness(now, staleMs)
      expect(result).toEqual(['s-dangling'])
      expect(isRunning('s-dangling')).toBe(false)
      expect(getRuntime('s-dangling')?.status).toBe('idle')
      removeRuntime('s-dangling')
    })

    it('does NOT converge awaiting_permission by staleness alone', () => {
      const now = 20_000
      const staleMs = 1_000
      const rt = ensureRuntime('s-await', '/ws', 'default', [])
      rt.run = { abort: new AbortController(), handle: null }
      setStatus('s-await', 'awaiting_permission')
      rt.lastActivityAt = 0

      const result = reconcileLiveness(now, staleMs)
      expect(result).toEqual([])
      expect(isRunning('s-await')).toBe(true)
      removeRuntime('s-await')
    })

    it('does NOT converge team by staleness alone', () => {
      const now = 20_000
      const staleMs = 1_000
      const rt = ensureRuntime('s-team', '/ws', 'default', [])
      rt.run = { abort: new AbortController(), handle: null }
      rt.team = true
      setStatus('s-team', 'team')
      rt.lastActivityAt = 0

      const result = reconcileLiveness(now, staleMs)
      expect(result).toEqual([])
      expect(isRunning('s-team')).toBe(true)
      removeRuntime('s-team')
    })

    it('converges an aborted-but-zombie run regardless of status', () => {
      const now = 5_000
      const staleMs = 10_000
      const rt = ensureRuntime('s-zombie', '/ws', 'default', [])
      const ac = new AbortController()
      ac.abort() // already aborted but the run pointer still exists
      rt.run = { abort: ac, handle: null }
      setStatus('s-zombie', 'running')

      const result = reconcileLiveness(now, staleMs)
      expect(result).toEqual(['s-zombie'])
      expect(isRunning('s-zombie')).toBe(false)
      expect(getRuntime('s-zombie')?.status).toBe('idle')
      removeRuntime('s-zombie')
    })

    it('converges an aborted zombie even when awaiting_permission', () => {
      const now = 5_000
      const staleMs = 10_000
      const rt = ensureRuntime('s-zombie-await', '/ws', 'default', [])
      const ac = new AbortController()
      ac.abort()
      rt.run = { abort: ac, handle: null }
      setStatus('s-zombie-await', 'awaiting_permission')

      const result = reconcileLiveness(now, staleMs)
      expect(result).toEqual(['s-zombie-await'])
      expect(isRunning('s-zombie-await')).toBe(false)
      removeRuntime('s-zombie-await')
    })

    it('triggers onStatusChange when convergence changes status', () => {
      const onChange = vi.fn()
      setOnStatusChange(onChange)

      const now = 20_000
      const staleMs = 1_000
      const rt = ensureRuntime('s-cb', '/ws', 'default', [])
      rt.run = { abort: new AbortController(), handle: null }
      setStatus('s-cb', 'running')
      rt.lastActivityAt = 0

      onChange.mockClear() // clear the call from setStatus('running')
      const result = reconcileLiveness(now, staleMs)
      expect(result).toEqual(['s-cb'])
      // finalizeRun → setStatus(idle) triggers onStatusChange.
      expect(onChange).toHaveBeenCalled()
      removeRuntime('s-cb')
    })
  })
})
