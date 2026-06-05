/**
 * Socket-disconnect single auto-`resume` — the two mandatory kernel cases (AS-R18/R19).
 *
 * These drive the REAL `runClaude` with the SDK `query` mocked (the same pattern
 * as `consensus.test.ts`), so the run loop's socket-disconnect detection, the
 * tool side-effect gate verdict, the `resume`-pass turn_end stamping, and the
 * pure `decideSocketResume` decision are pinned together end-to-end. The live
 * `launchRun` closure that strings these together is server-internal and only
 * reachable via e2e (mirroring `requirement-gate.test.ts`); here we assert the
 * exact contract `launchRun` consumes: runClaude's `onSocketDisconnect` verdict
 * + `decideSocketResume` + the resume pass's terminal events.
 *
 *  - SAFE state: socket drops after plain text (no open write tool_use) ⇒ gate
 *    clear ⇒ auto-resume with the ORIGINAL session id ⇒ turn_end carries
 *    `reconnect_attempted: true`.
 *  - DANGER state: socket drops while an `Edit` tool_use is unclosed ⇒ gate
 *    pending ⇒ auto refused, `turn_end { reason:'error', side_effect_pending:true }`
 *    ⇒ a manual continue (resume) then completes.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { ServerToClient } from '@ccc/shared/protocol'

// Per-test programmed message streams (one array per query() call, in call order)
// and a capture of each call's options (to assert the resume id).
const sdk = vi.hoisted(() => ({
  streams: [] as Array<Array<Record<string, unknown> | { throw: string }>>,
  calls: [] as Array<{ resume?: string }>,
}))

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (arg: { options?: { resume?: string } }) => {
    sdk.calls.push({ resume: arg.options?.resume })
    const steps = sdk.streams.shift() ?? []
    return {
      async *[Symbol.asyncIterator]() {
        for (const s of steps) {
          if ('throw' in s) throw new Error(String(s.throw))
          yield s
        }
      },
      interrupt: () => Promise.resolve(),
      setPermissionMode: () => Promise.resolve(),
    }
  },
}))

import { runClaude } from './kernel/agent/index.js'
import { decideSocketResume } from './kernel/run/resume.js'

const SOCKET_ERR = 'socket connection was closed unexpectedly'

const assistantText = (text: string, sessionId?: string) => ({
  type: 'assistant',
  ...(sessionId ? { session_id: sessionId } : {}),
  message: { content: [{ type: 'text', text }] },
})
const assistantToolUse = (id: string, name: string, sessionId?: string) => ({
  type: 'assistant',
  ...(sessionId ? { session_id: sessionId } : {}),
  message: { content: [{ type: 'tool_use', id, name, input: {} }] },
})
const result = (sessionId?: string) => ({
  type: 'result',
  ...(sessionId ? { session_id: sessionId } : {}),
})

/** Drive one runClaude turn, collecting wire events + the socket verdict. */
async function runTurn(opts: { resume?: string; reconnectAttempt?: boolean }): Promise<{
  events: ServerToClient[]
  socket: { error: string; sideEffectPending: boolean } | null
}> {
  const events: ServerToClient[] = []
  let socket: { error: string; sideEffectPending: boolean } | null = null
  await runClaude({
    prompt: 'do the thing',
    cwd: '/tmp',
    signal: new AbortController().signal,
    permissionMode: 'default',
    resume: opts.resume,
    reconnectAttempt: opts.reconnectAttempt,
    send: (m) => events.push(m),
    onSocketDisconnect: (info) => {
      socket = info
    },
  })
  return { events, socket }
}

beforeEach(() => {
  sdk.streams = []
  sdk.calls = []
})

describe('SAFE state — socket drops after plain text ⇒ auto-resume same session', () => {
  it('defers to the caller (no turn_end) with the gate clear, then resumes and stamps the turn', async () => {
    // Pass 1: text then socket drop, no open tool_use.
    sdk.streams.push([assistantText('working…', 'sid-safe'), { throw: SOCKET_ERR }])
    const first = await runTurn({ resume: 'sid-safe' })

    // Gate clear, run deferred to the caller — NO terminal turn_end emitted.
    expect(first.socket).toEqual({ error: SOCKET_ERR, sideEffectPending: false })
    expect(first.events.some((e) => e.type === 'turn_end')).toBe(false)

    // The caller's decision: every condition clear ⇒ auto-resume.
    const decision = decideSocketResume(first.socket!.error, {
      autoResumeEnabled: true,
      sideEffectPending: first.socket!.sideEffectPending,
      retryAlreadyUsed: false,
      isPendingSession: false,
      isTeam: false,
      aborted: false,
    })
    expect(decision.action).toBe('auto-resume')

    // Pass 2: the resume completes cleanly.
    sdk.streams.push([result('sid-safe')])
    const second = await runTurn({ resume: 'sid-safe', reconnectAttempt: true })

    // Resumed the SAME SDK session (full context preserved, not a new session).
    expect(sdk.calls[1].resume).toBe('sid-safe')
    const end = second.events.find((e) => e.type === 'turn_end')
    expect(end).toMatchObject({
      type: 'turn_end',
      reason: 'complete',
      reconnect_attempted: true,
      retry_count: 1,
    })
  })
})

describe('DANGER state — socket drops with an unclosed Edit ⇒ gate blocks auto', () => {
  it('reports side_effect_pending, the decision is a manual error turn_end, then manual continue succeeds', async () => {
    // Pass 1: Edit tool_use sent, NO tool_result, then socket drop.
    sdk.streams.push([assistantToolUse('e1', 'Edit', 'sid-danger'), { throw: SOCKET_ERR }])
    const first = await runTurn({ resume: 'sid-danger' })

    // Gate flags the in-flight write; still NO terminal turn_end from runClaude
    // (the caller decides) — but auto must be refused.
    expect(first.socket).toEqual({ error: SOCKET_ERR, sideEffectPending: true })
    expect(first.events.some((e) => e.type === 'turn_end')).toBe(false)

    const decision = decideSocketResume(first.socket!.error, {
      autoResumeEnabled: true,
      sideEffectPending: first.socket!.sideEffectPending,
      retryAlreadyUsed: false,
      isPendingSession: false,
      isTeam: false,
      aborted: false,
    })
    // Auto blocked: the caller emits a terminal error turn_end (→ status idle),
    // surfacing the gate verdict so the UI prompts a manual continue.
    expect(decision.action).toBe('manual-error')
    if (decision.action === 'manual-error') {
      expect(decision.turnEnd).toMatchObject({
        reason: 'error',
        side_effect_pending: true,
        reconnect_attempted: false,
      })
    }

    // The user manually continues — a fresh turn resumes the same session and finishes.
    sdk.streams.push([assistantText('resumed by hand', 'sid-danger'), result('sid-danger')])
    const manual = await runTurn({ resume: 'sid-danger' })
    expect(sdk.calls[1].resume).toBe('sid-danger')
    expect(manual.events.find((e) => e.type === 'turn_end')).toMatchObject({
      type: 'turn_end',
      reason: 'complete',
    })
  })
})
