/**
 * Advisor MCP HTTP route + the vendor-neutrality contract it carries.
 *
 * Beyond the plumbing (loopback guard, unknown-token 404, dispose eviction),
 * this file asserts the two properties the design leans on:
 *
 *  - **Both vendors get the same group.** Claude and Codex read this ONE route,
 *    so the contract is that the descriptor's `enabledTools` names every tool the
 *    server actually registered. Codex marks each enabled tool
 *    required/approved, so a name missing from that list would be silently
 *    disabled for Codex alone — the exact per-vendor drift ADR-0011 forbids.
 *  - **Two environment traps stay closed.** A host `HTTP_PROXY` with no
 *    `NO_PROXY` makes the loopback MCP call 502 and the tools vanish SILENTLY;
 *    and an unknown / aliased Codex model falls back to metadata that routes MCP
 *    calls through the code-execution sandbox, where every c3 tool reports an
 *    unsupported call. Both have bitten this codebase before, so both are
 *    regression-tested here rather than rediscovered.
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
}))

import { serve, type ServerType } from '@hono/node-server'
import { Hono } from 'hono'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { resetDbForTests } from '../../kernel/infra/db.js'
import { resetStoreForTests } from '../../features/intents/store.js'
import {
  ADVISOR_C3_TOOL_NAMES,
  ADVISOR_SHARED_WITH_AUTOMATION_TOOL_NAMES,
  type AdvisorToolDeps,
} from '../../features/intents/advisor-tools.js'
import { AUTOMATION_C3_TOOL_NAMES } from '../../features/automations/c3-tools.js'
import { mcpServersEnableSaveIntents } from '../../kernel/agent/adapters/codex/driver.js'
import { withLoopbackNoProxy } from '../../kernel/infra/no-proxy.js'
import { createAdvisorMcp, ADVISOR_MCP_PATH, isLoopback, type ServedAdvisorMcp } from './index.js'

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

describe('advisor MCP HTTP route', () => {
  const proj = '/abs/advisor-mcp-proj'
  const deps: AdvisorToolDeps = {
    broadcastIntents: () => {},
    broadcastWaitUserEvents: () => {},
    launchRun: async () => {},
    normalizeEvent: () => ({ ok: false, reason: 'not wired in this test' }),
    publishEvent: () => {},
    publishStatusChanged: () => {},
    requestWriteApproval: async () => false,
  }
  const binding = {
    workspacePath: proj,
    intentId: 'intent-1',
    chainDepth: 0,
    sessionId: 'advisor-1',
  }

  let server: ServerType
  let port: number
  let advisorMcp: ServedAdvisorMcp
  let dir: string

  beforeAll(async () => {
    advisorMcp = createAdvisorMcp('http://127.0.0.1', deps)
    const app = new Hono()
    app.all(ADVISOR_MCP_PATH, (c) => advisorMcp.handler(c))
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
    dir = mkdtempSync(join(tmpdir(), 'c3-advisor-mcp-'))
    process.env.C3_DB_PATH = join(dir, 'c3.db')
    resetDbForTests()
    resetStoreForTests()
  })

  afterEach(() => {
    resetDbForTests()
    delete process.env.C3_DB_PATH
    rmSync(dir, { recursive: true, force: true })
  })

  const routeUrl = (token: string): URL =>
    new URL(`http://127.0.0.1:${port}${ADVISOR_MCP_PATH}?token=${token}`)

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

  it('binds a c3 http descriptor advertising EVERY advisor tool', () => {
    const bound = advisorMcp.bind(binding)
    try {
      expect(bound.servers.c3.type).toBe('http')
      expect(bound.servers.c3.url).toContain('token=')
      expect(bound.servers.c3.enabledTools).toEqual(ADVISOR_C3_TOOL_NAMES)
    } finally {
      bound.dispose()
    }
  })

  it('a REAL client sees the same group both vendors would — names and schemas', async () => {
    const bound = advisorMcp.bind(binding)
    const client = new Client({ name: 'test', version: '1.0.0' })
    await client.connect(new StreamableHTTPClientTransport(routeUrl(tokenOf(bound.servers.c3.url))))
    try {
      const listed = await client.listTools()
      // What the server registered === what the descriptor advertises. Codex
      // enables exactly the descriptor's names, Claude sees the listing — so
      // this equality IS the two vendors agreeing.
      expect(listed.tools.map((t) => t.name).sort()).toEqual([...ADVISOR_C3_TOOL_NAMES].sort())
      expect(bound.servers.c3.enabledTools).toEqual(listed.tools.map((t) => t.name))
      // No tool takes a workspace or intent override on the wire.
      for (const t of listed.tools) {
        const props = Object.keys(
          (t.inputSchema as { properties?: Record<string, unknown> }).properties ?? {},
        )
        expect(props).not.toContain('workspacePath')
        expect(props).not.toContain('intentId')
      }
    } finally {
      await client.close()
      bound.dispose()
    }
  })

  it('calls a tool end-to-end and gets the structured refusal for an unknown intent', async () => {
    const bound = advisorMcp.bind(binding)
    const client = new Client({ name: 'test', version: '1.0.0' })
    await client.connect(new StreamableHTTPClientTransport(routeUrl(tokenOf(bound.servers.c3.url))))
    try {
      const r = await client.callTool({ name: 'list_sessions', arguments: {} })
      expect(r.isError).toBe(true)
      expect(JSON.stringify(r.content)).toContain('intent_not_found')
    } finally {
      await client.close()
      bound.dispose()
    }
  })

  it('dispose evicts the token: the same URL 404s afterward', async () => {
    const bound = advisorMcp.bind(binding)
    const token = tokenOf(bound.servers.c3.url)
    const client = new Client({ name: 'test', version: '1.0.0' })
    await client.connect(new StreamableHTTPClientTransport(routeUrl(token)))
    expect((await client.listTools()).tools).toHaveLength(ADVISOR_C3_TOOL_NAMES.length)
    await client.close()

    bound.dispose()
    // Idempotent: a second dispose is a no-op, not a throw.
    expect(() => bound.dispose()).not.toThrow()

    const r = await fetch(routeUrl(token), {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    })
    expect(r.status).toBe(404)
  })

  it('keeps the advisor group OUT of the ordinary automation tool set, beyond the one shared trigger', () => {
    for (const name of ADVISOR_C3_TOOL_NAMES) {
      if (ADVISOR_SHARED_WITH_AUTOMATION_TOOL_NAMES.includes(name)) continue
      expect(AUTOMATION_C3_TOOL_NAMES).not.toContain(name)
    }
    for (const name of ADVISOR_SHARED_WITH_AUTOMATION_TOOL_NAMES) {
      expect(AUTOMATION_C3_TOOL_NAMES).toContain(name)
    }
  })
})

// ── Environment traps that have silently broken loopback MCP before ──

describe('regression — host HTTP_PROXY without NO_PROXY', () => {
  it('adds the loopback hosts so the advisor MCP call is never proxied', () => {
    // Without this the child resolves 127.0.0.1 through the host proxy, the MCP
    // handshake 502s, and EVERY c3 tool goes missing with no error surfaced.
    const noProxy = withLoopbackNoProxy(undefined)
    expect(noProxy).toContain('127.0.0.1')
    expect(noProxy).toContain('localhost')
    expect(noProxy).toContain('::1')
  })

  it('preserves an existing NO_PROXY and stays idempotent', () => {
    const once = withLoopbackNoProxy('example.com')
    expect(once).toContain('example.com')
    expect(withLoopbackNoProxy(once)).toBe(once)
  })
})

describe('regression — codex unknown model falls back to code-execution metadata', () => {
  it('forces the advisor group through the direct MCP tool-call path', () => {
    // An unknown / aliased model pulls up codex's js_repl surface, where a c3 MCP
    // call comes back as an unsupported call. Recognising the advisor group here
    // is what turns js_repl off for that run.
    expect(
      mcpServersEnableSaveIntents({
        c3: {
          type: 'http',
          url: 'http://127.0.0.1/advisor',
          enabledTools: [...ADVISOR_C3_TOOL_NAMES],
        },
      }),
    ).toBe(true)
  })

  it('still recognises the intent comm profile, and still ignores unrelated profiles', () => {
    expect(
      mcpServersEnableSaveIntents({
        c3: { type: 'http', url: 'http://127.0.0.1/intent', enabledTools: ['save_intents'] },
      }),
    ).toBe(true)
    expect(
      mcpServersEnableSaveIntents({
        c3: { type: 'http', url: 'http://127.0.0.1/spec', enabledTools: ['find_intents'] },
      }),
    ).toBe(false)
  })
})
