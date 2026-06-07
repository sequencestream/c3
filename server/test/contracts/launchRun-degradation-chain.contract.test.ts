/**
 * GOLDEN-STANDARD CONTRACT — C1: launchRun degradation chain, end to end.
 *
 * Pins a behavior that MUST survive every slice of the server refactor (ADR-0009):
 * when a degradation chain is configured and every agent fails with a degradable
 * error, launchRun walks the chain in order, emits `agent_failed` between attempts,
 * and on exhaustion emits `all_agents_failed` + a terminal `turn_end { error }`.
 *
 * It drives the REAL `launchRun` (hoisted to a top-level export for exactly this
 * reason) with the SDK `query` mocked and the settings degradation lookup stubbed.
 * Only the public seam is asserted (the wire events on the runtime buffer); no
 * internal field is touched, so a later slice may move launchRun into `kernel/`
 * without changing this file.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { ServerToClient } from '@ccc/shared/protocol'

// One SDK stream per query() call, in call order; each yields then throws.
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

// Stub only the settings lookups launchRun reads — keep everything else real.
// Server refactor 3/3 sank the settings lookups into kernel/{agent-config,config};
// the stubbed seam is the same public contract, just at its new home.
vi.mock('../../src/kernel/agent-config/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/kernel/agent-config/index.js')>(
    '../../src/kernel/agent-config/index.js',
  )
  return {
    ...actual,
    getDegradationChain: () => ['agent-b'],
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
    getSocketAutoResume: () => true,
  }
})

import { launchRun } from '../../src/kernel/run/run-lifecycle.js'
import { ensureRuntime, getRuntime, addViewer, removeRuntime, type Viewer } from '../../src/runs.js'

// A degradable error (rate limit) — runClaude routes it to onDegradableError.
const RATE_LIMIT = 'HTTP 429 rate limit exceeded'

beforeEach(() => {
  sdk.streams = []
  sdk.calls = []
})

const noopDeps = { broadcastStatuses: () => {}, broadcastIntents: () => {} }

describe('C1 — launchRun degradation chain (end to end)', () => {
  it('walks agent-a → agent-b, emits agent_failed between, then all_agents_failed + turn_end error', async () => {
    // Both agents fail with a degradable error.
    sdk.streams.push([{ throw: RATE_LIMIT }]) // agent-a
    sdk.streams.push([{ throw: RATE_LIMIT }]) // agent-b

    const id = 'c1-chain'
    const rt = ensureRuntime(id, '/ws', 'default', [])
    const events: ServerToClient[] = []
    const viewer: Viewer = (e) => events.push(e)
    addViewer(id, viewer)

    await launchRun(rt, 'do the thing', noopDeps)

    // Both agents were tried, in order — two SDK query() calls.
    expect(sdk.calls).toHaveLength(2)

    // agent_failed fired for the FIRST agent before the second attempt started.
    const agentFailed = events.filter((e) => e.type === 'agent_failed')
    expect(agentFailed).toHaveLength(1)
    expect(agentFailed[0]).toMatchObject({ type: 'agent_failed', agentId: 'agent-a' })

    // Chain exhausted: a terminal all_agents_failed listing BOTH agents.
    const allFailed = events.find((e) => e.type === 'all_agents_failed')
    expect(allFailed).toBeDefined()
    if (allFailed && allFailed.type === 'all_agents_failed') {
      expect(allFailed.agents.map((a) => a.agentId)).toEqual(['agent-a', 'agent-b'])
    }

    // …followed by a terminal turn_end error, and the session settles to idle.
    const lastTurnEnd = [...events].reverse().find((e) => e.type === 'turn_end')
    expect(lastTurnEnd).toMatchObject({ type: 'turn_end', reason: 'error' })
    expect(getRuntime(id)!.status).toBe('idle')

    removeRuntime(id)
  })

  it('a clean first agent never touches the chain (no agent_failed, turn completes)', async () => {
    // agent-a succeeds immediately.
    sdk.streams.push([{ type: 'result', session_id: 'real-c1' }])

    const id = 'c1-ok'
    const rt = ensureRuntime(id, '/ws', 'default', [])
    const events: ServerToClient[] = []
    addViewer(id, (e) => events.push(e))

    await launchRun(rt, 'do the thing', noopDeps)

    expect(sdk.calls).toHaveLength(1) // only agent-a ran
    expect(events.some((e) => e.type === 'agent_failed')).toBe(false)
    expect(events.some((e) => e.type === 'all_agents_failed')).toBe(false)
    expect(events.find((e) => e.type === 'turn_end')).toMatchObject({ reason: 'complete' })

    removeRuntime(id)
  })
})
