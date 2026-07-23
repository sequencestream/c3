/**
 * `launchRun` sandbox regression — the sandbox never changes a run's agent.
 *
 * Sandboxing only decides whether the vendor CLI is wrapped in arapuca; the agent
 * is whatever the normal resolution chain produced (explicit session binding, else
 * the role entry for this session kind). This pins:
 *  - host and sandbox runs launch on the SAME agent, for every session kind and for
 *    an explicitly bound session — no sandbox-specific selection, no re-bind;
 *  - a `system`-mode (subscription) agent enters the sandbox as-is (arapuca ≥ 0.2.5
 *    opens the host keychain for it) and gets `sandboxAllowKeychain`;
 *  - a `custom` agent keeps its relay/env wiring and no keychain grant;
 *  - a sandbox launch failure still settles the run as an error — never a bare host run.
 *
 * @module
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { AgentConfig, ServerToClient, SessionKind } from '@ccc/shared/protocol'
import type { SessionRuntime } from '../../runs.js'
import type { LaunchRunDeps } from './run-lifecycle.js'

// ─── Programmable fixtures shared with the hoisted mock factories ────────────

const fx = vi.hoisted(() => ({
  /** The agent id the normal resolution chain produces for this run. */
  resolvedAgentId: '' as string,
  /** Registry the fake `resolveAgent` reads. */
  agents: [] as AgentConfig[],
  /** Whether this run is sandbox-eligible. */
  sandboxOn: true,
  /** Set to throw from `launchSandbox` (hard-isolation failure). */
  launchThrows: null as Error | null,
  /** Captured `runClaude` option objects, one per attempt. */
  claudeCalls: [] as Array<Record<string, unknown>>,
  /** Captured `setSessionAgent(sessionId, agentId)` re-binds. */
  rebinds: [] as string[],
  /** Captured wire events per session id. */
  events: [] as ServerToClient[],
}))

function agent(over: Partial<AgentConfig> & Pick<AgentConfig, 'id'>): AgentConfig {
  return {
    vendor: 'claude',
    configMode: 'system',
    displayName: over.id,
    enabled: true,
    config: { baseUrl: '', apiKey: '', model: '' },
    ...over,
  } as AgentConfig
}

const SYS = agent({ id: 'sys' })
const CUSTOM = agent({
  id: 'custom-claude',
  configMode: 'custom',
  config: { baseUrl: 'https://gw.example', apiKey: 'k', model: 'm' },
})

vi.mock('../agent/index.js', () => ({
  runClaude: vi.fn(async (opts: Record<string, unknown>) => {
    fx.claudeCalls.push(opts)
  }),
}))

vi.mock('../config/index.js', () => ({
  getSocketAutoResume: vi.fn(() => false),
  getProjectSandbox: vi.fn(() => ({
    enabled: true,
    sandboxSessionKinds: ['work', 'tool', 'intent', 'spec'],
  })),
}))

vi.mock('../agent-config/index.js', () => ({
  getDegradationChain: vi.fn(() => undefined),
  // The unified resolution chain: the same answer whether or not this run is
  // sandboxed (the lifecycle has no sandbox-specific branch to feed it).
  resolveSessionLaunch: vi.fn(() => ({ agentId: fx.resolvedAgentId })),
  resolveAgent: vi.fn(
    (id: string | null) => fx.agents.find((a) => a.id === id) ?? fx.agents[0] ?? SYS,
  ),
  setSessionAgent: vi.fn((_sessionId: string, agentId: string) => {
    fx.rebinds.push(agentId)
    return { ok: true }
  }),
  launchForAgent: vi.fn((a: AgentConfig) => ({ model: a.config.model || undefined })),
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

vi.mock('../sandbox/SandboxLauncher.js', async () => {
  const actual = await vi.importActual<typeof import('../sandbox/SandboxLauncher.js')>(
    '../sandbox/SandboxLauncher.js',
  )
  return {
    ...actual,
    sandboxEligible: vi.fn(() => fx.sandboxOn),
    launchSandbox: vi.fn(() => {
      if (fx.launchThrows) throw fx.launchThrows
      return {
        paths: {
          executionRoot: '/x',
          specsBase: '/s',
          codexHome: '/c',
          claudeConfigDir: '/d',
          extra: [],
        },
        tmpDir: '/tmp/c3-sb-fake',
        cleanup: () => {},
      }
    }),
  }
})

import { launchRun } from './run-lifecycle.js'
import { SandboxLaunchError } from '../sandbox/SandboxLauncher.js'

// ─── Harness ─────────────────────────────────────────────────────────────────

function runtime(sessionKind: SessionKind = 'work'): SessionRuntime {
  return {
    sessionId: 'sess-1',
    workspacePath: '/ws',
    sessionKind,
    mode: 'default',
    lastActivityAt: 0,
  } as unknown as SessionRuntime
}

function deps(): LaunchRunDeps {
  return {
    broadcastStatuses: vi.fn(),
    broadcastIntents: vi.fn(),
    eventBus: { publish: vi.fn(), subscribe: vi.fn() } as unknown as LaunchRunDeps['eventBus'],
    // Intent/spec runtimes must carry their injected profiles (composition-root wiring).
    intentProfile: vi.fn(() => ({})) as unknown as LaunchRunDeps['intentProfile'],
    specProfile: vi.fn(() => ({})) as unknown as LaunchRunDeps['specProfile'],
  }
}

beforeEach(() => {
  fx.resolvedAgentId = SYS.id
  fx.agents = [SYS, CUSTOM]
  fx.sandboxOn = true
  fx.launchThrows = null
  fx.claudeCalls = []
  fx.rebinds = []
  fx.events = []
})

/** Run one turn and report the agent it launched on + whether it was sandboxed. */
async function launchOnce(
  sessionKind: SessionKind,
  sandboxOn: boolean,
): Promise<{ agentId: unknown; sandboxed: boolean }> {
  fx.sandboxOn = sandboxOn
  fx.claudeCalls = []
  const rt = runtime(sessionKind)
  await launchRun(rt, 'do the thing', deps())
  expect(fx.claudeCalls).toHaveLength(1)
  return {
    agentId: fx.claudeCalls[0].currentAgentId,
    sandboxed: rt.sandboxPaths !== undefined,
  }
}

// ─── Cases ───────────────────────────────────────────────────────────────────

describe('launchRun — the sandbox does not change the resolved agent', () => {
  const KINDS: SessionKind[] = ['work', 'tool', 'intent', 'spec']

  for (const kind of KINDS) {
    it(`resolves the same agent for a ${kind} session on the host and in the sandbox`, async () => {
      const host = await launchOnce(kind, false)
      const sandboxed = await launchOnce(kind, true)

      expect(host.sandboxed).toBe(false)
      expect(sandboxed.sandboxed).toBe(true)
      expect(sandboxed.agentId).toBe(host.agentId)
      expect(sandboxed.agentId).toBe(SYS.id)
      // No sandbox-specific re-bind on either path.
      expect(fx.rebinds).toEqual([])
    })
  }

  it('keeps an explicitly bound agent when the run enters the sandbox', async () => {
    fx.resolvedAgentId = CUSTOM.id

    const host = await launchOnce('work', false)
    const sandboxed = await launchOnce('work', true)

    expect(host.agentId).toBe(CUSTOM.id)
    expect(sandboxed.agentId).toBe(CUSTOM.id)
    expect(fx.rebinds).toEqual([])
  })

  it('grants the host keychain to a system agent inside the sandbox', async () => {
    fx.resolvedAgentId = SYS.id

    await launchOnce('work', true)

    expect(fx.claudeCalls[0].sandboxPaths).toBeDefined()
    expect(fx.claudeCalls[0].sandboxAllowKeychain).toBe(true)
    expect(fx.events.some((e) => e.type === 'turn_end' && e.reason === 'error')).toBe(false)
  })

  it('omits the keychain grant when the attempt runs on a custom agent', async () => {
    fx.resolvedAgentId = CUSTOM.id

    await launchOnce('work', true)

    expect(fx.claudeCalls[0].sandboxAllowKeychain).toBe(false)
  })

  it('still settles as an error on a sandbox launch failure — never a bare host run', async () => {
    fx.resolvedAgentId = SYS.id
    fx.launchThrows = new SandboxLaunchError('arapuca-missing', 'arapuca binary not found on PATH')
    const rt = runtime()

    await launchRun(rt, 'do the thing', deps())

    expect(fx.claudeCalls).toHaveLength(0)
    expect(rt.sandboxPaths).toBeUndefined()
    const end = fx.events.find((e) => e.type === 'turn_end')
    expect(end).toMatchObject({ reason: 'error' })
  })
})
