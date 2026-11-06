/**
 * Claude Agent SDK 0.3.289 → 0.3.318 compatibility boundaries (upgrade 留痕).
 *
 * Drives the REAL `runClaude` / `runTaskTool` / `askOneShot` / `askAgentOnce` with the
 * SDK `query` mocked (same seam as prior compat tests) to pin what this window changed
 * for c3 — and what it did NOT:
 *
 *  - **`SDKMessage` adds `system` / `subtype: 'session_writes_lost'`** (0.3.317). It may
 *    arrive after the terminal `result` on non-team paths where c3 closes streaming
 *    input; must not emit wire frames, duplicate `turn_end`, or throw.
 *  - **`permissionMode` omission semantics shifted again** (0.3.302 for third-party
 *    providers). Every `query` construction site sets `permissionMode` explicitly
 *    (including `agent-once`, slash-command listing, automation naming) — asserted here
 *    alongside the driver's `toPermissionMode` grid.
 *  - **`subagent_type: "fork"` default** (0.3.302): team detection stays on top-level
 *    `TeamCreate` / `SendMessage` / background `Agent` only — task tools with fork
 *    metadata stay non-team.
 *  - **Hooks gain optional `onFailure`** (0.3.317): robot `PreToolUse` keeps the prior
 *    shape; c3 does not pass `onFailure`.
 *  - **`alwaysLoad` / MCP warning / hook placement** — unchanged assertions vs 0.3.289.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentConfig } from '@ccc/shared/protocol'
import type { ServerToClient } from '@ccc/shared/protocol'

const sdk = vi.hoisted(() => ({
  streams: [] as Array<Array<Record<string, unknown>>>,
  options: [] as Array<Record<string, unknown>>,
}))

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (arg: { options?: Record<string, unknown> }) => {
    sdk.options.push(arg.options ?? {})
    const steps = sdk.streams.shift() ?? []
    return {
      async *[Symbol.asyncIterator]() {
        for (const s of steps) yield s
      },
      interrupt: () => Promise.resolve(),
      setPermissionMode: () => Promise.resolve(),
      /** Used by `listCommands` (control channel only; no model turn). */
      supportedCommands: async () => [],
    }
  },
}))

/** `askAgentOnce` wires advisor sessions without loading project settings — keep that. */
vi.mock('./kernel/agent-config/index.js', () => ({
  launchForAgent: () => ({ envOverrides: undefined, model: undefined, relayCandidates: undefined }),
  bindClaudeRelay: () => null,
  unbindRelay: () => {},
}))

vi.mock('./kernel/run/internal-run.js', () => ({
  beginInternalRun: () => ({
    bind: () => {},
    settle: () => {},
    fail: () => {},
  }),
}))

vi.mock('./sessions.js', () => ({
  addToolSession: () => {},
}))

import { serve, type ServerType } from '@hono/node-server'
import { Hono } from 'hono'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { askAgentOnce } from './agent-once.js'
import { listCommands } from './commands.js'
import { runClaude, runTaskTool, askOneShot, isTeamTool } from './kernel/agent/index.js'
import { toPermissionMode } from './kernel/agent/adapters/claude/permission-map.js'
import {
  isSuppressedClaudeWarning,
  SHADOWED_WARNING_CODE,
} from './kernel/agent/adapters/claude/sdk-warning-filter.js'
import {
  createIntentMcp,
  INTENT_MCP_PATH,
  type IntentMcpTools,
} from './transport/intent-mcp/index.js'

/** The SDK warning code 0.3.289 adds; c3 must let it through (a real misconfig). */
const UNCONVERTIBLE_WARNING_CODE = 'CLAUDE_SDK_MCP_TOOL_SCHEMA_UNCONVERTIBLE'

const minimalClaudeAgent: AgentConfig = {
  id: 'compat-advisor',
  vendor: 'claude',
  configMode: 'system',
  displayName: 'Compat',
  config: { baseUrl: '', apiKey: '', model: '' },
}

const init = (extra: Record<string, unknown> = {}) => ({
  type: 'system',
  subtype: 'init',
  session_id: 'sid-0318',
  ...extra,
})
const assistantText = (text: string) => ({
  type: 'assistant',
  message: { content: [{ type: 'text', text }] },
})
const toolResult = (id: string, content: unknown) => ({
  type: 'user',
  message: { content: [{ type: 'tool_result', tool_use_id: id, content, is_error: false }] },
})
const result = (extra: Record<string, unknown> = {}) => ({ type: 'result', ...extra })

async function runTurn(overrides: Record<string, unknown> = {}): Promise<ServerToClient[]> {
  const events: ServerToClient[] = []
  await runClaude({
    prompt: 'do the thing',
    cwd: '/tmp',
    workspacePath: '/tmp',
    signal: new AbortController().signal,
    permissionMode: 'default',
    send: (m) => events.push(m),
    ...overrides,
  })
  return events
}

beforeEach(() => {
  sdk.streams = []
  sdk.options = []
})

describe('SDK 0.3.317 session_writes_lost — after result on non-team path', () => {
  it('does not emit wire frames, duplicate turn_end, or throw when input closes after result', async () => {
    sdk.streams.push([
      init(),
      assistantText('ok'),
      result({ subtype: 'success' }),
      { type: 'system', subtype: 'session_writes_lost', message: 'buffers lost' },
    ])
    const events = await runTurn()

    expect(events.filter((e) => e.type === 'assistant_text')).toHaveLength(1)
    expect(events.filter((e) => e.type === 'turn_end')).toHaveLength(1)
    expect(events[events.length - 1]).toMatchObject({ type: 'turn_end', reason: 'complete' })
    expect(JSON.stringify(events).includes('session_writes_lost')).toBe(false)
  })
})

describe('SDK 0.3.289 + 0.3.318 frames — ignored unless mapped', () => {
  it('a get_task_output control_request and informational.tag produce no wire frame and do not close the turn', async () => {
    sdk.streams.push([
      init(),
      {
        type: 'control_request',
        request_id: 'req-1',
        request: { subtype: 'get_task_output', task_id: 't-1' },
      },
      { type: 'system', subtype: 'informational', tag: 'notice', message: 'a notice' },
      assistantText('ok'),
      result({
        subtype: 'success',
        first_text_post_queue_wait_ms: 12,
        first_text_post_queued_behind: 3,
      }),
    ])
    const events = await runTurn()

    expect(events.filter((e) => e.type === 'assistant_text')).toHaveLength(1)
    const ends = events.filter((e) => e.type === 'turn_end')
    expect(ends).toHaveLength(1)
    expect(ends[0]).toMatchObject({ type: 'turn_end', reason: 'complete' })
    const serialized = JSON.stringify(events)
    for (const token of [
      'control_request',
      'get_task_output',
      'first_text_post_queue_wait_ms',
      'first_text_post_queued_behind',
      '"tag"',
    ]) {
      expect(serialized.includes(token)).toBe(false)
    }
  })

  it('an entirely unknown top-level frame type is ignored without closing the turn', async () => {
    sdk.streams.push([
      init(),
      { type: 'brand_new_frame', payload: { whatever: true } },
      assistantText('still here'),
      result(),
    ])
    const events = await runTurn()

    expect(events.filter((e) => e.type === 'assistant_text')).toHaveLength(1)
    expect(events.filter((e) => e.type === 'turn_end')).toHaveLength(1)
    expect(JSON.stringify(events).includes('brand_new_frame')).toBe(false)
  })
})

describe('permissionMode is explicit at every query construction point (0.3.302+)', () => {
  it('runClaude forwards the caller-chosen mode verbatim (bypassPermissions never relies on the SDK default)', async () => {
    sdk.streams.push([init(), assistantText('a'), result()])
    await runTurn({ permissionMode: 'bypassPermissions' })
    expect(sdk.options[0].permissionMode).toBe('bypassPermissions')

    sdk.streams.push([init(), assistantText('b'), result()])
    await runTurn({ permissionMode: 'acceptEdits' })
    expect(sdk.options[1].permissionMode).toBe('acceptEdits')

    sdk.streams.push([init(), assistantText('c'), result()])
    await runTurn()
    expect(sdk.options[2].permissionMode).toBe('default')
  })

  it('runTaskTool passes permissionMode: default explicitly', async () => {
    sdk.streams.push([init(), toolResult('tu-1', '{"tasks":[]}'), result()])
    await runTaskTool({
      toolName: 'TaskList',
      input: {},
      cwd: '/tmp',
      signal: new AbortController().signal,
    })
    expect(sdk.options[0].permissionMode).toBe('default')
  })

  it('askOneShot passes permissionMode: default explicitly', async () => {
    sdk.streams.push([init(), assistantText('verdict'), result()])
    await askOneShot({
      prompt: 'judge this',
      cwd: '/tmp',
      signal: new AbortController().signal,
      agentId: 'agent-1',
    })
    expect(sdk.options[0].permissionMode).toBe('default')
  })

  it('askAgentOnce passes permissionMode: default explicitly', async () => {
    sdk.streams.push([init(), assistantText('advisor'), result()])
    await askAgentOnce(minimalClaudeAgent, 'vote', '/tmp', new AbortController().signal)
    expect(sdk.options[0].permissionMode).toBe('default')
  })

  it('listCommands passes permissionMode: default explicitly', async () => {
    await listCommands('/tmp')
    expect(sdk.options[0].permissionMode).toBe('default')
  })

  it('runClaude / runTaskTool / askOneShot keep settingSources user+project where configured', async () => {
    sdk.streams.push([init(), assistantText('a'), result()])
    await runTurn()
    expect(sdk.options[0].settingSources).toEqual(['user', 'project'])

    sdk.options = []
    sdk.streams.push([init(), toolResult('tu-1', 'x'), result()])
    await runTaskTool({
      toolName: 'TaskList',
      input: {},
      cwd: '/tmp',
      signal: new AbortController().signal,
    })
    expect(sdk.options[0].settingSources).toEqual(['user', 'project'])

    sdk.options = []
    sdk.streams.push([init(), assistantText('v'), result()])
    await askOneShot({
      prompt: 'j',
      cwd: '/tmp',
      signal: new AbortController().signal,
      agentId: 'a',
    })
    expect(sdk.options[0].settingSources).toEqual(['user', 'project'])
  })

  it('askAgentOnce intentionally does not use settingSources (light advisor path)', async () => {
    sdk.streams.push([init(), assistantText('x'), result()])
    await askAgentOnce(minimalClaudeAgent, 'p', '/tmp', new AbortController().signal)
    expect(sdk.options[0]).not.toHaveProperty('settingSources')
  })

  it('the driver grid (toPermissionMode) resolves every cell to a concrete mode', () => {
    const actionModes = ['plan', 'build'] as const
    const toolGates = ['always-ask', 'on-sensitive', 'trusted-prefix', 'never-ask'] as const
    for (const actionMode of actionModes) {
      for (const toolGate of toolGates) {
        expect(typeof toPermissionMode(actionMode, toolGate)).toBe('string')
        expect(toPermissionMode(actionMode, toolGate).length).toBeGreaterThan(0)
      }
    }
  })
})

describe('0.3.302 fork default — task / team tool surface', () => {
  it('does not treat TaskCreate with subagent_type fork as a team-liveness tool', () => {
    expect(isTeamTool('TaskCreate', { subagent_type: 'fork', subject: 's' })).toBe(false)
  })
})

describe('0.3.317 hooks.onFailure — robot PreToolUse unchanged shape', () => {
  it('the standard gate carries no hooks key', async () => {
    sdk.streams.push([init(), assistantText('ok'), result()])
    await runTurn()
    expect(sdk.options[0]).not.toHaveProperty('hooks')
  })

  it('the intent and spec gates carry no hooks key', async () => {
    sdk.streams.push([init(), assistantText('ok'), result()])
    await runTurn({ gate: 'intent' })
    expect(sdk.options[0]).not.toHaveProperty('hooks')

    sdk.streams.push([init(), assistantText('ok'), result()])
    await runTurn({ gate: 'spec', specDir: '/tmp' })
    expect(sdk.options[1]).not.toHaveProperty('hooks')
  })

  it('the robot gate carries PreToolUse only; query options do not set onFailure', async () => {
    sdk.streams.push([init(), assistantText('ok'), result()])
    await runTurn({ gate: 'robot', robotRoot: '/tmp/robot-root' })

    const hooks = sdk.options[0].hooks as Record<string, unknown>
    expect(hooks).toEqual(expect.objectContaining({ PreToolUse: expect.any(Array) }))
    expect(Object.keys(hooks)).toEqual(['PreToolUse'])
    expect(sdk.options[0]).not.toHaveProperty('onFailure')
  })
})

describe('0.3.295 MCP tool_use_result size — loopback task path still parses', () => {
  it('runTaskTool tolerates a large tool_result payload', async () => {
    const big = 'x'.repeat(120_000)
    sdk.streams.push([init(), toolResult('tu-1', big), result()])
    const out = await runTaskTool({
      toolName: 'TaskList',
      input: {},
      cwd: '/tmp',
      signal: new AbortController().signal,
    })
    expect(out.isError).toBe(false)
    expect(out.content.length).toBeGreaterThan(100_000)
  })
})

describe('SDK warning filter stays narrow (0.3.289 code)', () => {
  it('drops only CLAUDE_SDK_CAN_USE_TOOL_SHADOWED (options-object and positional forms)', () => {
    expect(SHADOWED_WARNING_CODE).toBe('CLAUDE_SDK_CAN_USE_TOOL_SHADOWED')
    expect(isSuppressedClaudeWarning({ code: SHADOWED_WARNING_CODE })).toBe(true)
    expect(isSuppressedClaudeWarning('SomeType', SHADOWED_WARNING_CODE)).toBe(true)
  })

  it('lets the CLAUDE_SDK_MCP_TOOL_SCHEMA_UNCONVERTIBLE code through', () => {
    expect(isSuppressedClaudeWarning({ code: UNCONVERTIBLE_WARNING_CODE })).toBe(false)
    expect(isSuppressedClaudeWarning('SomeType', UNCONVERTIBLE_WARNING_CODE)).toBe(false)
  })
})

describe('alwaysLoad stays effective for c3 loopback MCP tools', () => {
  it('runClaude translates every bound c3 server to { type: http, url, alwaysLoad: true } with no _meta', async () => {
    sdk.streams.push([init(), assistantText('ok'), result()])
    await runTurn({
      bindMcp: () => ({
        servers: {
          c3: {
            type: 'http',
            url: 'http://127.0.0.1:1/internal/intent-mcp/v1?token=t',
            enabledTools: ['find_intents', 'view_intent', 'save_intents'],
          },
        },
        dispose: () => {},
      }),
    })

    const servers = sdk.options[0].mcpServers as Record<string, Record<string, unknown>>
    expect(servers.c3).toEqual({
      type: 'http',
      url: 'http://127.0.0.1:1/internal/intent-mcp/v1?token=t',
      alwaysLoad: true,
    })
    expect(servers.c3).not.toHaveProperty('_meta')
  })

  describe('the real intent MCP route emits no per-tool _meta alwaysLoad override', () => {
    let server: ServerType
    let port = 0
    const tools: IntentMcpTools = {
      find: () => ({ content: [{ type: 'text', text: 'FOUND' }] }),
      view: () => ({ content: [{ type: 'text', text: 'VIEWED' }] }),
      save: () => ({ content: [{ type: 'text', text: 'SAVED' }] }),
    }
    const intentMcp = createIntentMcp('http://127.0.0.1', tools, () => 'tok-0318')

    beforeAll(async () => {
      const app = new Hono()
      app.all(INTENT_MCP_PATH, (c) => intentMcp.handler(c))
      await new Promise<void>((resolve) => {
        server = serve({ fetch: app.fetch, port: 0 }, (info) => {
          port = info.port
          resolve()
        })
      })
    })
    afterAll(() => {
      server?.close()
    })

    it('lists the three c3 tools without any anthropic/alwaysLoad _meta', async () => {
      const { dispose } = intentMcp.bind({
        workspacePath: '/abs/p',
        getRunId: () => 'run-1',
        signal: new AbortController().signal,
      })
      const client = new Client({ name: 'test', version: '1.0.0' })
      const transport = new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${port}${INTENT_MCP_PATH}?token=tok-0318`),
      )
      await client.connect(transport)
      try {
        const listed = await client.listTools()
        expect(listed.tools.map((t) => t.name).sort()).toEqual([
          'find_intents',
          'save_intents',
          'view_intent',
        ])
        expect(JSON.stringify(listed.tools).includes('anthropic/alwaysLoad')).toBe(false)
        for (const tool of listed.tools) {
          expect(tool._meta?.['anthropic/alwaysLoad']).not.toBe(false)
        }
      } finally {
        await client.close()
        dispose()
      }
    })
  })
})
