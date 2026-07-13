/**
 * Tests for the automation-only c3 MCP profile and its `save_intent_directly`
 * write. Two contracts:
 *  - `runSaveIntentDirectly` lands a batch of NEW intents as `draft` (not `todo`),
 *    bypasses the confirmation gate entirely (no permission_request / gatedSave —
 *    it just writes), and fires `onSaved` so the list refreshes.
 *  - Injection boundary: `createAutomationMcpServer` registers `save_intent_directly`
 *    while the interactive `createIntentMcpServer` does NOT — the gate-bypassing
 *    write is pinned to unattended automation executions only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// Identity id↔path mapping: synthetic test workspaces are unregistered.
vi.mock('../../state.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../state.js')>()),
  resolveWorkspaceRoot: (id: string) => id,
  pathToId: (p: string) => p,
}))
import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk'
import type { Discussion } from '@ccc/shared/protocol'
import { resetDbForTests } from '../../kernel/infra/db.js'
import { listIntents, resetStoreForTests } from '../../features/intents/store.js'
import { runSaveIntentDirectly } from '../../features/intents/tool-defs.js'
import { createIntentMcpServer } from '../../features/intents/save-tool.js'
import {
  createDiscussion,
  listMessages,
  resetStoreForTests as resetDiscussionStoreForTests,
  updateDiscussionStatus,
} from '../../features/discussions/store.js'
import { configureAutomationMcp, createAutomationMcpServer } from './c3-mcp.js'
import { AUTOMATION_C3_TOOL_NAMES } from './c3-tools.js'

interface CallToolResult {
  content: { type: string; text: string }[]
  isError?: boolean
}
type ToolHandler = (args: unknown, extra: unknown) => Promise<CallToolResult>

/** Registered tool names on a c3 SDK MCP server config. */
function registeredToolNames(servers: Record<string, McpServerConfig>): string[] {
  const c3 = servers.c3 as unknown as {
    instance: { _registeredTools: Record<string, unknown> }
  }
  return Object.keys(c3.instance._registeredTools)
}

/** The REAL handler the SDK registered for one tool (drives actual wiring). */
function getHandler(servers: Record<string, McpServerConfig>, toolName: string): ToolHandler {
  const c3 = servers.c3 as unknown as {
    instance: { _registeredTools: Record<string, { handler: ToolHandler }> }
  }
  return c3.instance._registeredTools[toolName].handler
}

const proj = '/abs/sched-c3-proj'
let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'c3-sched-'))
  process.env.C3_DB_PATH = join(dir, 'c3.db')
  resetDbForTests()
  resetStoreForTests()
  resetDiscussionStoreForTests()
})

afterEach(() => {
  resetDbForTests()
  delete process.env.C3_DB_PATH
  rmSync(dir, { recursive: true, force: true })
})

describe('runSaveIntentDirectly', () => {
  it('lands new intents as draft and fires onSaved', () => {
    let saved: string | null = null
    const result = runSaveIntentDirectly(
      proj,
      {
        intents: [
          {
            title: 'Refactor god-file',
            shortEnTitle: 'refactor-god-file',
            content: 'x',
            priority: 'P2',
          },
          {
            title: 'Break cyclic dep',
            shortEnTitle: 'break-cyclic-dep',
            content: 'y',
            priority: 'P3',
          },
        ],
      },
      (p) => {
        saved = p
      },
    )
    expect(result.isError).toBeFalsy()
    expect(saved).toBe(proj)
    const rows = listIntents(proj)
    expect(rows).toHaveLength(2)
    expect(rows.every((r) => r.status === 'draft')).toBe(true)
  })
})

describe('automation c3 MCP injection boundary', () => {
  it('registers save_intent_directly on the automation server', () => {
    const names = registeredToolNames(createAutomationMcpServer(proj, 'exec-1'))
    expect(names).toContain('save_intent_directly')
    expect(names).toContain('find_intents')
    expect(names).toContain('view_intent')
  })

  it('does NOT register save_intent_directly on the interactive intent server', () => {
    const servers = createIntentMcpServer(
      { workspacePath: proj, getRunId: () => 'run-1', signal: new AbortController().signal },
      {
        emit: () => {},
        waitForDecision: async () => ({ decision: 'allow' }),
        broadcastIntents: () => {},
        onPermissionRequest: () => {},
      },
    )
    const names = registeredToolNames(servers)
    expect(names).not.toContain('save_intent_directly')
    expect(names).toContain('save_intents')
  })

  it('registers the four discussion tools on the automation server', () => {
    const names = registeredToolNames(createAutomationMcpServer(proj, 'exec-1'))
    expect(names).toContain('find_discussions')
    expect(names).toContain('view_discussion')
    expect(names).toContain('start_discussion')
    expect(names).toContain('continue_discussion')
  })

  it('route enabledTools list equals the tools registered on the automation SDK server', () => {
    // Drift lock: the codex HTTP route advertises `AUTOMATION_C3_TOOL_NAMES` as its
    // explicit enabledTools; it MUST equal what the Claude in-process SDK server
    // registers, or a tool is registered but silently disabled on codex.
    const registered = registeredToolNames(createAutomationMcpServer(proj, 'exec-1')).sort()
    expect([...AUTOMATION_C3_TOOL_NAMES].sort()).toEqual(registered)
  })
})

describe('automation c3 MCP — discussion tool wiring', () => {
  it('binds find_discussions to the automation workspace', async () => {
    createDiscussion({ workspacePath: proj, title: 'Bound one', type: 'general', goal: 'g' })
    createDiscussion({ workspacePath: '/abs/other', title: 'Foreign', type: 'general', goal: 'g' })
    const handler = getHandler(createAutomationMcpServer(proj, 'exec-1'), 'find_discussions')
    const res = await handler({}, {})
    expect(res.isError).toBeFalsy()
    expect(res.content[0].text).toContain('Bound one')
    expect(res.content[0].text).not.toContain('Foreign')
  })

  it('start_discussion passes the bound workspace + run starter through', async () => {
    const started: Discussion[] = []
    configureAutomationMcp({
      broadcastIntents: () => {},
      normalizeEvent: () => ({ ok: false, reason: 'not wired in this test' }),
      publishEvent: () => {},
      broadcastDiscussions: () => {},
      broadcastDiscussionMessage: () => {},
      startDiscussionRun: (d) => started.push(d),
      launchRun: vi.fn().mockResolvedValue(undefined),
    })
    const draft = createDiscussion({
      workspacePath: proj,
      title: 'Startable',
      type: 'general',
      goal: 'g',
    })
    const handler = getHandler(createAutomationMcpServer(proj, 'exec-1'), 'start_discussion')
    const res = await handler({ discussionId: draft.id }, {})
    expect(res.isError).toBeFalsy()
    expect(started.map((d) => d.id)).toEqual([draft.id])
  })

  it('continue_discussion (completed) broadcasts message + refreshed list and starts a run', async () => {
    const started: Discussion[] = []
    const messages: string[] = []
    const refreshed: string[] = []
    configureAutomationMcp({
      broadcastIntents: () => {},
      normalizeEvent: () => ({ ok: false, reason: 'not wired in this test' }),
      publishEvent: () => {},
      broadcastDiscussions: (p) => refreshed.push(p),
      broadcastDiscussionMessage: (_id, m) => messages.push(m.content),
      startDiscussionRun: (d) => started.push(d),
      launchRun: vi.fn().mockResolvedValue(undefined),
    })
    const done = createDiscussion({
      workspacePath: proj,
      title: 'Done',
      type: 'general',
      goal: 'g',
    })
    updateDiscussionStatus(done.id, 'completed')
    const handler = getHandler(createAutomationMcpServer(proj, 'exec-1'), 'continue_discussion')
    const res = await handler({ discussionId: done.id, text: '再来一轮' }, {})
    expect(res.isError).toBeFalsy()
    expect(messages).toEqual(['再来一轮'])
    expect(refreshed).toEqual([proj])
    expect(started).toHaveLength(1)
    expect(started[0].status).toBe('in_progress')
    expect(listMessages(done.id)).toHaveLength(1)
  })
})
