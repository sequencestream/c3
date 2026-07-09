/**
 * Codex automation → c3 MCP bridge (dispatcher lifecycle). The Codex `llm_prompt`
 * branch mounts the loopback HTTP automation MCP route ONLY when the automation
 * explicitly selects a `mcp__c3__*` tool, hands `driver.start` the `c3` HTTP
 * descriptor with the FULL enabledTools list, and disposes the per-execution token
 * on every terminal path (success, driver throw, message-iteration throw) so no
 * token leaks — mirroring the Claude branch's mount opt-in.
 *
 * The served route is faked via `setAutomationHttpMcp` so we can assert bind /
 * dispose call counts and capture what `driver.start` received; everything the
 * dispatcher touches around the driver is mocked so no network / child process runs.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../state.js', () => ({
  resolveWorkspaceRoot: (id: string) => id,
  pathToId: (p: string) => p,
}))

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: () => (async function* () {})() }))

vi.mock('../../kernel/config/index.js', () => ({
  loadSettings: () => ({ agents: [{ id: 'agent-codex', enabled: true, vendor: 'codex' }] }),
}))
vi.mock('../../kernel/agent-config/index.js', () => ({
  launchForAgent: () => ({ model: 'test-model', envOverrides: {} }),
  setAgentEnabled: () => true,
}))
vi.mock('../../kernel/infra/child-env.js', () => ({
  buildChildEnv: () => ({}),
  findClaudeExecutable: () => undefined,
}))
vi.mock('./store.js', () => ({
  getWorkspaceMcpConfig: () => ({ mcpServers: {}, denylist: [] }),
  isAgentQuotaRecoveryConfig: () => false,
}))
vi.mock('../sessions/session-metadata-store.js', () => ({
  upsertAutomationExecutionRow: () => undefined,
}))

const codexStart = vi.hoisted(() => ({
  fn: (_o: unknown): Promise<unknown> => Promise.resolve({}),
}))
vi.mock('../../kernel/agent/adapters/codex/index.js', () => ({
  createCodexAdapter: () => ({ driver: { start: (o: unknown) => codexStart.fn(o) } }),
}))

// Stub the host `gh` credential bridge so no real `gh auth token` spawns; it injects
// a deterministic token so the link test can assert the resolved override reaches
// driver.start.
const ghBridge = vi.hoisted(() => ({
  fn: vi.fn((o?: Record<string, string>) =>
    Promise.resolve({ ...(o ?? {}), GH_TOKEN: 'bridged-gh' }),
  ),
}))
vi.mock('../../kernel/agent/adapters/codex/gh-token.js', () => ({
  resolveCodexGhTokenEnv: (o?: Record<string, string>) => ghBridge.fn(o),
}))

import type { Automation } from '@ccc/shared/protocol'
import { AUTOMATION_NETWORK_ACCESS_TOOL } from '@ccc/shared/protocol'
import type {
  AutomationMcpBinding,
  ServedAutomationMcp,
} from '../../transport/automation-mcp/index.js'
import { execute, setAutomationHttpMcp } from './dispatcher.js'

const SID = 'codex-automation-session'
const FULL_TOOLS = [
  'find_intents',
  'view_intent',
  'save_intent_pr_info',
  'save_intent_directly',
  'publish_pr_event',
  'find_discussions',
  'view_discussion',
  'start_discussion',
  'continue_discussion',
]

/** A fake served route recording bind / dispose calls + the binding it saw. */
function fakeRoute(): {
  route: ServedAutomationMcp
  binds: AutomationMcpBinding[]
  disposeCalls: () => number
} {
  const binds: AutomationMcpBinding[] = []
  let disposed = 0
  const route: ServedAutomationMcp = {
    baseUrl: 'http://127.0.0.1/internal/automation-mcp/v1',
    bind(binding) {
      binds.push(binding)
      return {
        servers: {
          c3: {
            type: 'http',
            url: `http://127.0.0.1/internal/automation-mcp/v1?token=tok-${binds.length}`,
            enabledTools: FULL_TOOLS,
          },
        },
        dispose: () => {
          disposed++
        },
      }
    },
    handler: async () => new Response(null, { status: 404 }),
  }
  return { route, binds, disposeCalls: () => disposed }
}

/** Base codex LLM automation; override per test. */
function codexAutomation(over: Partial<Automation> = {}): Automation {
  return {
    id: 'auto-codex',
    type: 'llm',
    workspaceId: '/ws',
    agentId: 'agent-codex',
    vendor: 'codex',
    mode: { sandboxMode: 'workspace-write', approvalPolicy: 'never' },
    config: { prompt: 'do a codex thing' },
    ...over,
  } as unknown as Automation
}

/** A codex run that emits one text block and completes. */
function successfulRun(): unknown {
  return {
    sessionId: async () => SID,
    messages: async function* () {
      yield { blocks: [{ type: 'text', text: 'codex done' }] }
    },
  }
}

afterEach(() => {
  setAutomationHttpMcp(null)
  vi.clearAllMocks()
})

describe('codex automation MCP bridge — mount opt-in', () => {
  it('does NOT bind and passes no c3 mcpServers when no c3 tool is selected', async () => {
    const { route, binds } = fakeRoute()
    setAutomationHttpMcp(route)
    let startArg: Record<string, unknown> | undefined
    codexStart.fn = (o) => {
      startArg = o as Record<string, unknown>
      return Promise.resolve(successfulRun())
    }

    await execute(codexAutomation({ toolAllowlist: ['Read', 'Grep'] }), 'log-1', () => {})

    expect(binds).toHaveLength(0)
    expect(startArg?.mcpServers).toBeUndefined()
  })

  it('binds and hands driver.start the c3 descriptor + full enabledTools when a c3 tool is selected', async () => {
    const { route, binds, disposeCalls } = fakeRoute()
    setAutomationHttpMcp(route)
    let startArg: Record<string, unknown> | undefined
    codexStart.fn = (o) => {
      startArg = o as Record<string, unknown>
      return Promise.resolve(successfulRun())
    }

    await execute(
      codexAutomation({ toolAllowlist: ['mcp__c3__start_discussion'] }),
      'log-2',
      () => {},
    )

    expect(binds).toHaveLength(1)
    expect(binds[0]).toEqual({ workspacePath: '/ws', executionId: 'log-2' })
    const mcpServers = startArg?.mcpServers as
      | Record<string, { type: string; url: string; enabledTools: string[] }>
      | undefined
    expect(mcpServers?.c3.type).toBe('http')
    expect(mcpServers?.c3.url).toContain('token=')
    expect(mcpServers?.c3.enabledTools).toEqual(FULL_TOOLS)
    expect(disposeCalls()).toBe(1)
  })
})

describe('codex automation — network-access pseudo-entry passthrough', () => {
  it('passes networkAccess:true when selected in a workspace-write sandbox', async () => {
    const { route } = fakeRoute()
    setAutomationHttpMcp(route)
    let startArg: Record<string, unknown> | undefined
    codexStart.fn = (o) => {
      startArg = o as Record<string, unknown>
      return Promise.resolve(successfulRun())
    }

    await execute(
      codexAutomation({
        mode: { sandboxMode: 'workspace-write', approvalPolicy: 'never' },
        toolAllowlist: ['Read', AUTOMATION_NETWORK_ACCESS_TOOL],
      }),
      'log-net-1',
      () => {},
    )

    expect(startArg?.networkAccess).toBe(true)
  })

  it('omits networkAccess when the pseudo-entry is not selected', async () => {
    const { route } = fakeRoute()
    setAutomationHttpMcp(route)
    let startArg: Record<string, unknown> | undefined
    codexStart.fn = (o) => {
      startArg = o as Record<string, unknown>
      return Promise.resolve(successfulRun())
    }

    await execute(
      codexAutomation({
        mode: { sandboxMode: 'workspace-write', approvalPolicy: 'never' },
        toolAllowlist: ['Read', 'Grep'],
      }),
      'log-net-2',
      () => {},
    )

    expect(startArg?.networkAccess).toBeUndefined()
  })

  it('omits networkAccess for a read-only sandbox even when selected', async () => {
    const { route } = fakeRoute()
    setAutomationHttpMcp(route)
    let startArg: Record<string, unknown> | undefined
    codexStart.fn = (o) => {
      startArg = o as Record<string, unknown>
      return Promise.resolve(successfulRun())
    }

    await execute(
      codexAutomation({
        mode: { sandboxMode: 'read-only', approvalPolicy: 'never' },
        toolAllowlist: [AUTOMATION_NETWORK_ACCESS_TOOL],
      }),
      'log-net-3',
      () => {},
    )

    expect(startArg?.networkAccess).toBeUndefined()
  })
})

describe('codex automation — gh token bridge', () => {
  it('resolves the host gh credential and hands driver.start the injected envOverrides', async () => {
    let startArg: Record<string, unknown> | undefined
    codexStart.fn = (o) => {
      startArg = o as Record<string, unknown>
      return Promise.resolve(successfulRun())
    }

    await execute(codexAutomation({ toolAllowlist: ['Read'] }), 'log-gh', () => {})

    // launchForAgent is mocked to yield `envOverrides: {}`; the bridge receives it
    // and appends GH_TOKEN, which must flow through to the codex driver.
    expect(ghBridge.fn).toHaveBeenCalledWith({})
    expect(startArg?.envOverrides).toEqual({ GH_TOKEN: 'bridged-gh' })
  })
})

describe('codex automation MCP bridge — dispose on every terminal path', () => {
  it('disposes after a successful run', async () => {
    const { route, disposeCalls } = fakeRoute()
    setAutomationHttpMcp(route)
    codexStart.fn = () => Promise.resolve(successfulRun())

    await execute(codexAutomation({ toolAllowlist: ['mcp__c3__find_intents'] }), 'log-3', () => {})
    expect(disposeCalls()).toBe(1)
  })

  it('disposes when driver.start throws', async () => {
    const { route, disposeCalls } = fakeRoute()
    setAutomationHttpMcp(route)
    codexStart.fn = () => Promise.reject(new Error('driver blew up'))

    const updates: Record<string, unknown>[] = []
    await execute(
      codexAutomation({ toolAllowlist: ['mcp__c3__find_intents'] }),
      'log-4',
      (_id, patch) => updates.push(patch),
    )
    expect(updates.at(-1)?.status).toBe('failed')
    expect(disposeCalls()).toBe(1)
  })

  it('disposes when message iteration throws mid-run', async () => {
    const { route, disposeCalls } = fakeRoute()
    setAutomationHttpMcp(route)
    codexStart.fn = () =>
      Promise.resolve({
        sessionId: async () => SID,
        messages: async function* () {
          yield { blocks: [{ type: 'text', text: 'partial' }] }
          throw new Error('stream blew up')
        },
      })

    const updates: Record<string, unknown>[] = []
    await execute(
      codexAutomation({ toolAllowlist: ['mcp__c3__find_intents'] }),
      'log-5',
      (_id, patch) => updates.push(patch),
    )
    expect(updates.at(-1)?.status).toBe('failed')
    expect(disposeCalls()).toBe(1)
  })

  it('does not bind or dispose when the route is unconfigured (c3 selected but no route)', async () => {
    setAutomationHttpMcp(null)
    let startArg: Record<string, unknown> | undefined
    codexStart.fn = (o) => {
      startArg = o as Record<string, unknown>
      return Promise.resolve(successfulRun())
    }

    await execute(codexAutomation({ toolAllowlist: ['mcp__c3__find_intents'] }), 'log-6', () => {})
    // No route → no crash, and no c3 descriptor handed to the driver.
    expect(startArg?.mcpServers).toBeUndefined()
  })
})
