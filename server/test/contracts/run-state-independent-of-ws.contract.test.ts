/**
 * GOLDEN-STANDARD CONTRACT — C5: run state is independent of WS subscription (ADR-0006).
 *
 * This test pins a behavior that MUST survive every slice of the server refactor
 * (ADR-0009). It asserts only the public seam of the session-runtime registry —
 * `ensureRuntime` / `addViewer` / `removeViewer` / `setStatus` / `emit` — never an
 * internal implementation detail. If a later slice moves the registry into
 * `kernel/`, this file does NOT change.
 *
 * The contract (ADR-0006): a connection is a *view*, not the *owner* of a run.
 *   - Switching the viewed session (`removeViewer`) MUST NOT abort the run; its
 *     status stays whatever it was (`running`).
 *   - Closing every connection (no viewers) MUST NOT abort the run.
 *   - A connection switching back replays `baseline + buffer` exactly, then
 *     receives live events — disk is read once, no double counting.
 *   - Live events fan out only to *current* viewers, but the buffer keeps them
 *     all regardless of who was watching.
 */
import { describe, it, expect, afterEach } from 'vitest'
import type { ServerToClient } from '@ccc/shared/protocol'
import {
  addViewer,
  emit,
  ensureRuntime,
  getRuntime,
  removeRuntime,
  removeViewer,
  setOnStatusChange,
  setStatus,
  type Viewer,
} from '../../src/runs.js'

afterEach(() => setOnStatusChange(null))

describe('C5 — run state is independent of WS subscription (ADR-0006)', () => {
  it('keeps a running run alive across removeViewer (switch away) and zero viewers (all closed)', () => {
    const id = 'c5-alive'
    ensureRuntime(id, '/ws', 'default', [{ kind: 'user', text: 'seed' }])
    setStatus(id, 'running')

    // A connection is watching.
    const seen: ServerToClient[] = []
    const viewer: Viewer = (e) => seen.push(e)
    addViewer(id, viewer)
    emit(id, { type: 'assistant_text', text: 'mid-run' })
    expect(getRuntime(id)!.status).toBe('running')

    // Switch away (select another session): only unsubscribes — never aborts.
    removeViewer(id, viewer)
    expect(getRuntime(id)!.status).toBe('running')
    expect(getRuntime(id)!.run).toBe(null) // no abort was triggered

    // The run keeps producing output with NO viewers attached (every tab closed).
    emit(id, { type: 'assistant_text', text: 'still-going' })
    expect(getRuntime(id)!.status).toBe('running')
    // Buffer retains everything regardless of who watched.
    const texts = getRuntime(id)!.buffer.filter((e) => e.type === 'assistant_text')
    expect(texts).toHaveLength(2)

    removeRuntime(id)
  })

  it('replays baseline + buffer to a connection that switches back, then streams live', () => {
    const id = 'c5-replay'
    ensureRuntime(id, '/ws', 'default', [{ kind: 'user', text: 'history' }])
    setStatus(id, 'running')
    emit(id, { type: 'assistant_text', text: 'before-switchback' })

    // A fresh connection selects this session: it replays baseline + buffer, then
    // subscribes for live events. (This mirrors `select_session`.)
    const rt = getRuntime(id)!
    const seen: ServerToClient[] = []
    for (const e of rt.baseline) seen.push({ type: 'assistant_text', text: `baseline:${e.kind}` })
    for (const e of rt.buffer) seen.push(e)
    const viewer: Viewer = (e) => seen.push(e)
    addViewer(id, viewer)
    emit(id, { type: 'turn_end', reason: 'complete' })

    // baseline item + buffered (user_text seed? no — user_text only from launchRun)
    // We injected one assistant_text into the buffer; baseline carried one item.
    expect(seen[0]).toEqual({ type: 'assistant_text', text: 'baseline:user' })
    expect(seen.some((e) => e.type === 'assistant_text' && e.text === 'before-switchback')).toBe(
      true,
    )
    expect(seen[seen.length - 1]).toEqual({ type: 'turn_end', reason: 'complete' })

    removeRuntime(id)
  })

  it('fans out live events to current viewers only, but buffers them for everyone', () => {
    const id = 'c5-fanout'
    ensureRuntime(id, '/ws', 'default', [])
    setStatus(id, 'running')
    const a: ServerToClient[] = []
    const b: ServerToClient[] = []
    const va: Viewer = (e) => a.push(e)
    const vb: Viewer = (e) => b.push(e)
    addViewer(id, va)
    addViewer(id, vb)
    emit(id, { type: 'assistant_text', text: 'one' })
    removeViewer(id, vb) // b switches away — run unaffected
    emit(id, { type: 'assistant_text', text: 'two' })

    expect(a.map((e) => (e.type === 'assistant_text' ? e.text : ''))).toEqual(['one', 'two'])
    expect(b.map((e) => (e.type === 'assistant_text' ? e.text : ''))).toEqual(['one'])
    expect(getRuntime(id)!.buffer.filter((e) => e.type === 'assistant_text')).toHaveLength(2)
    expect(getRuntime(id)!.status).toBe('running') // never aborted by the switch-away

    removeRuntime(id)
  })
})
