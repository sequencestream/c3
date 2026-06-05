/**
 * GOLDEN-STANDARD CONTRACT — C2: socket auto-resume is a SINGLE retry (AS-R18).
 *
 * Pins a behavior that MUST survive every slice of the server refactor (ADR-0009):
 * when the transport drops mid-turn (SAFE state — no open write tool), launchRun
 * auto-`resume`s the SAME SDK session EXACTLY ONCE. If the resumed pass disconnects
 * again, the single-retry budget is spent, so it does NOT resume a second time —
 * it terminates with a `turn_end`. No unbounded reconnect billing.
 *
 * Drives the REAL `launchRun` with the SDK `query` mocked. Fake timers flush the
 * 3–5s reconnect backoff instantly. Only the public seam is asserted.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { ServerToClient } from '@ccc/shared/protocol'

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

// Server refactor 3/3 sank the settings lookups into kernel/{agent-config,config};
// the stubbed seam is the same public contract, just at its new home.
vi.mock('../../src/kernel/agent-config/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/kernel/agent-config/index.js')>(
    '../../src/kernel/agent-config/index.js',
  )
  return {
    ...actual,
    getDegradationChain: () => undefined, // no degradation — isolate the socket path
    resolveSessionLaunch: () => ({ agentId: 'agent-a' }),
    resolveAgent: (id: string | null) => ({
      id: id ?? 'agent-a',
      name: `Name(${id ?? 'agent-a'})`,
      baseUrl: '',
      apiKey: '',
      model: '',
    }),
    launchForAgent: () => ({}),
  }
})
vi.mock('../../src/kernel/config/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/kernel/config/index.js')>(
    '../../src/kernel/config/index.js',
  )
  return {
    ...actual,
    getSocketAutoResume: () => true, // auto-resume enabled
  }
})

import { launchRun } from '../../src/server.js'
import { ensureRuntime, getRuntime, addViewer, removeRuntime, type Viewer } from '../../src/runs.js'

const SOCKET_ERR = 'socket connection was closed unexpectedly'
const assistantText = (text: string, sessionId: string) => ({
  type: 'assistant',
  session_id: sessionId,
  message: { content: [{ type: 'text', text }] },
})

beforeEach(() => {
  sdk.streams = []
  sdk.calls = []
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

const noopDeps = { broadcastStatuses: () => {}, broadcastRequirements: () => {} }

describe('C2 — socket auto-resume is a single retry (AS-R18)', () => {
  it('resumes the same session exactly once, then terminates on a second disconnect', async () => {
    // Pass 1: plain text, then a socket drop (no open write tool ⇒ SAFE ⇒ auto-resume).
    sdk.streams.push([assistantText('working…', 'sid-safe'), { throw: SOCKET_ERR }])
    // Pass 2 (the single resume): disconnects AGAIN ⇒ retry budget spent ⇒ terminate.
    sdk.streams.push([{ throw: SOCKET_ERR }])

    const id = 'sid-safe'
    const rt = ensureRuntime(id, '/ws', 'default', [])
    const events: ServerToClient[] = []
    const viewer: Viewer = (e) => events.push(e)
    addViewer(id, viewer)

    const p = launchRun(rt, 'go', noopDeps)
    // Flush the reconnect backoff (3–5s) and all chained microtasks.
    await vi.runAllTimersAsync()
    await p

    // Exactly ONE retry: two SDK calls total, the 2nd resuming the SAME session id.
    expect(sdk.calls).toHaveLength(2)
    expect(sdk.calls[1].resume).toBe('sid-safe')

    // A terminal turn_end fired (the second disconnect is not retried again).
    expect(events.some((e) => e.type === 'turn_end')).toBe(true)
    expect(getRuntime(id)!.status).toBe('idle')

    removeRuntime(id)
  })

  it('a successful resume completes the turn (one disconnect, one clean resume)', async () => {
    sdk.streams.push([assistantText('working…', 'sid-ok'), { throw: SOCKET_ERR }])
    sdk.streams.push([{ type: 'result', session_id: 'sid-ok' }]) // resume succeeds

    const id = 'sid-ok'
    const rt = ensureRuntime(id, '/ws', 'default', [])
    const events: ServerToClient[] = []
    addViewer(id, (e) => events.push(e))

    const p = launchRun(rt, 'go', noopDeps)
    await vi.runAllTimersAsync()
    await p

    expect(sdk.calls).toHaveLength(2)
    expect(sdk.calls[1].resume).toBe('sid-ok')
    // The resumed pass completed; the terminal turn_end carries the reconnect telemetry.
    const end = [...events].reverse().find((e) => e.type === 'turn_end')
    expect(end).toMatchObject({ type: 'turn_end', reason: 'complete', reconnect_attempted: true })
    expect(getRuntime(id)!.status).toBe('idle')

    removeRuntime(id)
  })
})
