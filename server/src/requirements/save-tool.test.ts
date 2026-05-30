/**
 * Integration tests for the `save_requirements` MCP tool handler (US-4).
 *
 * The handler is reached only AFTER the requirement gate (claude.ts) has already
 * obtained the user's confirmation, so these tests exercise the post-confirmation
 * contract directly: persist via the store, notify via `onSaved`, and return a
 * `CallToolResult` (with `isError` on failure / db-unavailable).
 *
 * We drive the real handler the SDK registered (`instance._registeredTools`),
 * not a re-implementation, so the test fails if the tool's wiring changes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk'
import type { Requirement } from '@ccc/shared/protocol'
import { resetDbForTests } from './db.js'
import { createRequirementMcpServer } from './save-tool.js'
import { listRequirements, resetStoreForTests } from './store.js'

interface CallToolResult {
  content: { type: string; text: string }[]
  isError?: boolean
}
type Handler = (args: unknown, extra: unknown) => Promise<CallToolResult>

/** Reach into the SDK MCP server instance for the actual registered handler. */
function getSaveHandler(servers: Record<string, McpServerConfig>): Handler {
  // The `c3` server config carries the live MCP server `instance`; its
  // `_registeredTools` map holds the handler the SDK will invoke for a tool call.
  const c3 = servers.c3 as unknown as {
    instance: { _registeredTools: Record<string, { handler: Handler }> }
  }
  return c3.instance._registeredTools.save_requirements.handler
}

const proj = '/abs/save-tool-proj'
let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'c3-save-'))
  process.env.C3_DB_PATH = join(dir, 'c3.db')
  resetDbForTests()
  resetStoreForTests()
})

afterEach(() => {
  resetDbForTests()
  delete process.env.C3_DB_PATH
  rmSync(dir, { recursive: true, force: true })
})

describe('save_requirements tool handler', () => {
  it('exposes the tool on the c3 server (mcp__c3__save_requirements)', () => {
    // AC-4.1: the agent submits via a tool named save_requirements on server `c3`.
    const servers = createRequirementMcpServer(proj, () => {})
    expect(Object.keys(servers)).toEqual(['c3'])
    const c3 = servers.c3 as unknown as {
      name: string
      instance: { _registeredTools: Record<string, unknown> }
    }
    expect(c3.name).toBe('c3')
    expect(Object.keys(c3.instance._registeredTools)).toContain('save_requirements')
  })

  it('persists a confirmed batch as todo, calls onSaved, returns a success result', async () => {
    // AC-4.3 / AC-4.4: reaching the handler == user allowed; rows land as `todo`,
    // scoped to the project; onSaved fires so the server can broadcast a refresh.
    const onSaved = vi.fn()
    const handler = getSaveHandler(createRequirementMcpServer(proj, onSaved))

    const res = await handler(
      {
        requirements: [
          { title: 'Login', content: 'auth flow', priority: 'P0' },
          { title: 'Logout', content: 'end session', priority: 'P1', dependsOn: ['x'] },
        ],
      },
      {},
    )

    expect(res.isError).toBeFalsy()
    expect(res.content[0].type).toBe('text')
    expect(res.content[0].text).toContain('已保存 2 条需求')
    expect(res.content[0].text).toContain('Login')

    expect(onSaved).toHaveBeenCalledTimes(1)
    expect(onSaved).toHaveBeenCalledWith(proj)

    const saved = listRequirements(proj)
    expect(saved.map((r) => r.title).sort()).toEqual(['Login', 'Logout'])
    expect(saved.every((r: Requirement) => r.status === 'todo')).toBe(true)
    const logout = saved.find((r) => r.title === 'Logout')!
    expect(logout.dependsOn).toEqual(['x'])
  })

  it('binds to the closure project path, not a wire-supplied one (no cross-project save)', async () => {
    // Design R6 / §4.5: projectPath is captured in the closure so the agent can't
    // redirect the save elsewhere. Two servers for two projects stay isolated.
    const handlerA = getSaveHandler(createRequirementMcpServer('/abs/proj-a', () => {}))
    const handlerB = getSaveHandler(createRequirementMcpServer('/abs/proj-b', () => {}))
    await handlerA({ requirements: [{ title: 'A', content: '', priority: 'P0' }] }, {})
    await handlerB({ requirements: [{ title: 'B', content: '', priority: 'P0' }] }, {})
    expect(listRequirements('/abs/proj-a').map((r) => r.title)).toEqual(['A'])
    expect(listRequirements('/abs/proj-b').map((r) => r.title)).toEqual(['B'])
  })

  it('returns isError without persisting when the store is unavailable', async () => {
    // §4.5: db-down ⇒ the handler tells the agent it was not saved (isError) so the
    // agent does not claim success. Force unavailability with a bad db path.
    resetDbForTests()
    resetStoreForTests()
    // Point at a path under a non-directory so open/mkdir fails ⇒ db unavailable.
    process.env.C3_DB_PATH = '/dev/null/cannot/c3.db'
    const onSaved = vi.fn()
    const handler = getSaveHandler(createRequirementMcpServer(proj, onSaved))
    const res = await handler({ requirements: [{ title: 'X', content: '', priority: 'P0' }] }, {})
    expect(res.isError).toBe(true)
    expect(res.content[0].text).toContain('不可用')
    expect(onSaved).not.toHaveBeenCalled()
  })
})
