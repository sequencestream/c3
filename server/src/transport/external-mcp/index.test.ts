/**
 * The public `/mcp/v1` route. Covers the authorization matrix, the scope pinning
 * that stops a live MCP session being walked into another workspace, and the
 * revocation teardown — all with injected auth/tools, so this exercises the
 * transport decision logic without the key store or the intent database.
 *
 * The end-to-end pass (real key store, real tool set, real MCP client, non-loopback
 * peer) lives in `e2e.test.ts`.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { serve, type ServerType } from '@hono/node-server'
import { Hono } from 'hono'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import {
  createExternalMcp,
  EXTERNAL_MCP_PATH,
  type ExternalMcpDeps,
  type ServedExternalMcp,
} from './index.js'
import type { AuthenticatedMcpApiKey } from '../../kernel/config/mcp-api-keys.js'
import type { ExternalMcpTool } from '../../features/external-mcp/tools.js'

/** Two keys with different grants, plus a revocable one, keyed by plaintext. */
const KEYS = new Map<string, AuthenticatedMcpApiKey>([
  ['good', { id: 'key-a', workspaces: ['/ws/alpha', '/ws/beta'] }],
  ['narrow', { id: 'key-b', workspaces: ['/ws/alpha'] }],
  ['stale', { id: 'key-c', workspaces: ['/ws/gone'] }],
  ['empty', { id: 'key-d', workspaces: [] }],
])

/** Only `/ws/alpha` and `/ws/beta` are registered; `/ws/gone` was removed. */
const REGISTERED = new Set(['/ws/alpha', '/ws/beta'])

const calls: { name: string; workspacePath: string; keyId: string }[] = []

function fakeTools(scope: { workspacePath: string; keyId: string }): ExternalMcpTool[] {
  return [
    {
      name: 'find_intents',
      description: 'find',
      inputSchema: {},
      handler: () => {
        calls.push({ name: 'find_intents', ...scope })
        return { content: [{ type: 'text' as const, text: `FOUND@${scope.workspacePath}` }] }
      },
    },
  ]
}

const deps: ExternalMcpDeps = {
  authenticate: async (token) => KEYS.get(token) ?? null,
  // A path-shaped canonicalizer: absolute only, trailing separators collapsed.
  canonicalizeWorkspace: (raw) => {
    const t = raw.trim()
    if (!t.startsWith('/')) return null
    return t.length > 1 ? t.replace(/\/+$/, '') : t
  },
  resolveRegisteredWorkspace: (p) => (REGISTERED.has(p) ? p : null),
  buildTools: fakeTools,
}

let server: ServerType
let port: number
let route: ServedExternalMcp

beforeAll(async () => {
  route = createExternalMcp(deps)
  const app = new Hono()
  app.all(EXTERNAL_MCP_PATH, (c) => route.handler(c))
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

function url(query: string): string {
  return `http://127.0.0.1:${port}${EXTERNAL_MCP_PATH}${query}`
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

async function post(query: string, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(url(query), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...headers,
    },
    body: initBody(),
  })
}

describe('authorization matrix', () => {
  it.each([
    ['no token at all', '?workspace=/ws/alpha'],
    ['an empty token', '?token=&workspace=/ws/alpha'],
    ['a token that matches no key', '?token=nope&workspace=/ws/alpha'],
  ])('rejects %s with 401', async (_label, query) => {
    const res = await post(query)
    expect(res.status).toBe(401)
    await expect(res.json()).resolves.toEqual({ error: 'unauthorized' })
  })

  it('answers every 401 cause with the same body, so key existence cannot be probed', async () => {
    const unknown = await (await post('?token=nope&workspace=/ws/alpha')).text()
    const missing = await (await post('?workspace=/ws/alpha')).text()
    expect(unknown).toBe(missing)
  })

  it.each([
    ['a missing workspace parameter', '?token=good'],
    ['an empty workspace parameter', '?token=good&workspace='],
    ['a relative workspace path', '?token=good&workspace=relative/dir'],
  ])('rejects %s with 400', async (_label, query) => {
    expect((await post(query)).status).toBe(400)
  })

  it('checks the credential BEFORE the workspace parameter', async () => {
    // A bad token AND a bad workspace ⇒ 401, never 400: an unauthenticated caller
    // learns nothing about parameter handling.
    expect((await post('?token=nope&workspace=relative')).status).toBe(401)
  })

  it('rejects a workspace outside the key’s grant with 403', async () => {
    expect((await post('?token=narrow&workspace=/ws/beta')).status).toBe(403)
  })

  it('treats an empty grant as "nothing", never as a wildcard', async () => {
    expect((await post('?token=empty&workspace=/ws/alpha')).status).toBe(403)
  })

  it('answers 403 — not 404 — for an unregistered workspace the key cannot reach', async () => {
    // Otherwise the status code itself would enumerate which paths exist.
    expect((await post('?token=narrow&workspace=/ws/nowhere')).status).toBe(403)
  })

  it('answers 404 for a granted workspace c3 no longer has', async () => {
    expect((await post('?token=stale&workspace=/ws/gone')).status).toBe(404)
  })

  it('accepts an equivalent spelling of a granted workspace', async () => {
    const res = await post('?token=good&workspace=/ws/alpha/')
    expect(res.status).toBe(200)
  })
})

describe('session scope', () => {
  it('pins a session to the key and workspace it was initialized with', async () => {
    const client = new Client({ name: 'test', version: '1.0.0' })
    const transport = new StreamableHTTPClientTransport(
      new URL(url('?token=good&workspace=/ws/alpha')),
    )
    await client.connect(transport)
    const sessionId = transport.sessionId
    expect(sessionId).toBeTruthy()
    try {
      // Same session id, different workspace in the query ⇒ refused, not re-scoped.
      const walked = await fetch(url('?token=good&workspace=/ws/beta'), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'mcp-session-id': sessionId!,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
      })
      expect(walked.status).toBe(403)

      // Same session id under a DIFFERENT key ⇒ also refused.
      const otherKey = await fetch(url('?token=narrow&workspace=/ws/alpha'), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'mcp-session-id': sessionId!,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} }),
      })
      expect(otherKey.status).toBe(403)

      // The original scope still works, and the tool sees the pinned workspace.
      const res = await client.callTool({ name: 'find_intents', arguments: {} })
      expect(JSON.stringify(res.content)).toContain('FOUND@/ws/alpha')
      expect(calls).toEqual([{ name: 'find_intents', workspacePath: '/ws/alpha', keyId: 'key-a' }])
    } finally {
      await client.close()
    }
  })

  it('rejects an unknown session id', async () => {
    const res = await fetch(url('?token=good&workspace=/ws/alpha'), {
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
    const res = await fetch(url('?token=good&workspace=/ws/alpha'), {
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

describe('revocation', () => {
  it('tears down the revoked key’s live sessions and leaves other keys alone', async () => {
    const victim = new Client({ name: 'victim', version: '1.0.0' })
    const victimTransport = new StreamableHTTPClientTransport(
      new URL(url('?token=good&workspace=/ws/alpha')),
    )
    await victim.connect(victimTransport)

    const bystander = new Client({ name: 'bystander', version: '1.0.0' })
    const bystanderTransport = new StreamableHTTPClientTransport(
      new URL(url('?token=narrow&workspace=/ws/alpha')),
    )
    await bystander.connect(bystanderTransport)

    const victimSession = victimTransport.sessionId!
    route.closeSessionsForKey('key-a')

    // The revoked key's already-open session no longer resolves…
    const res = await fetch(url('?token=good&workspace=/ws/alpha'), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-session-id': victimSession,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 6, method: 'tools/list', params: {} }),
    })
    expect(res.status).toBe(404)

    // …while an unrelated key's session keeps working.
    const listed = await bystander.listTools()
    expect(listed.tools.map((t) => t.name)).toEqual(['find_intents'])

    await bystander.close()
    await victimTransport.terminateSession().catch(() => undefined)
  })

  it('is a no-op for a key with no live sessions', () => {
    expect(() => route.closeSessionsForKey('key-with-nothing')).not.toThrow()
  })
})
