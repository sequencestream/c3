/**
 * The public `/mcp/<api-key>` route. Covers the authorization matrix, the
 * per-key tool subset (both in `tools/list` and in direct un-granted calls), the
 * scope pinning that stops a live session being walked into another key or a
 * stale scope, the discontinued query entry point, and the revocation teardown —
 * all with injected auth/catalog, so this exercises the transport decision logic
 * without the key store or the intent database.
 *
 * The end-to-end pass (real key store, real catalog, real MCP client) lives in
 * `e2e.test.ts`.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { serve, type ServerType } from '@hono/node-server'
import { Hono } from 'hono'
import { z } from 'zod'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import {
  createExternalMcp,
  EXTERNAL_MCP_PATH_PREFIX,
  keySegment,
  type ExternalMcpDeps,
  type ServedExternalMcp,
} from './index.js'
import type { AuthenticatedMcpApiKey } from '../../kernel/config/mcp-api-keys.js'
import type { ExternalMcpTool } from '../../features/external-mcp/tools.js'
import type { ExternalMcpToolName } from '@ccc/shared/protocol'

/** Keys keyed by the path segment they authenticate with. */
const KEYS = new Map<string, AuthenticatedMcpApiKey>([
  [
    'full',
    { id: 'key-a', workspace: '/ws/alpha', tools: ['find_intents', 'view_intent', 'save_intents'] },
  ],
  ['readonly', { id: 'key-b', workspace: '/ws/alpha', tools: ['find_intents'] }],
  ['stale', { id: 'key-c', workspace: '/ws/gone', tools: ['find_intents'] }],
  ['empty', { id: 'key-d', workspace: '/ws/alpha', tools: [] }],
])

/** Only `/ws/alpha` is registered; `/ws/gone` was removed. */
const REGISTERED = new Set(['/ws/alpha'])

const calls: { name: string; workspacePath: string; keyId: string }[] = []

/** A small catalog mirroring the real read/write split, enough to assert subsets. */
function fakeCatalog(scope: { workspacePath: string; keyId: string }): ExternalMcpTool[] {
  const bound = (name: ExternalMcpToolName, access: 'read' | 'write'): ExternalMcpTool => ({
    name,
    access,
    description: name,
    inputSchema: { q: z.string().optional() },
    handler: () => {
      calls.push({ name, ...scope })
      return { content: [{ type: 'text' as const, text: `${name}@${scope.workspacePath}` }] }
    },
  })
  return [
    bound('find_intents', 'read'),
    bound('view_intent', 'read'),
    bound('save_intents', 'write'),
  ]
}

const deps: ExternalMcpDeps = {
  authenticate: async (key) => KEYS.get(key) ?? null,
  resolveRegisteredWorkspace: (p) => (REGISTERED.has(p) ? p : null),
  buildCatalog: fakeCatalog,
}

let server: ServerType
let port: number
let route: ServedExternalMcp

beforeAll(async () => {
  route = createExternalMcp(deps)
  const app = new Hono()
  app.all(EXTERNAL_MCP_PATH_PREFIX, (c) => route.handler(c))
  app.all(`${EXTERNAL_MCP_PATH_PREFIX}/*`, (c) => route.handler(c))
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

afterEach(() => {
  calls.length = 0
})

function url(key: string): string {
  return `http://127.0.0.1:${port}${EXTERNAL_MCP_PATH_PREFIX}/${encodeURIComponent(key)}`
}

/** A well-formed `initialize` POST — enough to reach the transport when authorized. */
function initBody(): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test', version: '1.0.0' },
    },
  })
}

async function post(key: string, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(url(key), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...headers,
    },
    body: initBody(),
  })
}

describe('keySegment', () => {
  it.each([
    ['a bare prefix', '/mcp', null],
    ['a trailing-slash-only path', '/mcp/', null],
    ['a normal key', '/mcp/abc', 'abc'],
    ['a percent-encoded key', `/mcp/${encodeURIComponent('c3k_x_y')}`, 'c3k_x_y'],
    ['an extra segment', '/mcp/abc/extra', null],
    ['a malformed percent escape', '/mcp/%zz', null],
    ['an unrelated path', '/other/mcp/x', null],
  ])('parses %s as %s', (_label, path, expected) => {
    expect(keySegment(path)).toBe(expected)
  })
})

describe('address + authorization matrix', () => {
  it.each([
    ['a bare /mcp', '/mcp', 401],
    ['an empty segment', '/mcp/', 401],
    ['a key that matches nothing', '/mcp/nope', 401],
  ])('rejects %s with 401', async (_label, path, expected) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: initBody(),
    })
    expect(res.status).toBe(expected)
  })

  it('answers every 401 cause with the same body, so key existence cannot be probed', async () => {
    const unknown = await (await post('nope')).text()
    const bare = await (
      await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST', body: initBody() })
    ).text()
    expect(unknown).toBe(bare)
  })

  it('answers the retired /mcp/v1 entry point with an explicit discontinued response', async () => {
    const res = await post('v1')
    expect(res.status).toBe(410)
    await expect(res.json()).resolves.toMatchObject({ error: 'discontinued' })
  })

  it('refuses a key whose bound workspace is no longer registered with 403', async () => {
    expect((await post('stale')).status).toBe(403)
  })

  it('accepts a valid key and stands up a session', async () => {
    expect((await post('readonly')).status).toBe(200)
  })
})

describe('per-key tool scope', () => {
  it('advertises exactly the granted subset in tools/list', async () => {
    const client = new Client({ name: 'test', version: '1.0.0' })
    await client.connect(new StreamableHTTPClientTransport(new URL(url('full'))))
    try {
      const names = (await client.listTools()).tools.map((t) => t.name).sort()
      expect(names).toEqual(['find_intents', 'save_intents', 'view_intent'])
    } finally {
      await client.close()
    }
  })

  it('does not advertise — and refuses to run — an un-granted tool', async () => {
    const client = new Client({ name: 'test', version: '1.0.0' })
    await client.connect(new StreamableHTTPClientTransport(new URL(url('readonly'))))
    try {
      const names = (await client.listTools()).tools.map((t) => t.name)
      expect(names).toEqual(['find_intents'])

      // Bypassing discovery straight to the call answers a stable forbidden error.
      const res = await client.callTool({ name: 'save_intents', arguments: {} })
      expect(res.isError).toBe(true)
      expect(JSON.stringify(res.content)).toContain('forbidden')
      expect(calls).toEqual([])
    } finally {
      await client.close()
    }
  })

  it('runs a granted tool bound to the key’s workspace', async () => {
    const client = new Client({ name: 'test', version: '1.0.0' })
    await client.connect(new StreamableHTTPClientTransport(new URL(url('full'))))
    try {
      const res = await client.callTool({ name: 'find_intents', arguments: {} })
      expect(res.isError).toBeFalsy()
      expect(JSON.stringify(res.content)).toContain('find_intents@/ws/alpha')
      expect(calls).toEqual([
        {
          name: 'find_intents',
          workspacePath: '/ws/alpha',
          keyId: 'key-a',
          tools: ['find_intents', 'view_intent', 'save_intents'],
        },
      ])
    } finally {
      await client.close()
    }
  })

  it('treats an empty scope as "nothing" — the session exists but offers no tool', async () => {
    const client = new Client({ name: 'test', version: '1.0.0' })
    await client.connect(new StreamableHTTPClientTransport(new URL(url('empty'))))
    try {
      expect((await client.listTools()).tools).toEqual([])
      const res = await client.callTool({ name: 'find_intents', arguments: {} })
      expect(res.isError).toBe(true)
      expect(JSON.stringify(res.content)).toContain('forbidden')
    } finally {
      await client.close()
    }
  })
})

describe('session scope', () => {
  it('pins a session to the key it was initialized with; another key is refused', async () => {
    const client = new Client({ name: 'test', version: '1.0.0' })
    const transport = new StreamableHTTPClientTransport(new URL(url('full')))
    await client.connect(transport)
    const sessionId = transport.sessionId
    expect(sessionId).toBeTruthy()
    try {
      const walked = await fetch(url('readonly'), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'mcp-session-id': sessionId!,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
      })
      expect(walked.status).toBe(403)

      const same = await fetch(url('full'), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'mcp-session-id': sessionId!,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} }),
      })
      expect(same.status).toBe(200)
    } finally {
      await client.close()
    }
  })

  it('refuses an unknown session id', async () => {
    const res = await fetch(url('full'), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-session-id': 'not-a-session',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/list', params: {} }),
    })
    expect(res.status).toBe(404)
  })

  it('does not leak a server when a non-initialize request arrives without a session', async () => {
    const before = route.sessionCount()
    const res = await fetch(url('full'), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'tools/list', params: {} }),
    })
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(route.sessionCount()).toBe(before)
  })
})

describe('revocation and re-scoping', () => {
  it('tears down the revoked key’s live sessions and leaves other keys alone', async () => {
    const victim = new Client({ name: 'victim', version: '1.0.0' })
    const victimTransport = new StreamableHTTPClientTransport(new URL(url('full')))
    await victim.connect(victimTransport)

    const bystander = new Client({ name: 'bystander', version: '1.0.0' })
    const bystanderTransport = new StreamableHTTPClientTransport(new URL(url('readonly')))
    await bystander.connect(bystanderTransport)

    const victimSession = victimTransport.sessionId!
    route.closeSessionsForKey('key-a')

    const res = await fetch(url('full'), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-session-id': victimSession,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 6, method: 'tools/list', params: {} }),
    })
    expect(res.status).toBe(404)

    const listed = await bystander.listTools()
    expect(listed.tools.map((t) => t.name)).toEqual(['find_intents'])

    await bystander.close()
    await victimTransport.terminateSession().catch(() => undefined)
  })

  it('is a no-op for a key with no live sessions', () => {
    expect(() => route.closeSessionsForKey('key-with-nothing')).not.toThrow()
  })
})
