/**
 * The public `POST /mcp` route. Covers the address (nothing may follow `/mcp`),
 * the bearer-only credential rule, workspace selection by header, the four-part
 * session pinning, the per-call re-authorization a write override goes through,
 * the write-audit contract, the trusted-local exception and the
 * unconfigured-exposure refusal — all with an injected authorization gate, so
 * this exercises the transport's decisions without the key store or the policy
 * database.
 *
 * The gate itself is `features/auth/authorization.test.ts`; the end-to-end pass
 * (real key store, real catalog, real MCP client) is `e2e.test.ts`.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { serve, type ServerType } from '@hono/node-server'
import { Hono } from 'hono'
import { z } from 'zod'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import {
  createExternalMcp,
  EXTERNAL_MCP_PATH,
  isLoopbackAddress,
  readCredential,
  readWorkspaceHeader,
  type ExternalMcpDeps,
  type ServedExternalMcp,
} from './index.js'
import type {
  AuthorizeResult,
  EffectiveScope,
  ExternalMcpPrincipal,
} from '../../features/auth/authorization.js'
import type { ExternalMcpWriteAuditInput } from '../../features/external-mcp/audit-store.js'
import type { ExternalMcpTool } from '../../features/external-mcp/tools.js'
import type { ExternalMcpToolName } from '@ccc/shared/protocol'

/** Everything the injected gate consults, mutable so a test can move one input. */
const world = {
  epoch: 1,
  peer: '127.0.0.1' as string | undefined,
  trustedLocal: false,
  exposedWithoutAdmin: false,
  validOwners: new Set(['alice', 'bob', 'local']),
  ownerWorkspaces: new Map<string, string[]>([
    ['alice', ['alpha']],
    ['bob', ['beta']],
    ['local', ['alpha', 'beta']],
  ]),
  catalog: new Set(['find_intents', 'view_intent', 'save_intents']),
  keys: new Map<string, ExternalMcpPrincipal>(),
}

function resetWorld(): void {
  world.epoch = 1
  world.peer = '127.0.0.1'
  world.trustedLocal = false
  world.exposedWithoutAdmin = false
  world.validOwners = new Set(['alice', 'bob', 'local'])
  world.ownerWorkspaces = new Map([
    ['alice', ['alpha']],
    ['bob', ['beta']],
    ['local', ['alpha', 'beta']],
  ])
  world.keys = new Map<string, ExternalMcpPrincipal>([
    [
      'c3k_full',
      {
        keyId: 'key-a',
        ownerSubject: 'alice',
        secretVersion: 1,
        tools: ['find_intents', 'view_intent', 'save_intents'],
      },
    ],
    [
      'c3k_read',
      { keyId: 'key-b', ownerSubject: 'alice', secretVersion: 1, tools: ['find_intents'] },
    ],
    [
      'c3k_beta',
      { keyId: 'key-c', ownerSubject: 'bob', secretVersion: 1, tools: ['find_intents'] },
    ],
    ['c3k_empty', { keyId: 'key-d', ownerSubject: 'alice', secretVersion: 1, tools: [] }],
  ])
}

const calls: { name: string; workspacePath: string; keyId: string }[] = []
/** Every audit row the route asked for, in order. */
const audits: ExternalMcpWriteAuditInput[] = []
/** Flip to make the audit store refuse — the fail-open path. */
let auditFails = false
/** Args that make the fake write tool answer with an error / throw. */
const FAIL_ARG = 'make-it-fail'
const THROW_ARG = 'make-it-throw'
/** An id the fake write tool's `validate` refuses, standing in for a foreign id. */
const FOREIGN_ID = 'foreign-id'

/** The same three-layer intersection the real gate performs, over `world`. */
function authorize(
  auth: ExternalMcpPrincipal,
  workspaceName: string,
  toolName: string | null,
): AuthorizeResult {
  if (!world.validOwners.has(auth.ownerSubject)) return { ok: false, reason: 'owner' }
  const allowed = world.ownerWorkspaces.get(auth.ownerSubject) ?? []
  if (!workspaceName.trim() || !allowed.includes(workspaceName)) {
    return { ok: false, reason: 'workspace' }
  }
  const tools = auth.tools.filter((t) => world.catalog.has(t))
  if (toolName !== null && !tools.includes(toolName)) return { ok: false, reason: 'tool' }
  const scope: EffectiveScope = Object.freeze({
    keyId: auth.keyId,
    ownerSubject: auth.ownerSubject,
    secretVersion: auth.secretVersion,
    policyEpoch: world.epoch,
    workspaceName,
    workspacePath: `/ws/${workspaceName}`,
    tools: Object.freeze(tools),
  })
  return { ok: true, scope }
}

/**
 * A small catalog mirroring the real read/write split, enough to assert subsets.
 * It closes over NO scope — every handler is told which scope the gate produced
 * for the call, which is the property that lets a write target another
 * workspace without the session moving.
 */
function fakeCatalog(): ExternalMcpTool[] {
  const bound = (name: ExternalMcpToolName, access: 'read' | 'write'): ExternalMcpTool => ({
    name,
    access,
    description: name,
    inputSchema:
      access === 'write'
        ? {
            q: z.string().optional(),
            id: z.string().optional(),
            workspaceName: z.string().optional(),
          }
        : { q: z.string().optional() },
    validate:
      access === 'write'
        ? (args) => ((args as { id?: string }).id === FOREIGN_ID ? '未找到 id(本项目)。' : null)
        : undefined,
    handler: (args, scope) => {
      calls.push({ name, workspacePath: scope.workspacePath, keyId: scope.keyId })
      const q = (args as { q?: string }).q
      if (q === THROW_ARG) throw new Error('handler blew up')
      return {
        content: [{ type: 'text' as const, text: `${name}@${scope.workspacePath}` }],
        ...(q === FAIL_ARG ? { isError: true } : {}),
      }
    },
  })
  return [
    bound('find_intents', 'read'),
    bound('view_intent', 'read'),
    bound('save_intents', 'write'),
  ]
}

const deps: ExternalMcpDeps = {
  authenticate: async (key) => world.keys.get(key) ?? null,
  trustedLocalPrincipal: () =>
    world.trustedLocal
      ? { keyId: 'local', ownerSubject: 'local', secretVersion: 0, tools: [...world.catalog] }
      : null,
  authorize,
  exposedWithoutAdmin: () => world.exposedWithoutAdmin,
  remoteAddress: () => world.peer,
  buildCatalog: fakeCatalog,
  recordWriteAudit: (entry) => {
    if (auditFails) throw new Error('audit store unavailable')
    audits.push(entry)
  },
  now: () => 1_700_000_000_000,
}

let server: ServerType
let port: number
let route: ServedExternalMcp

beforeAll(async () => {
  route = createExternalMcp(deps)
  const app = new Hono()
  app.all(EXTERNAL_MCP_PATH, (c) => route.handler(c))
  app.all(`${EXTERNAL_MCP_PATH}/*`, (c) => route.handler(c))
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
  resetWorld()
  auditFails = false
})

afterEach(() => {
  calls.length = 0
  audits.length = 0
})

function endpoint(): string {
  return `http://127.0.0.1:${port}${EXTERNAL_MCP_PATH}`
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

function rpcBody(id: number, method: string): string {
  return JSON.stringify({ jsonrpc: '2.0', id, method, params: {} })
}

async function post(
  headers: Record<string, string> = {},
  body: string = initBody(),
  path: string = EXTERNAL_MCP_PATH,
): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...headers,
    },
    body,
  })
}

/** The headers a configured client sends on EVERY request. */
function clientHeaders(key: string, workspace = 'alpha'): Record<string, string> {
  return { authorization: `Bearer ${key}`, 'x-c3-workspace': workspace }
}

/** Connect a real MCP client the way Claude Code / Cursor do: static headers. */
async function connect(
  key: string,
  workspace = 'alpha',
): Promise<{ client: Client; transport: StreamableHTTPClientTransport }> {
  const client = new Client({ name: 'test', version: '1.0.0' })
  const transport = new StreamableHTTPClientTransport(new URL(endpoint()), {
    requestInit: { headers: clientHeaders(key, workspace) },
  })
  await client.connect(transport)
  return { client, transport }
}

/**
 * Initialize over plain HTTP and return the session id.
 *
 * The pinning tests use this rather than the SDK client on purpose: the client
 * also holds a background SSE stream, and that stream races the request under
 * test for the eviction — either one is correct, but only one of them carries
 * the status being asserted.
 */
async function openSession(key: string, workspace = 'alpha'): Promise<string> {
  const res = await post(clientHeaders(key, workspace))
  expect(res.status).toBe(200)
  const sessionId = res.headers.get('mcp-session-id')
  expect(sessionId).toBeTruthy()
  return sessionId!
}

/** One follow-up request on an established session. */
async function onSession(
  sessionId: string,
  key: string,
  body: string,
  workspace = 'alpha',
): Promise<Response> {
  return post({ ...clientHeaders(key, workspace), 'mcp-session-id': sessionId }, body)
}

describe('readCredential', () => {
  it.each([
    ['a bearer credential', 'Bearer c3k_x', { kind: 'bearer', token: 'c3k_x' }],
    ['a lower-case scheme', 'bearer c3k_x', { kind: 'bearer', token: 'c3k_x' }],
    ['surrounding whitespace', '  Bearer   c3k_x  ', { kind: 'bearer', token: 'c3k_x' }],
    // Presented and unreadable — NOT the same as absent, or trusted-local mode
    // would answer a typo with full access instead of 401.
    ['a basic credential', 'Basic dXNlcjpwdw==', { kind: 'unusable' }],
    ['a bare scheme', 'Bearer', { kind: 'unusable' }],
    ['an empty token', 'Bearer ', { kind: 'unusable' }],
    ['a second token', 'Bearer a b', { kind: 'unusable' }],
    // Only a header that was never sent is credential-free. A header the proxy
    // emptied still exists on the request — reading it as absent would answer it
    // with the trusted-local principal instead of 401. Fetch normalises a
    // whitespace-only value to `''`, so both spellings arrive the same way.
    ['no header', undefined, { kind: 'absent' }],
    ['an emptied header', '', { kind: 'unusable' }],
    ['a blank header', '   ', { kind: 'unusable' }],
  ])('reads %s as %o', (_label, header, expected) => {
    expect(readCredential(header)).toEqual(expected)
  })
})

describe('readWorkspaceHeader', () => {
  it.each([
    ['a name', 'alpha', { ok: true, name: 'alpha' }],
    ['a padded name', '  alpha  ', { ok: true, name: 'alpha' }],
    ['no header', undefined, { ok: false, reason: 'missing' }],
    ['a blank header', '   ', { ok: false, reason: 'missing' }],
    // Duplicated headers arrive comma-joined; "first one wins" would let a
    // second value decide the workspace silently.
    ['a duplicated header', 'alpha, beta', { ok: false, reason: 'malformed' }],
    ['an over-long name', 'x'.repeat(65), { ok: false, reason: 'malformed' }],
  ])('reads %s as %o', (_label, raw, expected) => {
    expect(readWorkspaceHeader(raw)).toEqual(expected)
  })
})

describe('isLoopbackAddress', () => {
  it.each([
    ['127.0.0.1', true],
    ['127.1.2.3', true],
    ['::1', true],
    ['::ffff:127.0.0.1', true],
    // For the bind-address caller: `--host localhost` is not network exposure.
    ['localhost', true],
    ['10.0.0.4', false],
    ['0.0.0.0', false],
    ['', false],
  ])('classifies %s as %s', (address, expected) => {
    expect(isLoopbackAddress(address)).toBe(expected)
  })
})

describe('the address', () => {
  it.each([
    ['the former key path', '/mcp/c3k_full'],
    ['the retired v1 entry point', '/mcp/v1'],
    ['a trailing slash', '/mcp/'],
    ['a nested path', '/mcp/c3k_full/extra'],
  ])('answers %s with 404 — it is not a compatibility route', async (_label, path) => {
    const res = await post(clientHeaders('c3k_full'), initBody(), path)
    expect(res.status).toBe(404)
  })

  it('accepts the bare path with a bearer and a workspace', async () => {
    expect((await post(clientHeaders('c3k_full'))).status).toBe(200)
  })
})

describe('the credential', () => {
  it.each([
    ['a missing header', {}],
    ['a malformed header', { authorization: 'Bearer' }],
    ['a non-bearer scheme', { authorization: 'Basic dXNlcjpwdw==' }],
    ['an unknown key', { authorization: 'Bearer c3k_nope' }],
  ])('answers %s with 401', async (_label, headers) => {
    const res = await post({ 'x-c3-workspace': 'alpha', ...headers })
    expect(res.status).toBe(401)
  })

  it('answers every 401 cause with the same body, so key existence cannot be probed', async () => {
    const missing = await (await post({ 'x-c3-workspace': 'alpha' })).text()
    const unknown = await (
      await post({ authorization: 'Bearer c3k_nope', 'x-c3-workspace': 'alpha' })
    ).text()
    const malformed = await (
      await post({ authorization: 'Basic zzz', 'x-c3-workspace': 'alpha' })
    ).text()
    expect(unknown).toBe(missing)
    expect(malformed).toBe(missing)
  })

  it('never reads a credential from the query string', async () => {
    const res = await fetch(`${endpoint()}?token=c3k_full&api_key=c3k_full`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'x-c3-workspace': 'alpha',
      },
      body: initBody(),
    })
    expect(res.status).toBe(401)
  })

  it('never reads a credential from a custom header', async () => {
    const res = await post({
      'x-api-key': 'c3k_full',
      'x-c3-token': 'c3k_full',
      'x-c3-workspace': 'alpha',
    })
    expect(res.status).toBe(401)
  })

  it('refuses a key whose owner this deployment no longer recognizes', async () => {
    world.validOwners.delete('alice')
    expect((await post(clientHeaders('c3k_full'))).status).toBe(401)
  })

  it('checks the credential before the workspace, so names cannot be probed', async () => {
    // No bearer AND no workspace header: the answer is the credential failure,
    // not the 400 that a resolved caller would have got.
    expect((await post({})).status).toBe(401)
  })
})

describe('workspace selection', () => {
  it.each([
    ['a missing header', {}],
    ['a blank header', { 'x-c3-workspace': '   ' }],
    ['a duplicated header', { 'x-c3-workspace': 'alpha, beta' }],
    ['an over-long name', { 'x-c3-workspace': 'x'.repeat(65) }],
  ])('answers %s with 400 at initialize', async (_label, extra) => {
    const res = await post({ authorization: 'Bearer c3k_full', ...extra })
    expect(res.status).toBe(400)
  })

  it('answers an unknown and an unauthorized workspace identically with 403', async () => {
    const unknown = await post(clientHeaders('c3k_full', 'never-registered'))
    const unauthorized = await post(clientHeaders('c3k_full', 'beta'))
    expect(unknown.status).toBe(403)
    expect(unauthorized.status).toBe(403)
    expect(await unknown.text()).toBe(await unauthorized.text())
  })

  it('lets one key reach every workspace its owner is allowed into', async () => {
    world.ownerWorkspaces.set('alice', ['alpha', 'beta'])
    expect((await post(clientHeaders('c3k_full', 'alpha'))).status).toBe(200)
    expect((await post(clientHeaders('c3k_full', 'beta'))).status).toBe(200)
  })

  it('creates no session for a refused workspace', async () => {
    const before = route.sessionCount()
    await post(clientHeaders('c3k_full', 'beta'))
    expect(route.sessionCount()).toBe(before)
  })
})

describe('the effective tool set', () => {
  it('advertises exactly the granted subset in tools/list', async () => {
    const { client } = await connect('c3k_full')
    try {
      const names = (await client.listTools()).tools.map((t) => t.name).sort()
      expect(names).toEqual(['find_intents', 'save_intents', 'view_intent'])
    } finally {
      await client.close()
    }
  })

  it('does not advertise — and refuses to run — an un-granted tool', async () => {
    const { client } = await connect('c3k_read')
    try {
      expect((await client.listTools()).tools.map((t) => t.name)).toEqual(['find_intents'])
      const res = await client.callTool({ name: 'save_intents', arguments: {} })
      expect(res.isError).toBe(true)
      expect(JSON.stringify(res.content)).toContain('forbidden')
      expect(calls).toEqual([])
    } finally {
      await client.close()
    }
  })

  it('runs a granted tool against the workspace the gate resolved', async () => {
    const { client } = await connect('c3k_full')
    try {
      const res = await client.callTool({ name: 'find_intents', arguments: {} })
      expect(res.isError).toBeFalsy()
      expect(calls).toEqual([{ name: 'find_intents', workspacePath: '/ws/alpha', keyId: 'key-a' }])
    } finally {
      await client.close()
    }
  })

  it('treats an empty scope as "nothing" — the session exists but offers no tool', async () => {
    const { client } = await connect('c3k_empty')
    try {
      expect((await client.listTools()).tools).toEqual([])
      const res = await client.callTool({ name: 'find_intents', arguments: {} })
      expect(res.isError).toBe(true)
    } finally {
      await client.close()
    }
  })
})

describe('the per-call workspace target', () => {
  it('runs a write against an explicitly named workspace inside the effective scope', async () => {
    world.ownerWorkspaces.set('alice', ['alpha', 'beta'])
    const { client } = await connect('c3k_full', 'alpha')
    try {
      const res = await client.callTool({
        name: 'save_intents',
        arguments: { workspaceName: 'beta' },
      })
      expect(res.isError).toBeFalsy()
      expect(calls).toEqual([{ name: 'save_intents', workspacePath: '/ws/beta', keyId: 'key-a' }])
    } finally {
      await client.close()
    }
  })

  it('leaves the session pinned to its own workspace after an override', async () => {
    world.ownerWorkspaces.set('alice', ['alpha', 'beta'])
    const { client } = await connect('c3k_full', 'alpha')
    try {
      await client.callTool({ name: 'save_intents', arguments: { workspaceName: 'beta' } })
      calls.length = 0
      // The very next call, with no override, is back on the pinned workspace.
      await client.callTool({ name: 'save_intents', arguments: {} })
      expect(calls).toEqual([{ name: 'save_intents', workspacePath: '/ws/alpha', keyId: 'key-a' }])
    } finally {
      await client.close()
    }
  })

  it.each([
    ['a workspace the owner may not reach', 'beta'],
    ['a workspace that does not exist', 'never-registered'],
    ['an empty name', ''],
  ])('refuses %s with the un-granted-tool wording and runs nothing', async (_label, name) => {
    const { client } = await connect('c3k_full', 'alpha')
    try {
      const res = await client.callTool({
        name: 'save_intents',
        arguments: { workspaceName: name },
      })
      expect(res.isError).toBe(true)
      expect((res.content as Array<{ text: string }>)[0].text).toBe(
        'forbidden: tool "save_intents" is not authorized for this key',
      )
      expect(calls).toEqual([])
    } finally {
      await client.close()
    }
  })

  it('answers an out-of-scope workspace exactly like an un-granted tool', async () => {
    const forbiddenWorkspace = await (async () => {
      const { client } = await connect('c3k_full', 'alpha')
      try {
        return await client.callTool({
          name: 'save_intents',
          arguments: { workspaceName: 'beta' },
        })
      } finally {
        await client.close()
      }
    })()
    const ungrantedTool = await (async () => {
      const { client } = await connect('c3k_read', 'alpha')
      try {
        return await client.callTool({ name: 'save_intents', arguments: {} })
      } finally {
        await client.close()
      }
    })()
    expect(JSON.stringify(forbiddenWorkspace.content)).toBe(JSON.stringify(ungrantedTool.content))
  })

  it('does not accept a workspace parameter on a read tool', async () => {
    world.ownerWorkspaces.set('alice', ['alpha', 'beta'])
    const { client } = await connect('c3k_full', 'alpha')
    try {
      const res = await client.callTool({
        name: 'find_intents',
        arguments: { workspaceName: 'beta' },
      })
      expect(res.isError).toBe(true)
      expect(JSON.stringify(res.content)).toContain('invalid arguments')
      expect(calls).toEqual([])
    } finally {
      await client.close()
    }
  })
})

describe('the write audit', () => {
  /** Call one tool on a fresh session and hand back its result. */
  async function callTool(
    key: string,
    name: string,
    args: Record<string, unknown> = {},
    workspace = 'alpha',
  ): Promise<{ isError?: boolean; content: unknown }> {
    const { client } = await connect(key, workspace)
    try {
      const res = await client.callTool({ name, arguments: args })
      return res as { isError?: boolean; content: unknown }
    } finally {
      await client.close()
    }
  }

  it('records one row with the full attribution for a successful write', async () => {
    await callTool('c3k_full', 'save_intents')
    expect(audits).toEqual([
      {
        occurredAt: 1_700_000_000_000,
        keyId: 'key-a',
        ownerSubject: 'alice',
        workspaceName: 'alpha',
        tool: 'save_intents',
        result: 'success',
      },
    ])
  })

  it('records a handler that returned an error as a failure', async () => {
    await callTool('c3k_full', 'save_intents', { q: FAIL_ARG })
    expect(audits.map((a) => a.result)).toEqual(['failure'])
  })

  it('records a handler that threw as a failure, and still reports the throw', async () => {
    // A thrown handler surfaces as a JSON-RPC error, not an `isError` result —
    // the audit must not depend on the tool being well-behaved on the way out.
    await expect(callTool('c3k_full', 'save_intents', { q: THROW_ARG })).rejects.toThrow()
    expect(audits.map((a) => a.result)).toEqual(['failure'])
  })

  it.each([
    ['an un-granted write tool', 'c3k_read', {}],
    ['an out-of-scope workspace override', 'c3k_full', { workspaceName: 'beta' }],
    ['arguments that do not fit the schema', 'c3k_full', { q: 42 }],
    ['an id owned by another workspace', 'c3k_full', { id: FOREIGN_ID }],
  ])('records %s as rejected, with no handler run', async (_label, key, args) => {
    await callTool(key, 'save_intents', args)
    expect(audits.map((a) => a.result)).toEqual(['rejected'])
    expect(calls).toEqual([])
  })

  it('records the ATTEMPTED workspace, so a refused override stays attributable', async () => {
    await callTool('c3k_full', 'save_intents', { workspaceName: 'beta' })
    expect(audits[0]).toMatchObject({ workspaceName: 'beta', result: 'rejected' })
  })

  it('never records arguments, output or anything credential-shaped', async () => {
    await callTool('c3k_full', 'save_intents', { q: 'secret-argument-value' })
    const serialized = JSON.stringify(audits)
    expect(Object.keys(audits[0]).sort()).toEqual([
      'keyId',
      'occurredAt',
      'ownerSubject',
      'result',
      'tool',
      'workspaceName',
    ])
    expect(serialized).not.toContain('secret-argument-value')
    expect(serialized).not.toContain('c3k_full')
    expect(serialized.toLowerCase()).not.toContain('authorization')
    expect(serialized.toLowerCase()).not.toContain('bearer')
  })

  it('audits no read call — read auditing is a documented gap, not a silent one', async () => {
    await callTool('c3k_full', 'find_intents')
    expect(audits).toEqual([])
  })

  it('audits no unknown tool name — it names no capability to attribute', async () => {
    await callTool('c3k_full', 'no_such_tool')
    expect(audits).toEqual([])
  })

  it('returns the business result unchanged when the audit insert fails, and says so once', async () => {
    auditFails = true
    const reported = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      const res = await callTool('c3k_full', 'save_intents', { q: 'secret-argument-value' })
      expect(res.isError).toBeFalsy()
      expect(calls).toEqual([{ name: 'save_intents', workspacePath: '/ws/alpha', keyId: 'key-a' }])
      expect(audits).toEqual([])
      // Exactly one operational error, carrying the attribution and nothing else:
      // a silent audit failure would defeat the whole point of the trail.
      expect(reported).toHaveBeenCalledTimes(1)
      const logged = reported.mock.calls[0].map(String).join(' ')
      expect(logged).toContain('key-a')
      expect(logged).toContain('save_intents')
      expect(logged).toContain('alpha')
      expect(logged).not.toContain('secret-argument-value')
      expect(logged).not.toContain('c3k_full')
      expect(logged.toLowerCase()).not.toContain('bearer')
    } finally {
      reported.mockRestore()
    }
  })

  it('waits for the audit attempt before answering', async () => {
    const order: string[] = []
    let release = (): void => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const slow = createExternalMcp({
      ...deps,
      recordWriteAudit: async (entry) => {
        await gate
        order.push(`audit:${entry.result}`)
      },
    })
    const app = new Hono()
    app.all(EXTERNAL_MCP_PATH, (c) => slow.handler(c))
    const local = serve({ fetch: app.fetch, port: 0 })
    try {
      const address = local.address() as { port: number }
      const client = new Client({ name: 'test', version: '1.0.0' })
      await client.connect(
        new StreamableHTTPClientTransport(
          new URL(`http://127.0.0.1:${address.port}${EXTERNAL_MCP_PATH}`),
          { requestInit: { headers: clientHeaders('c3k_full') } },
        ),
      )
      const pending = client.callTool({ name: 'save_intents', arguments: {} }).then(() => {
        order.push('response')
      })
      // The response cannot have been sent yet: the audit is still blocked.
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(order).toEqual([])
      release()
      await pending
      expect(order).toEqual(['audit:success', 'response'])
      await client.close()
    } finally {
      local.close()
    }
  })
})

describe('session pinning', () => {
  it('refuses an unknown session id', async () => {
    const res = await onSession('nope', 'c3k_full', rpcBody(2, 'tools/list'))
    expect(res.status).toBe(404)
  })

  it('accepts the pinned workspace header repeated on every request', async () => {
    const sessionId = await openSession('c3k_full')
    const res = await onSession(sessionId, 'c3k_full', rpcBody(2, 'tools/list'))
    expect(res.status).toBe(200)
  })

  it('refuses a different workspace header as a re-scope attempt, leaving the session alive', async () => {
    world.ownerWorkspaces.set('alice', ['alpha', 'beta'])
    const sessionId = await openSession('c3k_full')

    const rescope = await onSession(sessionId, 'c3k_full', rpcBody(2, 'tools/list'), 'beta')
    expect(rescope.status).toBe(403)
    // The request was refused, not the session: its own authority never changed.
    const same = await onSession(sessionId, 'c3k_full', rpcBody(3, 'tools/list'))
    expect(same.status).toBe(200)
  })

  it('answers another key on a live session exactly like an unknown one', async () => {
    const sessionId = await openSession('c3k_full')

    const walked = await onSession(sessionId, 'c3k_read', rpcBody(2, 'tools/list'))
    const unknown = await onSession('not-a-session', 'c3k_read', rpcBody(3, 'tools/list'))
    expect(walked.status).toBe(404)
    expect(await walked.text()).toBe(await unknown.text())
    // Nothing was torn down: one key cannot destroy another's transport.
    const owner = await onSession(sessionId, 'c3k_full', rpcBody(4, 'tools/list'))
    expect(owner.status).toBe(200)
  })

  it('evicts the session when the policy epoch advances, before any tool runs', async () => {
    const sessionId = await openSession('c3k_full')
    const before = route.sessionCount()
    world.epoch += 1

    const res = await onSession(
      sessionId,
      'c3k_full',
      JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'find_intents', arguments: {} },
      }),
    )
    expect(res.status).toBe(404)
    expect(calls).toEqual([])
    expect(route.sessionCount()).toBe(before - 1)
  })

  it('evicts the session when the key secret is rotated', async () => {
    const sessionId = await openSession('c3k_full')
    const before = route.sessionCount()
    world.keys.get('c3k_full')!.secretVersion = 2

    const res = await onSession(sessionId, 'c3k_full', rpcBody(2, 'tools/list'))
    expect(res.status).toBe(404)
    expect(route.sessionCount()).toBe(before - 1)
  })

  it('evicts the session when the owner loses the workspace mid-session', async () => {
    const sessionId = await openSession('c3k_full')
    const before = route.sessionCount()
    world.ownerWorkspaces.set('alice', [])

    const res = await onSession(sessionId, 'c3k_full', rpcBody(2, 'tools/list'))
    expect(res.status).toBe(403)
    expect(route.sessionCount()).toBe(before - 1)
  })

  it('evicts the session when the owner is removed from the roster mid-session', async () => {
    const sessionId = await openSession('c3k_full')
    const before = route.sessionCount()
    world.validOwners.delete('alice')

    const res = await onSession(sessionId, 'c3k_full', rpcBody(2, 'tools/list'))
    expect(res.status).toBe(401)
    expect(route.sessionCount()).toBe(before - 1)
  })

  it('does not leak a server when a non-initialize request arrives without a session', async () => {
    const before = route.sessionCount()
    const res = await post(clientHeaders('c3k_full'), rpcBody(5, 'tools/list'))
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(route.sessionCount()).toBe(before)
  })
})

describe('revocation', () => {
  it('tears down the revoked key\u2019s live sessions and leaves other keys alone', async () => {
    const victim = await openSession('c3k_full')
    const bystander = await openSession('c3k_read')

    route.closeSessionsForKey('key-a')

    expect((await onSession(victim, 'c3k_full', rpcBody(6, 'tools/list'))).status).toBe(404)
    expect((await onSession(bystander, 'c3k_read', rpcBody(7, 'tools/list'))).status).toBe(200)
  })

  it('is a no-op for a key with no live sessions', () => {
    expect(() => route.closeSessionsForKey('key-with-nothing')).not.toThrow()
  })

  it('tears down EVERY key of one owner, across workspaces, and leaves other owners alone', async () => {
    // A workspace-policy edit invalidates an owner's authority, not one key of
    // it — so both of alice's keys go and bob's session stays.
    const first = await openSession('c3k_full')
    const second = await openSession('c3k_read')
    const otherOwner = await openSession('c3k_beta', 'beta')

    route.closeSessionsForOwner('alice')

    expect((await onSession(first, 'c3k_full', rpcBody(8, 'tools/list'))).status).toBe(404)
    expect((await onSession(second, 'c3k_read', rpcBody(9, 'tools/list'))).status).toBe(404)
    expect(
      (await onSession(otherOwner, 'c3k_beta', rpcBody(10, 'tools/list'), 'beta')).status,
    ).toBe(200)
  })

  it('is a no-op for an owner with no live sessions', () => {
    expect(() => route.closeSessionsForOwner('nobody')).not.toThrow()
  })

  it('stops indexing an owner once its last session is closed', async () => {
    const before = route.sessionCount()
    const only = await openSession('c3k_full')
    route.closeSessionsForOwner('alice')
    expect((await onSession(only, 'c3k_full', rpcBody(11, 'tools/list'))).status).toBe(404)
    // The index emptied with the session; a second sweep finds nothing to evict.
    expect(() => route.closeSessionsForOwner('alice')).not.toThrow()
    expect(route.sessionCount()).toBe(before)
  })
})

describe('trusted-local mode', () => {
  it('serves a loopback peer with no credential at all', async () => {
    world.trustedLocal = true
    const res = await post({ 'x-c3-workspace': 'alpha' })
    expect(res.status).toBe(200)
  })

  it('gives that peer the whole catalog across every workspace its principal may reach', async () => {
    world.trustedLocal = true
    const client = new Client({ name: 'test', version: '1.0.0' })
    const transport = new StreamableHTTPClientTransport(new URL(endpoint()), {
      requestInit: { headers: { 'x-c3-workspace': 'beta' } },
    })
    await client.connect(transport)
    try {
      const names = (await client.listTools()).tools.map((t) => t.name).sort()
      expect(names).toEqual(['find_intents', 'save_intents', 'view_intent'])
    } finally {
      await client.close()
    }
  })

  it('refuses a non-loopback peer that presents no credential', async () => {
    world.trustedLocal = true
    world.peer = '10.0.0.4'
    expect((await post({ 'x-c3-workspace': 'alpha' })).status).toBe(401)
  })

  it('still requires a presented credential to verify — a bad bearer never degrades to local', async () => {
    world.trustedLocal = true
    const res = await post({ authorization: 'Bearer c3k_typo', 'x-c3-workspace': 'alpha' })
    expect(res.status).toBe(401)
  })

  // The header being unreadable is the same event as the key being wrong: the
  // caller presented something. Reading it as "no credential" would answer a
  // truncated `Bearer`, a stray space inside the key, or a `Basic` header with
  // the whole catalog on every workspace.
  it.each([
    ['an empty bearer token', 'Bearer '],
    ['a bearer with a stray space', 'Bearer c3k_a b'],
    ['a bare scheme', 'Bearer'],
    ['a non-bearer scheme', 'Basic dXNlcjpwdw=='],
    // The header a proxy stripped the value from: it is on the request, so it
    // was presented. Whitespace-only arrives as this same empty value.
    ['an emptied header', ''],
    ['a blank header', '   '],
  ])('refuses %s rather than degrading to local', async (_label, authorization) => {
    world.trustedLocal = true
    const before = route.sessionCount()
    const res = await post({ authorization, 'x-c3-workspace': 'alpha' })
    expect(res.status).toBe(401)
    expect(route.sessionCount()).toBe(before)
  })

  it('requires a credential once an administrator exists', async () => {
    world.trustedLocal = false
    expect((await post({ 'x-c3-workspace': 'alpha' })).status).toBe(401)
  })
})

describe('unconfigured exposure', () => {
  it('refuses the whole surface with 503 and actionable guidance', async () => {
    world.exposedWithoutAdmin = true
    const res = await post(clientHeaders('c3k_full'))
    expect(res.status).toBe(503)
    const body = (await res.json()) as { message: string }
    expect(body.message).toMatch(/administrator/)
    expect(body.message).toMatch(/loopback/)
  })

  it('refuses loopback requests too, and creates no session', async () => {
    world.exposedWithoutAdmin = true
    world.trustedLocal = true
    world.peer = '127.0.0.1'
    const before = route.sessionCount()
    expect((await post({ 'x-c3-workspace': 'alpha' })).status).toBe(503)
    expect(route.sessionCount()).toBe(before)
  })
})
