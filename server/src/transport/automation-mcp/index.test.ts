/**
 * Automation MCP HTTP route — the codex twin of the automation in-process c3
 * profile. Covers:
 *  - the loopback predicate (non-local peers rejected; defence in depth);
 *  - unknown-token rejection (404) at the route;
 *  - a REAL MCP client over streamable-HTTP that lists ALL automation c3 tools and
 *    calls one end-to-end (proving the shared tool set is forwarded, not the intent
 *    route's 3-tool subset);
 *  - the per-execution `enabledTools` descriptor equals the shared tool-name list;
 *  - dispose evicts the token: the same URL 404s afterward.
 * Tool behaviors are the shared framing-free builders bound to a temp-db workspace,
 * so this exercises the transport plumbing end-to-end without codex's binary.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Identity id↔path mapping: synthetic test workspaces are unregistered.
vi.mock('../../state.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../state.js')>()),
  resolveWorkspaceRoot: (id: string) => id,
  pathToName: (p: string) => p,
  workspaceNameFor: (value: string) => value,
}))

// The sync tool reaches the forge through `getForgePrStatus`; the integration test
// pins the forge verdict without shelling out. Other git.js exports are preserved
// (the session launcher / route may still import them).
vi.mock('../../git.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../git.js')>()),
  getForgePrStatus: vi.fn(),
}))

import { serve, type ServerType } from '@hono/node-server'
import { Hono } from 'hono'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { getForgePrStatus } from '../../git.js'
import { resetDbForTests } from '../../kernel/infra/db.js'
import {
  getIntent,
  insertIntents,
  listIntentLogs,
  resetStoreForTests,
  upsertIntentPr,
} from '../../features/intents/store.js'
import {
  AUTOMATION_C3_TOOL_NAMES,
  type AutomationMcpDeps,
} from '../../features/automations/c3-tools.js'
import {
  createAutomationMcp,
  AUTOMATION_MCP_PATH,
  isLoopback,
  type ServedAutomationMcp,
} from './index.js'

describe('isLoopback', () => {
  it.each([
    ['127.0.0.1', true],
    ['::1', true],
    ['::ffff:127.0.0.1', true],
    ['127.0.0.5', true],
    ['192.168.1.2', false],
    ['10.0.0.1', false],
    ['', false],
  ])('%s ⇒ %s', (addr, expected) => {
    expect(isLoopback(addr === '' ? undefined : addr)).toBe(expected)
  })
})

describe('automation MCP HTTP route', () => {
  const proj = '/abs/automation-mcp-proj'
  const deps: AutomationMcpDeps = {
    broadcastIntents: () => {},
    normalizeEvent: () => ({ ok: false, reason: 'not wired in this test' }),
    publishEvent: () => {},
    broadcastDiscussions: () => {},
    broadcastDiscussionMessage: () => {},
    startDiscussionRun: () => {},
    launchRun: async () => {},
  }

  let server: ServerType
  let port: number
  let automationMcp: ServedAutomationMcp
  let dir: string

  beforeAll(async () => {
    automationMcp = createAutomationMcp('http://127.0.0.1', deps)
    const app = new Hono()
    app.all(AUTOMATION_MCP_PATH, (c) => automationMcp.handler(c))
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

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'c3-automation-mcp-'))
    process.env.C3_DB_PATH = join(dir, 'c3.db')
    resetDbForTests()
    resetStoreForTests()
    vi.mocked(getForgePrStatus).mockReset()
  })

  afterEach(() => {
    resetDbForTests()
    delete process.env.C3_DB_PATH
    rmSync(dir, { recursive: true, force: true })
  })

  const routeUrl = (token: string): URL =>
    new URL(`http://127.0.0.1:${port}${AUTOMATION_MCP_PATH}?token=${token}`)

  const tokenOf = (url: string): string => new URL(url).searchParams.get('token') ?? ''

  const jsonHeaders = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  }

  it('rejects an unknown token with 404', async () => {
    const r = await fetch(routeUrl('nope'), {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    })
    expect(r.status).toBe(404)
  })

  it('binds a c3 http descriptor with the full enabledTools list', () => {
    const binding = automationMcp.bind({ workspacePath: proj, executionId: 'exec-1' })
    try {
      expect(binding.servers.c3.type).toBe('http')
      expect(binding.servers.c3.url).toContain('token=')
      expect(binding.servers.c3.enabledTools).toEqual(AUTOMATION_C3_TOOL_NAMES)
    } finally {
      binding.dispose()
    }
  })

  it('lists ALL automation c3 tools and calls one via a real streamable-HTTP client', async () => {
    const binding = automationMcp.bind({ workspacePath: proj, executionId: 'exec-1' })
    const client = new Client({ name: 'test', version: '1.0.0' })
    const transport = new StreamableHTTPClientTransport(routeUrl(tokenOf(binding.servers.c3.url)))
    await client.connect(transport)
    try {
      const listed = await client.listTools()
      expect(listed.tools.map((t) => t.name).sort()).toEqual([...AUTOMATION_C3_TOOL_NAMES].sort())

      const find = await client.callTool({ name: 'find_intents', arguments: {} })
      expect(find.isError).toBeFalsy()
      expect(JSON.stringify(find.content)).toContain('未找到匹配的意图')
    } finally {
      await client.close()
      binding.dispose()
    }
  })

  it('sync_intent_pr_status persists the forge terminal state via the shared core', async () => {
    // A `reviewing` row + forge verdict `merged` → the row lands `merged` and the
    // intent log records `pr_merged`; the model supplied no status value, only the
    // intent id (the same seam `pr-status-sync.test.ts` pins).
    vi.mocked(getForgePrStatus).mockResolvedValue({ ok: true, status: 'merged' })
    const [intent] = insertIntents(proj, [
      { title: 'Merged', shortEnTitle: 'merged', content: '', priority: 'P1' },
    ])
    upsertIntentPr({
      intentId: intent.id,
      number: '9',
      status: 'reviewing',
      forge: 'github',
      repo: 'acme/demo',
    })

    const binding = automationMcp.bind({ workspacePath: proj, executionId: 'exec-1' })
    const client = new Client({ name: 'test', version: '1.0.0' })
    const transport = new StreamableHTTPClientTransport(routeUrl(tokenOf(binding.servers.c3.url)))
    await client.connect(transport)
    try {
      const res = await client.callTool({
        name: 'sync_intent_pr_status',
        arguments: { intentId: intent.id },
      })
      expect(res.isError).toBeFalsy()
      const payload = JSON.parse((res.content as Array<{ text: string }>)[0].text)
      expect(payload).toMatchObject({ ok: true, changed: true, prStatus: 'merged' })
      expect(getIntent(intent.id)?.prs[0].status).toBe('merged')
      expect(listIntentLogs(intent.id).some((l) => l.operationType === 'pr_merged')).toBe(true)
      expect(vi.mocked(getForgePrStatus)).toHaveBeenCalled()
    } finally {
      await client.close()
      binding.dispose()
    }
  })

  it('sync_intent_pr_status leaves the row untouched while the forge still says open', async () => {
    // An open PR normalizes to `reviewing` (see normalizeGithubPrStatus); forge
    // still open ⇒ no terminal state, the row must stay `reviewing`.
    vi.mocked(getForgePrStatus).mockResolvedValue({ ok: true, status: 'reviewing' })
    const [intent] = insertIntents(proj, [
      { title: 'Open', shortEnTitle: 'open', content: '', priority: 'P1' },
    ])
    upsertIntentPr({
      intentId: intent.id,
      number: '10',
      status: 'reviewing',
      forge: 'github',
      repo: 'acme/demo',
    })

    const binding = automationMcp.bind({ workspacePath: proj, executionId: 'exec-1' })
    const client = new Client({ name: 'test', version: '1.0.0' })
    const transport = new StreamableHTTPClientTransport(routeUrl(tokenOf(binding.servers.c3.url)))
    await client.connect(transport)
    try {
      const res = await client.callTool({
        name: 'sync_intent_pr_status',
        arguments: { intentId: intent.id },
      })
      expect(res.isError).toBeFalsy()
      const payload = JSON.parse((res.content as Array<{ text: string }>)[0].text)
      expect(payload).toMatchObject({ ok: true, changed: false })
      expect(getIntent(intent.id)?.prs[0].status).toBe('reviewing')
      expect(listIntentLogs(intent.id).some((l) => l.operationType === 'pr_merged')).toBe(false)
    } finally {
      await client.close()
      binding.dispose()
    }
  })

  it('dispose evicts the token: the same URL 404s afterward', async () => {
    const binding = automationMcp.bind({ workspacePath: proj, executionId: 'exec-1' })
    const token = tokenOf(binding.servers.c3.url)
    const client = new Client({ name: 'test', version: '1.0.0' })
    await client.connect(new StreamableHTTPClientTransport(routeUrl(token)))
    const listed = await client.listTools()
    expect(listed.tools).toHaveLength(AUTOMATION_C3_TOOL_NAMES.length)
    await client.close()

    binding.dispose()
    // Idempotent: a second dispose is a no-op, not a throw.
    expect(() => binding.dispose()).not.toThrow()

    const r = await fetch(routeUrl(token), {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    })
    expect(r.status).toBe(404)
  })
})
