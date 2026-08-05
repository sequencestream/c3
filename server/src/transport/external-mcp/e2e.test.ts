/**
 * End-to-end pass over the public external MCP surface: a REAL Streamable HTTP
 * MCP client, a REAL long-lived API key (minted and hashed by the key store), the
 * REAL allowlisted tool set over the REAL intent/discussion stores, and — where
 * the host has a LAN interface — a genuinely NON-LOOPBACK peer, which is the
 * property that distinguishes this route from the six internal ones.
 *
 * What it proves that the unit tests cannot: `tools/list` is exactly the five
 * read-only tools (every write/session/review tool is absent by name), a call
 * really reads the workspace named in the URL, an external publish is attributed
 * to the key rather than to a forged session, and revoking the key stops both the
 * next handshake and the session already open.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { networkInterfaces, tmpdir } from 'node:os'
import { join } from 'node:path'
import { serve, type ServerType } from '@hono/node-server'
import { Hono } from 'hono'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { GenericEventEnvelope } from '@ccc/shared'
import { createExternalMcp, EXTERNAL_MCP_PATH, type ServedExternalMcp } from './index.js'
import {
  buildExternalMcpTools,
  EXTERNAL_MCP_TOOL_NAMES,
  externalMcpSourceId,
} from '../../features/external-mcp/tools.js'
import { resolveRegisteredWorkspacePath } from '../../features/external-mcp/workspace-scope.js'
import {
  canonicalizeWorkspacePath,
  createMcpApiKey,
  revokeMcpApiKey,
  verifyMcpApiKey,
} from '../../kernel/config/mcp-api-keys.js'
import { resetSettingsCacheForTests } from '../../kernel/config/index.js'
import { addWorkspace, resetStateCacheForTests } from '../../state.js'
import { insertIntents, resetStoreForTests } from '../../features/intents/store.js'
import { resetDbForTests } from '../../kernel/infra/db.js'
import { EventNormalizerRegistry } from '../../kernel/events/generic-event.js'
import { normalizeGenericEventDefault } from '../../features/events/default-normalizer.js'

/**
 * Tool names that must NEVER appear on the external route. Asserted by name (not
 * by "count === 5") so adding an internal write tool that accidentally reaches
 * this surface fails loudly rather than shifting a number.
 */
const FORBIDDEN_TOOLS = [
  'save_intents',
  'save_intent_directly',
  'save_intent_pr_info',
  'start_discussion',
  'continue_discussion',
  'start_session_for_intent',
  'spec_review',
]

let home: string
let projectDir: string
let otherDir: string
let server: ServerType
let port: number
let route: ServedExternalMcp
let plaintextKey: string
let keyId: string
const published: GenericEventEnvelope[] = []

/** A non-loopback IPv4 of this host, or null when it has none (CI in a bare netns). */
function lanAddress(): string | null {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal) return a.address
    }
  }
  return null
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'c3-external-mcp-'))
  process.env.HOME = home
  process.env.C3_DIR = home
  process.env.C3_DB_PATH = join(home, 'c3.db')
  resetSettingsCacheForTests()
  resetStateCacheForTests()
  resetDbForTests()
  resetStoreForTests()

  projectDir = join(home, 'project')
  otherDir = join(home, 'other')
  mkdirSync(projectDir, { recursive: true })
  mkdirSync(otherDir, { recursive: true })
  addWorkspace(projectDir, Date.now())
  addWorkspace(otherDir, Date.now())

  // One intent per workspace, so a cross-workspace leak would be visible.
  insertIntents(projectDir, [
    {
      title: 'Ship the external MCP route',
      shortEnTitle: 'external-mcp',
      content: '',
      priority: 'P0',
    },
  ])
  insertIntents(otherDir, [
    { title: 'Unrelated neighbour intent', shortEnTitle: 'neighbour', content: '', priority: 'P1' },
  ])

  const created = await createMcpApiKey('e2e', [projectDir], Date.now())
  plaintextKey = created.key
  keyId = created.meta.id

  const normalizers = new EventNormalizerRegistry(normalizeGenericEventDefault)
  route = createExternalMcp({
    authenticate: (token) => verifyMcpApiKey(token),
    canonicalizeWorkspace: canonicalizeWorkspacePath,
    resolveRegisteredWorkspace: resolveRegisteredWorkspacePath,
    buildTools: (scope) =>
      buildExternalMcpTools(scope, {
        normalizeEvent: (core) => normalizers.normalize(core),
        publishEvent: (payload) => published.push(payload),
      }),
  })

  const app = new Hono()
  app.all(EXTERNAL_MCP_PATH, (c) => route.handler(c))
  await new Promise<void>((resolve) => {
    // Bind ALL interfaces so the non-loopback case below has something to reach.
    server = serve({ fetch: app.fetch, port: 0, hostname: '0.0.0.0' }, (info) => {
      port = info.port
      resolve()
    })
  })
})

afterAll(() => {
  server?.close()
  resetDbForTests()
  delete process.env.C3_DB_PATH
  delete process.env.C3_DIR
  resetSettingsCacheForTests()
  resetStateCacheForTests()
  rmSync(home, { recursive: true, force: true })
})

function mcpUrl(host: string, token: string, workspace: string): URL {
  return new URL(
    `http://${host}:${port}${EXTERNAL_MCP_PATH}?token=${encodeURIComponent(token)}&workspace=${encodeURIComponent(workspace)}`,
  )
}

async function connect(host: string, token: string, workspace: string): Promise<Client> {
  const client = new Client({ name: 'external-e2e', version: '1.0.0' })
  await client.connect(new StreamableHTTPClientTransport(mcpUrl(host, token, workspace)))
  return client
}

describe('external MCP over a real Streamable HTTP client', () => {
  it('advertises exactly the five read-only tools and no write tool', async () => {
    const client = await connect('127.0.0.1', plaintextKey, projectDir)
    try {
      const names = (await client.listTools()).tools.map((t) => t.name).sort()
      expect(names).toEqual([...EXTERNAL_MCP_TOOL_NAMES].sort())
      for (const forbidden of FORBIDDEN_TOOLS) expect(names).not.toContain(forbidden)
    } finally {
      await client.close()
    }
  })

  it('reads only the workspace named in the URL', async () => {
    const client = await connect('127.0.0.1', plaintextKey, projectDir)
    try {
      const res = await client.callTool({ name: 'find_intents', arguments: {} })
      const text = JSON.stringify(res.content)
      expect(res.isError).toBeFalsy()
      expect(text).toContain('Ship the external MCP route')
      expect(text).not.toContain('Unrelated neighbour intent')
    } finally {
      await client.close()
    }
  })

  it('serves find_discussions and view_discussion without a run binding', async () => {
    const client = await connect('127.0.0.1', plaintextKey, projectDir)
    try {
      const found = await client.callTool({ name: 'find_discussions', arguments: {} })
      expect(found.isError).toBeFalsy()
      // An id that does not exist answers "not found" — a normal result, not a crash.
      const viewed = await client.callTool({
        name: 'view_discussion',
        arguments: { discussionId: 'no-such-discussion' },
      })
      expect(viewed.content).toBeDefined()
    } finally {
      await client.close()
    }
  })

  it('attributes an external publish to the key, with the authorized workspace', async () => {
    published.length = 0
    const client = await connect('127.0.0.1', plaintextKey, projectDir)
    try {
      const res = await client.callTool({
        name: 'publish_event',
        arguments: { type: 'custom:ping', status: 'success', description: 'from CI' },
      })
      expect(res.isError).toBeFalsy()
      expect(published).toHaveLength(1)
      expect(published[0].workspacePath).toBe(projectDir)
      expect(published[0].sessionId).toBe(externalMcpSourceId(keyId))
      expect(published[0].event.type).toBe('custom:ping')
    } finally {
      await client.close()
    }
  })

  it('publishes nothing when the event itself is rejected', async () => {
    published.length = 0
    const client = await connect('127.0.0.1', plaintextKey, projectDir)
    try {
      const res = await client.callTool({ name: 'publish_event', arguments: { type: '' } })
      expect(res.isError).toBe(true)
      expect(published).toHaveLength(0)
    } finally {
      await client.close()
    }
  })

  it('refuses a workspace the key was not granted, even though it is registered', async () => {
    await expect(connect('127.0.0.1', plaintextKey, otherDir)).rejects.toThrow()
  })

  it('accepts a connection from a non-loopback address — no loopback guard applies', async () => {
    const lan = lanAddress()
    if (!lan) {
      // No routable interface on this host; the loopback-guard property cannot be
      // observed here. Reported rather than silently passing.
      console.warn('[test] skipped: host has no non-loopback IPv4 interface')
      return
    }
    const client = await connect(lan, plaintextKey, projectDir)
    try {
      const names = (await client.listTools()).tools.map((t) => t.name).sort()
      expect(names).toEqual([...EXTERNAL_MCP_TOOL_NAMES].sort())
    } finally {
      await client.close()
    }
  })

  it('stops the open session AND the next handshake once the key is revoked', async () => {
    const created = await createMcpApiKey('doomed', [projectDir], Date.now())
    const client = await connect('127.0.0.1', created.key, projectDir)
    expect((await client.listTools()).tools).not.toHaveLength(0)

    expect(revokeMcpApiKey(created.meta.id)).toBe(true)
    route.closeSessionsForKey(created.meta.id)

    await expect(client.listTools()).rejects.toThrow()
    await expect(connect('127.0.0.1', created.key, projectDir)).rejects.toThrow()
    await client.close().catch(() => undefined)
  })
})
