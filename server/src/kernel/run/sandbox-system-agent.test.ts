/**
 * `launchRun` sandbox regression — a `system`-mode (subscription) agent is no
 * longer a sandbox conflict.
 *
 * arapuca ≥ 0.2.5 lets the wrapper open the host keychain (`--allow-keychain`),
 * so subscription auth works inside the sandbox. This pins the lifecycle rules
 * that follow from that:
 *  - an EXPLICITLY bound system agent enters the sandbox as-is — no
 *    `sandbox_conflict_request`, no forced swap to a custom agent, no cancel;
 *  - an UNBOUND run whose default resolves to a system agent still honours the
 *    sandbox-role profile (which may itself be a system agent), and no longer
 *    hard-fails when no custom agent exists;
 *  - the wrapper decision (`sandboxAllowKeychain`) is derived from the agent the
 *    attempt actually runs on;
 *  - a sandbox launch failure still settles the run as an error and never falls
 *    back to a bare host run.
 *
 * @module
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { AgentConfig, ServerToClient } from '@ccc/shared/protocol'
import type { SessionRuntime } from '../../runs.js'
import type { LaunchRunDeps } from './run-lifecycle.js'

// ─── Programmable fixtures shared with the hoisted mock factories ────────────

const fx = vi.hoisted(() => ({
  /** Explicit session→agent binding ('' ⇒ unbound / Auto). */
  boundRef: '' as string,
  /** Registry the fake `resolveAgent` reads. */
  agents: [] as AgentConfig[],
  /** What `resolveSandboxAgent` returns (null ⇒ nothing configured/available). */
  sandboxAgent: null as AgentConfig | null,
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
const SYS_ROLE = agent({ id: 'sys-role' })
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
  getProjectSandbox: vi.fn(() => ({ enabled: true, sandboxSessionKinds: ['work'] })),
  getSessionAgentId: vi.fn(() => fx.boundRef || null),
}))

vi.mock('../agent-config/index.js', () => ({
  getDegradationChain: vi.fn(() => undefined),
  resolveSessionLaunch: vi.fn(() => ({
    agentId: fx.boundRef || (fx.agents[0]?.id ?? SYS.id),
  })),
  resolveAgent: vi.fn(
    (id: string | null) => fx.agents.find((a) => a.id === id) ?? fx.agents[0] ?? SYS,
  ),
  resolveSandboxAgent: vi.fn(() => fx.sandboxAgent),
  setSessionAgent: vi.fn((sessionId: string, agentId: string) => {
    fx.rebinds.push(agentId)
    fx.boundRef = agentId
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
    sandboxEligible: vi.fn(() => true),
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

function runtime(): SessionRuntime {
  return {
    sessionId: 'sess-1',
    workspacePath: '/ws',
    sessionKind: 'work',
    mode: 'default',
    lastActivityAt: 0,
  } as unknown as SessionRuntime
}

function deps(onSandboxConflict?: LaunchRunDeps['onSandboxConflict']): LaunchRunDeps {
  return {
    broadcastStatuses: vi.fn(),
    broadcastIntents: vi.fn(),
    eventBus: { publish: vi.fn(), subscribe: vi.fn() } as unknown as LaunchRunDeps['eventBus'],
    ...(onSandboxConflict ? { onSandboxConflict } : {}),
  }
}

beforeEach(() => {
  fx.boundRef = ''
  fx.agents = [SYS, SYS_ROLE, CUSTOM]
  fx.sandboxAgent = null
  fx.launchThrows = null
  fx.claudeCalls = []
  fx.rebinds = []
  fx.events = []
})

// ─── Cases ───────────────────────────────────────────────────────────────────

describe('launchRun — sandbox with a system-mode agent', () => {
  it('launches an explicitly bound system agent straight into the sandbox (no conflict, no swap)', async () => {
    fx.boundRef = SYS.id
    const onSandboxConflict = vi.fn()
    const rt = runtime()

    await launchRun(rt, 'do the thing', deps(onSandboxConflict))

    expect(onSandboxConflict).not.toHaveBeenCalled()
    expect(fx.rebinds).toEqual([])
    expect(rt.sandboxPaths).toBeDefined()
    expect(fx.claudeCalls).toHaveLength(1)
    // The wrapper opens the host keychain for this subscription agent.
    expect(fx.claudeCalls[0].sandboxAllowKeychain).toBe(true)
    expect(fx.claudeCalls[0].sandboxPaths).toBeDefined()
  })

  it('does not hard-fail an unbound system default when no sandbox agent is configured', async () => {
    fx.boundRef = ''
    fx.sandboxAgent = null
    const rt = runtime()

    await launchRun(rt, 'do the thing', deps())

    expect(fx.rebinds).toEqual([])
    expect(rt.sandboxPaths).toBeDefined()
    expect(fx.claudeCalls).toHaveLength(1)
    expect(fx.claudeCalls[0].sandboxAllowKeychain).toBe(true)
    expect(fx.events.some((e) => e.type === 'turn_end' && e.reason === 'error')).toBe(false)
  })

  it('honours a configured sandbox role that is itself a system agent', async () => {
    fx.boundRef = ''
    fx.sandboxAgent = SYS_ROLE
    const rt = runtime()

    await launchRun(rt, 'do the thing', deps())

    expect(fx.rebinds).toEqual([SYS_ROLE.id])
    expect(fx.claudeCalls[0].sandboxAllowKeychain).toBe(true)
  })

  it('omits the keychain grant when the attempt runs on a custom agent', async () => {
    fx.boundRef = CUSTOM.id
    const rt = runtime()

    await launchRun(rt, 'do the thing', deps())

    expect(fx.claudeCalls).toHaveLength(1)
    expect(fx.claudeCalls[0].sandboxAllowKeychain).toBe(false)
  })

  it('still settles as an error on a sandbox launch failure — never a bare host run', async () => {
    fx.boundRef = SYS.id
    fx.launchThrows = new SandboxLaunchError('arapuca-missing', 'arapuca binary not found on PATH')
    const rt = runtime()

    await launchRun(rt, 'do the thing', deps())

    expect(fx.claudeCalls).toHaveLength(0)
    expect(rt.sandboxPaths).toBeUndefined()
    const end = fx.events.find((e) => e.type === 'turn_end')
    expect(end).toMatchObject({ reason: 'error' })
  })
})
