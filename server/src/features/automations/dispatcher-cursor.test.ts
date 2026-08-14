/**
 * Cursor automation execution (dispatcher branch). A `llm` automation whose
 * vendor is cursor runs on the cursor adapter's driver — never on the claude SDK
 * or the codex adapter — with its mode read through the cursor mode catalog, the
 * bound agent's API key on the run's env map, and the SAME loopback HTTP c3 MCP
 * route the other vendors bind (opt-in, disposed on every terminal path).
 *
 * The failures that must land BEFORE a turn is spent are asserted here too: an
 * unresolvable SDK, a missing / disabled / wrong-vendor agent, and a credential
 * the driver rejects at the door. None of them may fall back to another vendor.
 *
 * Everything around the driver is mocked, so no SDK loads and no network runs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../state.js', () => ({
  resolveWorkspaceRoot: (id: string) => id,
  pathToName: (p: string) => p,
  workspaceNameFor: (value: string) => value,
}))

// The claude path must never be reached: this stub records any call to it.
const claudeQuery = vi.hoisted(() => ({ calls: 0 }))
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: () => {
    claudeQuery.calls++
    return (async function* () {})()
  },
}))

const settings = vi.hoisted(() => ({
  agents: [
    {
      id: 'agent-cursor',
      enabled: true,
      vendor: 'cursor',
      configMode: 'system',
      config: { apiKey: 'key-from-agent', model: '' },
    },
    {
      id: 'agent-cursor-nokey',
      enabled: true,
      vendor: 'cursor',
      config: { apiKey: '', model: '' },
    },
    {
      id: 'agent-cursor-off',
      enabled: false,
      vendor: 'cursor',
      config: { apiKey: 'k', model: '' },
    },
    { id: 'agent-claude', enabled: true, vendor: 'claude', config: {} },
  ] as unknown[],
}))
vi.mock('../../kernel/config/index.js', () => ({ loadSettings: () => settings }))
vi.mock('../../kernel/agent-config/index.js', () => ({
  launchForAgent: () => ({ model: 'cursor-model', envOverrides: { HTTP_PROXY: 'http://p' } }),
  bindClaudeRelay: () => null,
  unbindRelay: () => undefined,
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

// The codex adapter must never be constructed on a cursor automation.
const codexStart = vi.hoisted(() => ({ calls: 0 }))
vi.mock('../../kernel/agent/adapters/codex/index.js', () => ({
  createCodexAdapter: () => ({
    driver: {
      start: () => {
        codexStart.calls++
        return Promise.resolve({})
      },
    },
  }),
}))

/** The cursor adapter seam: availability + a scripted driver. */
const cursor = vi.hoisted(() => ({
  available: true,
  start: (_o: unknown): Promise<unknown> => Promise.resolve({}),
  lastStart: undefined as Record<string, unknown> | undefined,
}))
// The CLI probe decides whether a cursor automation can dispatch at all.
vi.mock('../../kernel/agent/process/launcher.js', () => ({
  resolve: (vendor: string) =>
    vendor === 'cursor' ? (cursor.available ? '/x/cursor-agent' : null) : `/x/${vendor}`,
}))
vi.mock('../../kernel/agent/adapters/cursor/index.js', async () => {
  // The real mode catalog is the point of the mode assertions — only the driver
  // is faked.
  const { cursorModeCatalog } = await import('../../kernel/agent/adapters/cursor/modes.js')
  return {
    cursorModeCatalog,
    createCursorAdapter: () => ({
      driver: {
        start: (o: unknown) => {
          cursor.lastStart = o as Record<string, unknown>
          return cursor.start(o)
        },
      },
    }),
  }
})

import type { Automation } from '@ccc/shared/protocol'
import type {
  AutomationMcpBinding,
  ServedAutomationMcp,
} from '../../transport/automation-mcp/index.js'
import { execute, setAutomationHttpMcp } from './dispatcher.js'

const SID = 'cursor-automation-agent-id'
const FULL_TOOLS = ['find_intents', 'view_intent', 'publish_event']

/** A fake served route recording bind / dispose calls. */
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

function cursorAutomation(over: Partial<Automation> = {}): Automation {
  return {
    id: 'auto-cursor',
    type: 'llm',
    workspaceName: '/ws',
    agentId: 'agent-cursor',
    vendor: 'cursor',
    mode: 'agent',
    config: { prompt: 'do a cursor thing' },
    toolAllowlist: [],
    ...over,
  } as unknown as Automation
}

/** A cursor run that emits one text block and completes. */
function successfulRun(): unknown {
  return {
    sessionId: async () => SID,
    messages: async function* () {
      yield { blocks: [{ type: 'text', text: 'cursor done' }] }
    },
  }
}

/** Run one automation and return the log patches the dispatcher wrote. */
async function run(
  automation: Automation,
  logId = 'log-cursor',
): Promise<Record<string, unknown>[]> {
  const updates: Record<string, unknown>[] = []
  await execute(automation, logId, (_id, patch) => updates.push(patch))
  return updates
}

beforeEach(() => {
  cursor.available = true
  cursor.lastStart = undefined
  cursor.start = () => Promise.resolve(successfulRun())
  claudeQuery.calls = 0
  codexStart.calls = 0
})

afterEach(() => {
  setAutomationHttpMcp(null)
  vi.clearAllMocks()
})

describe('cursor automation — execution path', () => {
  it('runs on the cursor driver and records the session id, output and success', async () => {
    const updates = await run(cursorAutomation())

    expect(cursor.lastStart?.cwd).toBe('/ws')
    expect(cursor.lastStart?.prompt).toBe('do a cursor thing')
    expect(updates.some((u) => u.sessionId === SID)).toBe(true)
    expect(updates.at(-1)).toMatchObject({ status: 'success', output: 'cursor done' })
    // No cross-vendor execution, ever.
    expect(claudeQuery.calls).toBe(0)
    expect(codexStart.calls).toBe(0)
  })

  it('hands the driver the bound agent model and the agent API key on the run env', async () => {
    await run(cursorAutomation())

    expect(cursor.lastStart?.model).toBe('cursor-model')
    expect(cursor.lastStart?.envOverrides).toEqual({
      HTTP_PROXY: 'http://p',
      CURSOR_API_KEY: 'key-from-agent',
    })
  })

  it('leaves the key out when the agent has none — the driver falls back to the server env', async () => {
    await run(cursorAutomation({ agentId: 'agent-cursor-nokey' }))

    expect(cursor.lastStart?.envOverrides).toEqual({ HTTP_PROXY: 'http://p' })
  })
})

describe('cursor automation — mode resolution through the cursor catalog', () => {
  const cases: Array<[string, string, string]> = [
    // stored mode → actionMode × toolGate, as the cursor catalog declares them
    ['plan', 'plan', 'on-sensitive'],
    ['agent', 'build', 'on-sensitive'],
    ['full-access', 'build', 'never-ask'],
  ]
  for (const [mode, actionMode, toolGate] of cases) {
    it(`maps "${mode}" to ${actionMode} × ${toolGate}`, async () => {
      await run(cursorAutomation({ mode: mode as Automation['mode'] }))
      expect(cursor.lastStart?.actionMode).toBe(actionMode)
      expect(cursor.lastStart?.toolGate).toBe(toolGate)
    })
  }

  it('degrades an unknown / legacy token to the catalog default (agent)', async () => {
    // `sandboxed` is a legacy McpMode value, meaningless to cursor.
    await run(cursorAutomation({ mode: 'sandboxed' as Automation['mode'] }))
    expect(cursor.lastStart?.actionMode).toBe('build')
    expect(cursor.lastStart?.toolGate).toBe('on-sensitive')
  })

  it('degrades a codex policy object (hand-edited row) to the catalog default', async () => {
    await run(
      cursorAutomation({
        mode: { sandboxMode: 'read-only', approvalPolicy: 'never' } as Automation['mode'],
      }),
    )
    expect(cursor.lastStart?.actionMode).toBe('build')
    expect(cursor.lastStart?.toolGate).toBe('on-sensitive')
  })
})

describe('cursor automation — c3 MCP over the shared loopback route', () => {
  it('does NOT bind and passes no mcpServers when no c3 tool is selected', async () => {
    const { route, binds } = fakeRoute()
    setAutomationHttpMcp(route)

    await run(cursorAutomation({ toolAllowlist: ['read', 'grep'] }))

    expect(binds).toHaveLength(0)
    expect(cursor.lastStart?.mcpServers).toBeUndefined()
  })

  it('binds the same HTTP descriptor + full enabledTools when a c3 tool is selected', async () => {
    const { route, binds, disposeCalls } = fakeRoute()
    setAutomationHttpMcp(route)

    await run(cursorAutomation({ toolAllowlist: ['mcp__c3__find_intents'] }), 'log-mcp')

    expect(binds).toEqual([{ workspacePath: '/ws', executionId: 'log-mcp' }])
    const servers = cursor.lastStart?.mcpServers as
      Record<string, { type: string; url: string; enabledTools: string[] }> | undefined
    expect(servers?.c3.type).toBe('http')
    expect(servers?.c3.url).toContain('token=')
    expect(servers?.c3.enabledTools).toEqual(FULL_TOOLS)
    expect(disposeCalls()).toBe(1)
  })

  it('disposes the token when the driver throws', async () => {
    const { route, disposeCalls } = fakeRoute()
    setAutomationHttpMcp(route)
    cursor.start = () => Promise.reject(new Error('driver blew up'))

    const updates = await run(cursorAutomation({ toolAllowlist: ['mcp__c3__find_intents'] }))

    expect(updates.at(-1)).toMatchObject({ status: 'failed', error: 'driver blew up' })
    expect(disposeCalls()).toBe(1)
  })

  it('disposes the token when message iteration throws mid-run', async () => {
    const { route, disposeCalls } = fakeRoute()
    setAutomationHttpMcp(route)
    cursor.start = () =>
      Promise.resolve({
        sessionId: async () => SID,
        messages: async function* () {
          yield { blocks: [{ type: 'text', text: 'partial' }] }
          throw new Error('stream blew up')
        },
      })

    const updates = await run(cursorAutomation({ toolAllowlist: ['mcp__c3__view_intent'] }))

    expect(updates.at(-1)?.status).toBe('failed')
    expect(disposeCalls()).toBe(1)
  })

  it('disposes the token when the wall clock aborts the run', async () => {
    const { route, disposeCalls } = fakeRoute()
    setAutomationHttpMcp(route)
    // A run that keeps streaming until the dispatcher's deadline aborts it: the
    // driver sees the abort on the signal it was handed, the loop breaks, and the
    // execution settles as a timeout — with the token gone either way.
    cursor.start = (o) =>
      Promise.resolve({
        sessionId: async () => SID,
        messages: async function* () {
          const signal = (o as { signal: AbortSignal }).signal
          while (!signal.aborted) {
            yield { blocks: [{ type: 'text', text: 'still going' }] }
            await new Promise((r) => setTimeout(r, 5))
          }
          yield { blocks: [{ type: 'text', text: 'last' }] }
        },
      })

    const updates = await run(
      cursorAutomation({ toolAllowlist: ['mcp__c3__find_intents'], maxWallClockMs: 20 }),
    )

    expect(updates.at(-1)).toMatchObject({ status: 'failed', error: 'wall_clock_timeout' })
    expect(disposeCalls()).toBe(1)
  })

  it('opens no in-process tool channel — the c3 tools reach cursor only as HTTP mcpServers', async () => {
    const { route } = fakeRoute()
    setAutomationHttpMcp(route)

    await run(cursorAutomation({ toolAllowlist: ['mcp__c3__find_intents'] }))

    const start = cursor.lastStart ?? {}
    expect(Object.keys(start.mcpServers as object)).toEqual(['c3'])
    // Nothing else may carry tools into the SDK process.
    for (const key of ['customTools', 'tools', 'inProcessMcp', 'canUseTool']) {
      expect(start[key]).toBeUndefined()
    }
  })

  it('does not bind when the route is unconfigured (c3 selected but no route)', async () => {
    setAutomationHttpMcp(null)

    await run(cursorAutomation({ toolAllowlist: ['mcp__c3__find_intents'] }))

    expect(cursor.lastStart?.mcpServers).toBeUndefined()
  })
})

describe('cursor automation — dispatch-time failures, never a vendor fallback', () => {
  it('fails with a locatable reason when the CLI cannot be resolved', async () => {
    cursor.available = false

    const updates = await run(cursorAutomation())

    expect(updates.at(-1)).toMatchObject({ status: 'failed', error: 'cursor_cli_missing' })
    expect(cursor.lastStart).toBeUndefined()
    expect(claudeQuery.calls).toBe(0)
    expect(codexStart.calls).toBe(0)
  })

  it('surfaces the driver credential error as-is (it names both places a key can live)', async () => {
    cursor.start = () =>
      Promise.reject(
        new Error(
          "cursor: no API key — fill the agent's `apiKey` field, or set CURSOR_API_KEY in the server environment.",
        ),
      )

    const updates = await run(cursorAutomation({ agentId: 'agent-cursor-nokey' }))

    expect(updates.at(-1)?.status).toBe('failed')
    expect(String(updates.at(-1)?.error)).toContain('CURSOR_API_KEY')
    expect(String(updates.at(-1)?.error)).toContain('apiKey')
  })

  const agentCases: Array<[string, string | null | undefined, string]> = [
    ['no agent bound', null, 'automation_agent_required'],
    ['the agent no longer exists', 'agent-gone', 'automation_agent_not_found'],
    ['the agent is disabled', 'agent-cursor-off', 'automation_agent_disabled'],
    ['the agent belongs to another vendor', 'agent-claude', 'automation_agent_vendor_mismatch'],
  ]
  for (const [label, agentId, error] of agentCases) {
    it(`fails before starting when ${label}`, async () => {
      const updates = await run(cursorAutomation({ agentId }))

      expect(updates.at(-1)).toMatchObject({ status: 'failed', error })
      expect(cursor.lastStart).toBeUndefined()
      expect(claudeQuery.calls).toBe(0)
      expect(codexStart.calls).toBe(0)
    })
  }
})
