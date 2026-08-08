/**
 * End-to-end pass over the public external MCP surface: a REAL Streamable HTTP
 * MCP client, a REAL long-lived API key (minted and hashed by the key store), the
 * REAL externally-grantable catalog over the REAL intent/discussion stores, and —
 * where the host has a LAN interface — a genuinely NON-LOOPBACK peer, which is
 * the property that distinguishes this route from the six internal ones.
 *
 * What it proves that the unit tests cannot: the address IS the key (`/mcp/<key>`);
 * `tools/list` is exactly the key's granted scope; an un-granted tool is refused
 * with no side effect; a granted write tool (save / review / session) really acts
 * on the workspace the key is bound to; the retired query entry point is
 * discontinued; and revoking the key stops both the next handshake and the
 * session already open.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { networkInterfaces, tmpdir } from 'node:os'
import { join } from 'node:path'
import { serve, type ServerType } from '@hono/node-server'
import { Hono } from 'hono'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { GenericEventEnvelope } from '@ccc/shared'
import { createExternalMcp, EXTERNAL_MCP_PATH_PREFIX, type ServedExternalMcp } from './index.js'
import { buildExternalMcpCatalog, externalMcpSourceId } from '../../features/external-mcp/tools.js'
import { EXTERNAL_MCP_READ_TOOLS } from '@ccc/shared/protocol'
import { resolveRegisteredWorkspacePath } from '../../features/external-mcp/workspace-scope.js'
import {
  createMcpApiKey,
  revokeMcpApiKey,
  verifyMcpApiKey,
} from '../../kernel/config/mcp-api-keys.js'
import { resetSettingsCacheForTests } from '../../kernel/config/index.js'
import { addWorkspace, resetStateCacheForTests } from '../../state.js'
import {
  getIntent,
  insertIntents,
  resetStoreForTests,
  setSpecPath,
} from '../../features/intents/store.js'
import { resetDbForTests } from '../../kernel/infra/db.js'
import { EventNormalizerRegistry } from '../../kernel/events/generic-event.js'
import { normalizeGenericEventDefault } from '../../features/events/default-normalizer.js'
import { initTestGitRepo } from '../../../test/git-repo.js'

let home: string
let projectDir: string
let otherDir: string
let server: ServerType
let port: number
let route: ServedExternalMcp
const published: GenericEventEnvelope[] = []
const launches: unknown[] = []

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
  // C3_DIR (not HOME — os.homedir() caches its first call in the worker) is what
  // relocates the settings file for this process.
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
  // A real repo: `worktree` is the default branch mode, so launching a spec
  // session through the tool prepares the intent's worktree, which needs one.
  initTestGitRepo(projectDir)
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

  const normalizers = new EventNormalizerRegistry(normalizeGenericEventDefault)
  route = createExternalMcp({
    authenticate: (key) => verifyMcpApiKey(key),
    resolveRegisteredWorkspace: resolveRegisteredWorkspacePath,
    buildCatalog: (scope) =>
      buildExternalMcpCatalog(scope, {
        normalizeEvent: (core) => normalizers.normalize(core),
        publishEvent: (payload) => published.push(payload),
        broadcastIntents: () => undefined,
        broadcastDiscussions: () => undefined,
        broadcastDiscussionMessage: () => undefined,
        startDiscussionRun: () => undefined,
        launchRun: async () => {
          launches.push({ at: Date.now() })
        },
      }),
  })

  const app = new Hono()
  app.all(EXTERNAL_MCP_PATH_PREFIX, (c) => route.handler(c))
  app.all(`${EXTERNAL_MCP_PATH_PREFIX}/*`, (c) => route.handler(c))
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

afterEach(() => {
  launches.length = 0
})

function mcpUrl(host: string, key: string): URL {
  return new URL(`http://${host}:${port}${EXTERNAL_MCP_PATH_PREFIX}/${encodeURIComponent(key)}`)
}

async function connect(host: string, key: string): Promise<Client> {
  const client = new Client({ name: 'external-e2e', version: '1.0.0' })
  await client.connect(new StreamableHTTPClientTransport(mcpUrl(host, key)))
  return client
}

describe('external MCP over a real Streamable HTTP client', () => {
  it('advertises exactly the granted scope — read-only by default, no write tool', async () => {
    const created = await createMcpApiKey(
      'default',
      projectDir,
      [...EXTERNAL_MCP_READ_TOOLS],
      Date.now(),
    )
    const client = await connect('127.0.0.1', created.key)
    try {
      const names = (await client.listTools()).tools.map((t) => t.name).sort()
      expect(names).toEqual([...EXTERNAL_MCP_READ_TOOLS].sort())
      expect(names).not.toContain('save_intents')
      expect(names).not.toContain('submit_spec_review')
      expect(names).not.toContain('start_session_for_intent')
    } finally {
      await client.close()
    }
  })

  it('reads only the workspace the key is bound to', async () => {
    const created = await createMcpApiKey(
      'reader',
      projectDir,
      [...EXTERNAL_MCP_READ_TOOLS],
      Date.now(),
    )
    const client = await connect('127.0.0.1', created.key)
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

  it('refuses an un-granted write tool with a forbidden error and no side effect', async () => {
    const created = await createMcpApiKey(
      'narrow',
      projectDir,
      [...EXTERNAL_MCP_READ_TOOLS],
      Date.now(),
    )
    const client = await connect('127.0.0.1', created.key)
    try {
      const before = await client.callTool({ name: 'find_intents', arguments: {} })
      const res = await client.callTool({
        name: 'save_intents',
        arguments: {
          intents: [{ title: 'Sneaky', shortEnTitle: 'sneaky', content: '', priority: 'P2' }],
        },
      })
      expect(res.isError).toBe(true)
      expect(JSON.stringify(res.content)).toContain('forbidden')
      const after = await client.callTool({ name: 'find_intents', arguments: {} })
      expect(JSON.stringify(before.content)).toBe(JSON.stringify(after.content))
    } finally {
      await client.close()
    }
  })

  it('persists an intent through a key granted save_intents', async () => {
    const created = await createMcpApiKey(
      'writer',
      projectDir,
      ['find_intents', 'view_intent', 'save_intents'],
      Date.now(),
    )
    const client = await connect('127.0.0.1', created.key)
    try {
      const res = await client.callTool({
        name: 'save_intents',
        arguments: {
          intents: [
            {
              title: 'Written from outside',
              shortEnTitle: 'external-write',
              content: 'hi',
              priority: 'P2',
            },
          ],
        },
      })
      expect(res.isError).toBeFalsy()
      const listed = await client.callTool({ name: 'find_intents', arguments: {} })
      expect(JSON.stringify(listed.content)).toContain('Written from outside')
    } finally {
      await client.close()
    }
  })

  it('records a spec review through a key granted submit_spec_review', async () => {
    const [intent] = insertIntents(projectDir, [
      { title: 'Spec me', shortEnTitle: 'spec-me', content: '', priority: 'P1' },
    ])
    const specRel = `specs/${intent.id}.md`
    setSpecPath(intent.id, specRel)
    mkdirSync(join(projectDir, 'specs'), { recursive: true })
    writeFileSync(join(projectDir, specRel), '# Spec\n\nbody\n', 'utf8')

    const created = await createMcpApiKey(
      'reviewer',
      projectDir,
      ['find_intents', 'view_intent', 'submit_spec_review'],
      Date.now(),
    )
    const client = await connect('127.0.0.1', created.key)
    try {
      const res = await client.callTool({
        name: 'submit_spec_review',
        arguments: { intentId: intent.id, verdict: 'pass', reason: 'good enough' },
      })
      expect(res.isError).toBeFalsy()
      expect(getIntent(intent.id)?.specReviewVerdict).toBe('pass')
    } finally {
      await client.close()
    }
  })

  it('refuses to act on an intent outside the key’s bound workspace', async () => {
    const [foreign] = insertIntents(otherDir, [
      { title: 'Foreign neighbour', shortEnTitle: 'foreign', content: '', priority: 'P3' },
    ])
    const created = await createMcpApiKey(
      'guarded-reviewer',
      projectDir,
      ['submit_spec_review'],
      Date.now(),
    )
    const client = await connect('127.0.0.1', created.key)
    try {
      const res = await client.callTool({
        name: 'submit_spec_review',
        arguments: { intentId: foreign.id, verdict: 'pass', reason: 'x' },
      })
      expect(res.isError).toBe(true)
      // The foreign intent is untouched — no verdict was recorded for it.
      expect(getIntent(foreign.id)?.specReviewVerdict).toBeNull()
    } finally {
      await client.close()
    }
  })

  it('starts a spec session through a key granted start_session_for_intent', async () => {
    const [intent] = insertIntents(projectDir, [
      { title: 'Launch me', shortEnTitle: 'launch-me', content: '', priority: 'P2' },
    ])
    const created = await createMcpApiKey(
      'launcher',
      projectDir,
      ['find_intents', 'view_intent', 'start_session_for_intent'],
      Date.now(),
    )
    const client = await connect('127.0.0.1', created.key)
    try {
      const launchesBefore = launches.length
      const res = await client.callTool({
        name: 'start_session_for_intent',
        arguments: { intentId: intent.id, sessionType: 'spec' },
      })
      expect(res.isError).toBeFalsy()
      // The tool reports its structured result as JSON in the text content.
      const parsed = JSON.parse((res.content as Array<{ text: string }>)[0].text) as {
        sessionId: string
        sessionType: string
        mode: string
      }
      expect(parsed.sessionType).toBe('spec')
      expect(parsed.mode).toBe('fresh')
      expect(parsed.sessionId).toBeTruthy()
      // The real launcher path was exercised: the session-launch hook fired.
      expect(launches.length).toBeGreaterThan(launchesBefore)
    } finally {
      await client.close()
    }
  })

  it('attributes an external publish to the key, with the authorized workspace', async () => {
    const created = await createMcpApiKey(
      'publisher',
      projectDir,
      [...EXTERNAL_MCP_READ_TOOLS],
      Date.now(),
    )
    published.length = 0
    const client = await connect('127.0.0.1', created.key)
    try {
      const res = await client.callTool({
        name: 'publish_event',
        arguments: { type: 'custom:ping', status: 'success', description: 'from CI' },
      })
      expect(res.isError).toBeFalsy()
      expect(published).toHaveLength(1)
      expect(published[0].workspacePath).toBe(projectDir)
      expect(published[0].sessionId).toBe(externalMcpSourceId(created.meta.id))
      expect(published[0].event.type).toBe('custom:ping')
    } finally {
      await client.close()
    }
  })

  it('accepts a connection from a non-loopback address — no loopback guard applies', async () => {
    const created = await createMcpApiKey(
      'lan',
      projectDir,
      [...EXTERNAL_MCP_READ_TOOLS],
      Date.now(),
    )
    const lan = lanAddress()
    if (!lan) {
      // No routable interface on this host; the loopback-guard property cannot be
      // observed here. Reported rather than silently passing.
      console.warn('[test] skipped: host has no non-loopback IPv4 interface')
      return
    }
    const client = await connect(lan, created.key)
    try {
      const names = (await client.listTools()).tools.map((t) => t.name).sort()
      expect(names).toEqual([...EXTERNAL_MCP_READ_TOOLS].sort())
    } finally {
      await client.close()
    }
  })

  it('discontinues the retired /mcp/v1?token= entry point', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/mcp/v1?token=whatever`, { method: 'POST' })
    expect(res.status).toBe(410)
    await expect(res.json()).resolves.toMatchObject({ error: 'discontinued' })
  })

  it('stops the open session AND the next handshake once the key is revoked', async () => {
    const created = await createMcpApiKey(
      'doomed',
      projectDir,
      [...EXTERNAL_MCP_READ_TOOLS],
      Date.now(),
    )
    const client = await connect('127.0.0.1', created.key)
    expect((await client.listTools()).tools).not.toHaveLength(0)

    expect(revokeMcpApiKey(created.meta.id)).toBe(true)
    route.closeSessionsForKey(created.meta.id)

    await expect(client.listTools()).rejects.toThrow()
    await expect(connect('127.0.0.1', created.key)).rejects.toThrow()
    await client.close().catch(() => undefined)
  })
})
