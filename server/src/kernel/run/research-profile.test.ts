/**
 * `launchRun` — the discussion-research launch profile (the security-critical pair
 * with the cold-start runtime restore in `features/works`).
 *
 * A discussion's research session is a REAL session, so a follow-up turn typed in the
 * 「研究会话」 tab flows through the generic launch path. This pins that the read-only
 * lock travels with it:
 *  - a runtime carrying the research marker gets the research gate + disallowed-tools
 *    lock + research prompt, and is pinned to `default` so the gateway always fires;
 *  - the marker — NOT `sessionKind === 'discussion'` — is what selects it, so the
 *    orchestrator's per-agent discussion sessions never inherit the research role;
 *  - missing composition-root wiring throws instead of launching write-capable;
 *  - a research session that somehow resolved to a non-claude agent (whose driver
 *    path has no `discussion-research` gate) is refused, not silently downgraded.
 *
 * @module
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { AgentConfig, ServerToClient, SessionKind } from '@ccc/shared/protocol'
import type { SessionRuntime } from '../../runs.js'
import type { LaunchRunDeps } from './run-lifecycle.js'

const fx = vi.hoisted(() => ({
  vendor: 'claude' as 'claude' | 'codex',
  claudeCalls: [] as Array<Record<string, unknown>>,
  driverCalls: 0,
  events: [] as ServerToClient[],
}))

vi.mock('../agent/index.js', () => ({
  runClaude: vi.fn(async (opts: Record<string, unknown>) => {
    fx.claudeCalls.push(opts)
  }),
}))

vi.mock('./run-via-driver.js', () => ({
  runViaDriver: vi.fn(async () => {
    fx.driverCalls += 1
  }),
}))

vi.mock('../config/index.js', () => ({
  getSocketAutoResume: vi.fn(() => false),
  getProjectSandbox: vi.fn(() => ({ enabled: false, sandboxSessionKinds: [] })),
}))

vi.mock('../agent-config/index.js', () => ({
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
  emit: vi.fn((_id: string, m: ServerToClient) => {
    fx.events.push(m)
  }),
  finalizeRun: vi.fn(),
  setStatus: vi.fn(),
}))

import { launchRun } from './run-lifecycle.js'

const RESEARCH_PROMPT = 'RESEARCH SYSTEM PROMPT'

function runtime(over: Partial<SessionRuntime> = {}): SessionRuntime {
  return {
    sessionId: 'vsess-1',
    workspacePath: '/ws',
    sessionKind: 'discussion' as SessionKind,
    mode: 'acceptEdits',
    lastActivityAt: 0,
    ...over,
  } as unknown as SessionRuntime
}

function deps(over: Partial<LaunchRunDeps> = {}): LaunchRunDeps {
  return {
    broadcastStatuses: vi.fn(),
    broadcastIntents: vi.fn(),
    eventBus: { publish: vi.fn(), subscribe: vi.fn() } as unknown as LaunchRunDeps['eventBus'],
    researchProfile: vi.fn(() => ({
      appendSystemPrompt: RESEARCH_PROMPT,
      disallowedTools: ['Bash', 'Write'],
      gate: 'discussion-research' as const,
    })),
    sessionProfile: vi.fn(() => ({
      bindMcp: vi.fn(),
    })) as unknown as LaunchRunDeps['sessionProfile'],
    getDriverAdapter: () => ({}) as never,
    ...over,
  }
}

beforeEach(() => {
  fx.vendor = 'claude'
  fx.claudeCalls = []
  fx.driverCalls = 0
  fx.events = []
})

describe('launchRun — the discussion-research profile', () => {
  it('applies the read-only gate, tool lock and research prompt to a research-marked runtime', async () => {
    await launchRun(runtime({ researchDiscussionId: 'd1' }), 'please re-check the cache', deps())
    expect(fx.claudeCalls).toHaveLength(1)
    const call = fx.claudeCalls[0]
    expect(call.gate).toBe('discussion-research')
    expect(call.appendSystemPrompt).toBe(RESEARCH_PROMPT)
    expect(call.disallowedTools).toEqual(['Bash', 'Write'])
    // Pinned to `default` so the permission gateway always runs, whatever the
    // session's stored mode says.
    expect(call.permissionMode).toBe('default')
    // The follow-up resumes the SAME vendor session (a real, non-pending id).
    expect(call.resume).toBe('vsess-1')
    // A research run is not an ordinary work run: no publish_event MCP profile.
    expect(call.bindMcp).toBeUndefined()
  })

  it('a discussion session WITHOUT the marker (an orchestrator agent session) stays ordinary', async () => {
    await launchRun(runtime(), 'a normal discussion agent turn', deps())
    expect(fx.claudeCalls).toHaveLength(1)
    const call = fx.claudeCalls[0]
    expect(call.gate).toBeUndefined()
    expect(call.appendSystemPrompt).toBeUndefined()
    expect(call.permissionMode).toBe('acceptEdits')
  })

  it('throws when the composition root never wired the profile (never a permissive run)', async () => {
    await expect(
      launchRun(
        runtime({ researchDiscussionId: 'd1' }),
        'follow-up',
        deps({ researchProfile: undefined }),
      ),
    ).rejects.toThrow(/researchProfile/)
    expect(fx.claudeCalls).toHaveLength(0)
  })

  it('refuses a research session that resolved to a non-claude agent (driver has no gate)', async () => {
    fx.vendor = 'codex'
    await launchRun(runtime({ researchDiscussionId: 'd1' }), 'follow-up', deps())
    // Neither run path executed; the turn settled as an error instead.
    expect(fx.claudeCalls).toHaveLength(0)
    expect(fx.driverCalls).toBe(0)
    const end = fx.events.find((e) => e.type === 'turn_end')
    expect(end).toMatchObject({ reason: 'error' })
  })

  it('an ordinary codex discussion session still forks to the driver path', async () => {
    fx.vendor = 'codex'
    await launchRun(runtime(), 'a normal discussion agent turn', deps())
    expect(fx.driverCalls).toBe(1)
  })
})
