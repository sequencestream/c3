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
import { resetDbForTests } from '../../kernel/infra/db.js'
import { listIntents, resetStoreForTests } from '../../features/intents/store.js'
import { runSaveIntentDirectly } from '../../features/intents/tool-defs.js'
import { createIntentMcpServer } from '../../features/intents/save-tool.js'
import { createAutomationMcpServer } from './c3-mcp.js'

/** Registered tool names on a c3 SDK MCP server config. */
function registeredToolNames(servers: Record<string, McpServerConfig>): string[] {
  const c3 = servers.c3 as unknown as {
    instance: { _registeredTools: Record<string, unknown> }
  }
  return Object.keys(c3.instance._registeredTools)
}

const proj = '/abs/sched-c3-proj'
let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'c3-sched-'))
  process.env.C3_DB_PATH = join(dir, 'c3.db')
  resetDbForTests()
  resetStoreForTests()
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
})
