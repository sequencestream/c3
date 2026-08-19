/**
 * `launchRun` — which SESSIONS receive the work-session c3 tool profile
 * (`publish_event` + `memory_search` + `memory_write`).
 *
 * The selection is a POSITIVE `sessionKind === 'work'` test. Written the other way
 * round — "none of the other profiles matched" — every future session kind would
 * inherit the memory tools by default, and the discussion agents would be able to
 * persist their own synthesized opinions as workspace facts without anyone
 * noticing. That is the failure this file exists to prevent, so it is asserted per
 * vendor (all three consume the SAME bound descriptor) and per restricted kind.
 *
 * The complementary half lives in `transport/event-mcp/index.test.ts`, which proves
 * what the bound route actually serves over a real MCP client.
 *
 * @module
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { AgentConfig, SessionKind } from '@ccc/shared/protocol'
import type { SessionRuntime } from '../../runs.js'
import type { LaunchRunDeps } from '../../kernel/run/run-lifecycle.js'
import { EVENT_MCP_TOOL_NAMES } from '../../transport/event-mcp/index.js'

type Vendor = 'claude' | 'codex' | 'cursor'

const fx = vi.hoisted(() => ({
  vendor: 'claude' as 'claude' | 'codex' | 'cursor',
  claudeCalls: [] as Array<Record<string, unknown>>,
  driverCalls: [] as Array<Record<string, unknown> | undefined>,
}))

vi.mock('../../kernel/agent/index.js', () => ({
  runClaude: vi.fn(async (opts: Record<string, unknown>) => {
    fx.claudeCalls.push(opts)
  }),
}))

vi.mock('../../kernel/run/run-via-driver.js', () => ({
  // The 9th positional argument is the resolved work-session MCP profile.
  runViaDriver: vi.fn(async (...args: unknown[]) => {
    fx.driverCalls.push(args[8] as Record<string, unknown> | undefined)
  }),
}))

vi.mock('../../kernel/config/index.js', () => ({
  getSocketAutoResume: vi.fn(() => false),
  getProjectSandbox: vi.fn(() => ({ enabled: false, sandboxSessionKinds: [] })),
}))

vi.mock('../../kernel/agent-config/index.js', () => ({
  getDegradationChain: vi.fn(() => undefined),
  resolveSessionLaunch: vi.fn(() => ({ agentId: 'a1' })),
  resolveAgent: vi.fn(
    () => ({ id: 'a1', vendor: fx.vendor, configMode: 'system' }) as unknown as AgentConfig,
  ),
  launchForAgent: vi.fn(() => ({})),
  freezeSessionAgent: vi.fn(),
  bindClaudeRelay: vi.fn(() => null),
  unbindRelay: vi.fn(),
}))

vi.mock('../../runs.js', () => ({
  bindPending: vi.fn(),
  clearPending: vi.fn(),
  emit: vi.fn(),
  finalizeRun: vi.fn(),
  setStatus: vi.fn(),
}))

import { launchRun } from '../../kernel/run/run-lifecycle.js'

function runtime(over: Partial<SessionRuntime> = {}): SessionRuntime {
  return {
    sessionId: 'sess-1',
    workspacePath: '/ws',
    sessionKind: 'work' as SessionKind,
    mode: 'acceptEdits',
    lastActivityAt: 0,
    ...over,
  } as unknown as SessionRuntime
}

/** A deps object whose every profile is wired, so an absence is a real decision. */
function deps(sessionProfile: LaunchRunDeps['sessionProfile']): LaunchRunDeps {
  const stub = { bindMcp: vi.fn(), gate: 'intent' as const }
  return {
    broadcastStatuses: vi.fn(),
    broadcastIntents: vi.fn(),
    eventBus: { publish: vi.fn(), subscribe: vi.fn() } as unknown as LaunchRunDeps['eventBus'],
    intentProfile: vi.fn(() => stub) as unknown as LaunchRunDeps['intentProfile'],
    specProfile: vi.fn(() => stub) as unknown as LaunchRunDeps['specProfile'],
    specReviewProfile: vi.fn(() => stub) as unknown as LaunchRunDeps['specReviewProfile'],
    researchProfile: vi.fn(() => ({
      appendSystemPrompt: 'research',
      disallowedTools: [],
      gate: 'discussion-research' as const,
    })),
    sessionProfile,
    getDriverAdapter: () => ({}) as never,
  }
}

/** The bound descriptor a work session's profile hands the vendor. */
const boundServers = {
  c3: {
    type: 'http',
    url: 'http://127.0.0.1/internal/event-mcp/v1?token=t',
    enabledTools: [...EVENT_MCP_TOOL_NAMES],
  },
}

beforeEach(() => {
  fx.vendor = 'claude'
  fx.claudeCalls = []
  fx.driverCalls = []
})

/** The `bindMcp` the run actually received, whichever vendor path it took. */
function receivedBindMcp(): unknown {
  if (fx.claudeCalls.length) return fx.claudeCalls[0].bindMcp
  return fx.driverCalls[0]?.bindMcp
}

describe('the work-session tool profile reaches every vendor', () => {
  it.each<Vendor>(['claude', 'codex', 'cursor'])(
    'a %s work session binds the route carrying all three tools',
    async (vendor) => {
      fx.vendor = vendor
      const bindMcp = vi.fn((_binding: unknown) => ({ servers: boundServers, dispose: vi.fn() }))
      const sessionProfile = vi.fn(() => ({
        bindMcp,
      })) as unknown as LaunchRunDeps['sessionProfile']
      await launchRun(runtime(), 'do the thing', deps(sessionProfile))

      expect(sessionProfile).toHaveBeenCalledWith('/ws')
      const bound = receivedBindMcp() as typeof bindMcp
      expect(bound).toBe(bindMcp)
      // What the vendor is handed lists both memory tools — for Codex the
      // `enabledTools` entry is load-bearing, an omitted name is silently disabled.
      const descriptor = bound({
        workspacePath: '/ws',
        getRunId: () => 'sess-1',
        signal: new AbortController().signal,
      })
      expect(descriptor.servers.c3.enabledTools).toEqual([...EVENT_MCP_TOOL_NAMES])
      expect(descriptor.servers.c3.enabledTools).toContain('memory_search')
      expect(descriptor.servers.c3.enabledTools).toContain('memory_write')
    },
  )
})

describe('restricted sessions never receive the memory tools', () => {
  const restricted: Array<[string, Partial<SessionRuntime>]> = [
    ['intent', { sessionKind: 'intent' as SessionKind }],
    ['spec', { sessionKind: 'spec' as SessionKind, specDir: '/ws/.specs' }],
    [
      'spec_review',
      {
        sessionKind: 'spec_review' as SessionKind,
        specReviewIntentId: 'i1',
        specReviewFingerprint: 'fp',
      },
    ],
    [
      'discussion (research)',
      { sessionKind: 'discussion' as SessionKind, researchDiscussionId: 'd1' },
    ],
    ['discussion (participant agent)', { sessionKind: 'discussion' as SessionKind }],
  ]

  it.each(restricted)('a %s session never resolves the work profile', async (_label, over) => {
    const workBindMcp = vi.fn(() => ({ servers: boundServers, dispose: vi.fn() }))
    const sessionProfile = vi.fn(() => ({
      bindMcp: workBindMcp,
    })) as unknown as LaunchRunDeps['sessionProfile']
    await launchRun(runtime(over as Partial<SessionRuntime>), 'a turn', deps(sessionProfile))

    expect(sessionProfile).not.toHaveBeenCalled()
    // Whatever the run bound — its own restricted profile, or nothing — it is not
    // the work route, so neither memory tool is on its tool face.
    expect(receivedBindMcp()).not.toBe(workBindMcp)
    expect(workBindMcp).not.toHaveBeenCalled()
  })

  it.each(restricted)(
    'a %s session on the driver path is equally excluded',
    async (_label, over) => {
      fx.vendor = 'codex'
      const workBindMcp = vi.fn(() => ({ servers: boundServers, dispose: vi.fn() }))
      const sessionProfile = vi.fn(() => ({
        bindMcp: workBindMcp,
      })) as unknown as LaunchRunDeps['sessionProfile']
      await launchRun(runtime(over as Partial<SessionRuntime>), 'a turn', deps(sessionProfile))

      expect(sessionProfile).not.toHaveBeenCalled()
      // The driver's work-profile slot is empty, so no memory-carrying descriptor
      // can reach codex or cursor for these kinds.
      expect(fx.driverCalls[0]).toBeUndefined()
      expect(workBindMcp).not.toHaveBeenCalled()
    },
  )
})

describe('the restricted routes carry no memory tool', () => {
  // Belt and braces behind the profile selection above: even if a wiring slip
  // handed one of these routes to a work session, the descriptor it mints still
  // names no memory tool.
  const MEMORY_TOOLS = ['memory_search', 'memory_write']
  const binding = {
    workspacePath: '/ws',
    getRunId: () => 'sess-1',
    signal: new AbortController().signal,
  }

  it('the intent route lists the three ledger tools only', async () => {
    const { createIntentMcp } = await import('../../transport/intent-mcp/index.js')
    const route = createIntentMcp('http://127.0.0.1', {
      save: () => ({ content: [] }),
      find: () => ({ content: [] }),
      view: () => ({ content: [] }),
    } as never)
    const bound = route.bind(binding as never)
    try {
      expect(bound.servers.c3.enabledTools).toEqual(['find_intents', 'view_intent', 'save_intents'])
      for (const t of MEMORY_TOOLS) expect(bound.servers.c3.enabledTools).not.toContain(t)
    } finally {
      bound.dispose()
    }
  })

  it('the spec and spec-review routes list their own read/submit tools only', async () => {
    const { createSpecQueryMcp } = await import('../../transport/spec-query-mcp/index.js')
    const { createSpecReviewMcp } = await import('../../transport/spec-review-mcp/index.js')
    const spec = createSpecQueryMcp('http://127.0.0.1').bind(binding as never)
    const review = createSpecReviewMcp('http://127.0.0.1').bind({
      ...binding,
      intentId: 'i1',
      fingerprint: 'fp',
    } as never)
    try {
      expect(spec.servers.c3.enabledTools).toEqual(['find_intents', 'view_intent'])
      expect(review.servers.c3.enabledTools).toEqual([
        'find_intents',
        'view_intent',
        'submit_spec_review',
      ])
      for (const t of MEMORY_TOOLS) {
        expect(spec.servers.c3.enabledTools).not.toContain(t)
        expect(review.servers.c3.enabledTools).not.toContain(t)
      }
    } finally {
      spec.dispose()
      review.dispose()
    }
  })
})
