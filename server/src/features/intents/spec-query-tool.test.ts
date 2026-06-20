/**
 * Unit tests for the spec author's read-only ledger MCP server
 * (`createSpecQueryMcpServer`). The spec session gets EXACTLY two project-bound,
 * read-only tools — `find_intents` / `view_intent` — and NO `save_intents`:
 *  - the tool set is precisely {find_intents, view_intent} (AC1) and excludes
 *    save_intents (AC5 main defence: save is never advertised);
 *  - find binds to the closure project — another project's intents never appear (AC2);
 *  - view returns full detail for an in-project id but treats a cross-project id as
 *    not-found, leaking nothing (AC3);
 *  - a store-down handler reports `isError` text rather than throwing (edge).
 *
 * We drive the real handlers the SDK registered (`instance._registeredTools`), not
 * re-implementations, so the test fails if the tool wiring changes.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// Stub only the registry id↔path mapping (identity): synthetic test workspaces
// are unregistered, so resolve/pathToId would otherwise return null. This mirrors
// save-tool.test.ts so `runView`'s cross-project guard resolves predictably.
import { vi } from 'vitest'
vi.mock('../../state.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../state.js')>()),
  resolveWorkspaceRoot: (id: string) => id,
  pathToId: (p: string) => p,
}))
import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk'
import { resetDbForTests } from '../../kernel/infra/db.js'
import { createSpecQueryMcpServer } from './spec-query-tool.js'
import { insertIntents, resetStoreForTests } from './store.js'

interface CallToolResult {
  content: { type: string; text: string }[]
  isError?: boolean
}
type Handler = (args: unknown, extra: unknown) => Promise<CallToolResult>

/** Reach into the SDK MCP server instance for an actual registered tool handler. */
function getHandler(servers: Record<string, McpServerConfig>, toolName: string): Handler {
  const c3 = servers.c3 as unknown as {
    instance: { _registeredTools: Record<string, { handler: Handler }> }
  }
  return c3.instance._registeredTools[toolName].handler
}

const proj = '/abs/spec-query-proj'
let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'c3-spec-query-'))
  process.env.C3_DB_PATH = join(dir, 'c3.db')
  resetDbForTests()
  resetStoreForTests()
})

afterEach(() => {
  resetDbForTests()
  delete process.env.C3_DB_PATH
  rmSync(dir, { recursive: true, force: true })
})

describe('createSpecQueryMcpServer — read-only ledger tools for the spec author', () => {
  it('registers EXACTLY find_intents + view_intent on the c3 server, and NO save_intents (AC1/AC5)', () => {
    const servers = createSpecQueryMcpServer(proj)
    expect(Object.keys(servers)).toEqual(['c3'])
    const c3 = servers.c3 as unknown as {
      name: string
      instance: { _registeredTools: Record<string, unknown> }
    }
    expect(c3.name).toBe('c3')
    const names = Object.keys(c3.instance._registeredTools).sort()
    expect(names).toEqual(['find_intents', 'view_intent'])
    expect(names).not.toContain('save_intents')
  })

  it('marks both tools always-load so they stay resident (no ToolSearch first)', () => {
    const servers = createSpecQueryMcpServer(proj)
    const c3 = servers.c3 as unknown as {
      instance: { _registeredTools: Record<string, { _meta?: Record<string, unknown> }> }
    }
    expect(c3.instance._registeredTools.find_intents._meta).toMatchObject({
      'anthropic/alwaysLoad': true,
    })
    expect(c3.instance._registeredTools.view_intent._meta).toMatchObject({
      'anthropic/alwaysLoad': true,
    })
  })

  it('find_intents returns only THIS project (no cross-project read) (AC2)', async () => {
    insertIntents(proj, [
      { title: 'AOnly', shortEnTitle: 'auto', content: 'shared', priority: 'P0' },
    ])
    insertIntents('/abs/other-proj', [
      { title: 'BOnly', shortEnTitle: 'auto', content: 'shared', priority: 'P0' },
    ])
    const find = getHandler(createSpecQueryMcpServer(proj), 'find_intents')
    const res = await find({ keyword: 'shared' }, {})
    expect(res.isError).toBeFalsy()
    expect(res.content[0].text).toContain('AOnly')
    expect(res.content[0].text).not.toContain('BOnly')
  })

  it('view_intent returns full detail for an in-project id (AC3)', async () => {
    const [r] = insertIntents(proj, [
      {
        title: 'Detail',
        shortEnTitle: 'auto',
        content: 'long body',
        priority: 'P1',
        dependsOn: ['ext'],
      },
    ])
    const view = getHandler(createSpecQueryMcpServer(proj), 'view_intent')
    const res = await view({ id: r.id }, {})
    expect(res.isError).toBeFalsy()
    const detail = JSON.parse(res.content[0].text) as Record<string, unknown>
    expect(detail.id).toBe(r.id)
    expect(detail.content).toBe('long body')
    expect(detail.dependsOn).toEqual(['ext'])
  })

  it('view_intent treats a cross-project id as not-found and leaks nothing (AC3)', async () => {
    const [other] = insertIntents('/abs/other-proj', [
      { title: 'Secret', shortEnTitle: 'auto', content: 's', priority: 'P0' },
    ])
    const view = getHandler(createSpecQueryMcpServer(proj), 'view_intent')
    const res = await view({ id: other.id }, {})
    expect(res.content[0].text).toContain('未找到')
    expect(res.content[0].text).not.toContain('Secret')
  })

  it('is deterministic across calls — first-launch and reset get the SAME two tools (AC4)', () => {
    // Both `write_spec` (first launch) and `reset_spec_session` create a `kind:'spec'`
    // runtime routed through launchRun's single spec branch → the one specProfile
    // factory → this constructor. There is no separate reset injection point, so a
    // reset session is provisioned by an equivalent call. Pin that equivalence: the
    // tool set is identical on every invocation (no hidden first-call-only state).
    const first = createSpecQueryMcpServer(proj)
    const reset = createSpecQueryMcpServer(proj)
    const toolsOf = (servers: Record<string, McpServerConfig>): string[] => {
      const c3 = servers.c3 as unknown as {
        instance: { _registeredTools: Record<string, unknown> }
      }
      return Object.keys(c3.instance._registeredTools).sort()
    }
    expect(toolsOf(reset)).toEqual(toolsOf(first))
    expect(toolsOf(reset)).toEqual(['find_intents', 'view_intent'])
  })

  it('reports isError text (does not throw) when the store is unavailable (edge)', async () => {
    resetDbForTests()
    resetStoreForTests()
    // Point at a path under a non-directory so open/mkdir fails ⇒ db unavailable.
    process.env.C3_DB_PATH = '/dev/null/cannot/c3.db'
    const find = getHandler(createSpecQueryMcpServer(proj), 'find_intents')
    const res = await find({}, {})
    expect(res.isError).toBe(true)
    expect(res.content[0].text).toContain('不可用')
  })
})
