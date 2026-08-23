/**
 * End-to-end pass over the public external MCP surface: a REAL Streamable HTTP
 * MCP client, a REAL long-lived API key (minted and hashed by the key store), the
 * REAL authorization gate over the REAL workspace registry and account roster,
 * the REAL externally-grantable catalog over the REAL intent/discussion stores,
 * and — where the host has a LAN interface — a genuinely NON-LOOPBACK peer, which
 * is the property that distinguishes this route from the six internal ones.
 *
 * The deployment modelled here is the one that makes the whole surface meaningful:
 * bound to every interface, with a configured administrator. That is also why the
 * keys are owned by the administrator — under basic auth `local` is not a
 * principal, and an ownerless key does not exist.
 *
 * What it proves that the unit tests cannot: the address carries no credential;
 * one key reaches every workspace its owner may reach, chosen per session by
 * `X-C3-Workspace`; `tools/list` is exactly the key's granted scope; an un-granted
 * tool is refused with no side effect; a granted write tool (save / review /
 * session) really acts on the selected workspace; the former URL forms are gone;
 * and revoking the key stops both the next handshake and the session already open.
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
import { createExternalMcp, EXTERNAL_MCP_PATH, type ServedExternalMcp } from './index.js'
import { buildExternalMcpCatalog, externalMcpSourceId } from '../../features/external-mcp/tools.js'
import {
  listExternalMcpWriteAudits,
  recordExternalMcpWriteAudit,
  resetExternalMcpAuditStoreForTests,
} from '../../features/external-mcp/audit-store.js'
import {
  EXTERNAL_MCP_READ_TOOLS,
  EXTERNAL_MCP_WRITE_TOOLS,
  type AuthConfig,
} from '@ccc/shared/protocol'
import {
  createMcpApiKey,
  revokeMcpApiKey,
  verifyMcpApiKey,
} from '../../kernel/config/mcp-api-keys.js'
import { authorizeCall, localPrincipal } from '../../features/auth/authorization.js'
import { putWorkspaceScope } from '../../features/auth/scope-store.js'
import { configuredAdmin } from '../../features/auth/authz.js'
import { hashPassword } from '../../features/auth/password.js'
import {
  loadSettings,
  resetSettingsCacheForTests,
  saveSettings,
} from '../../kernel/config/index.js'
import { addWorkspace, pathToName, resetStateCacheForTests } from '../../state.js'
import {
  getIntent,
  insertIntents,
  resetStoreForTests,
  setSpecPath,
} from '../../features/intents/store.js'
import {
  createDiscussion,
  resetStoreForTests as resetDiscussionStoreForTests,
} from '../../features/discussions/store.js'
import { resetDbForTests } from '../../kernel/infra/db.js'
import { EventNormalizerRegistry } from '../../kernel/events/generic-event.js'
import { normalizeGenericEventDefault } from '../../features/events/default-normalizer.js'
import { initTestGitRepo } from '../../../test/git-repo.js'

let home: string
let projectDir: string
let otherDir: string
/** The registry name of `projectDir` — what a key is bound to. */
let projectWs: string
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
  resetDiscussionStoreForTests()
  resetExternalMcpAuditStoreForTests()

  projectDir = join(home, 'project')
  otherDir = join(home, 'other')
  mkdirSync(projectDir, { recursive: true })
  mkdirSync(otherDir, { recursive: true })
  // A real repo: `worktree` is the default branch mode, so launching a spec
  // session through the tool prepares the intent's worktree, which needs one.
  initTestGitRepo(projectDir)
  addWorkspace(projectDir, Date.now())
  addWorkspace(otherDir, Date.now())
  projectWs = pathToName(projectDir)!

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

  // A configured administrator: the deployment shape an all-interfaces bind
  // requires, and the principal most keys below are owned by. `AGENT` is the
  // narrow one, granted the project workspace and nothing else.
  useAdminAccount()
  putWorkspaceScope(AGENT, 'selected', [projectWs], Date.now())

  const normalizers = new EventNormalizerRegistry(normalizeGenericEventDefault)
  route = createExternalMcp({
    authenticate: async (key) => {
      const verified = await verifyMcpApiKey(key)
      return verified
        ? {
            keyId: verified.id,
            ownerSubject: verified.ownerSubject,
            secretVersion: verified.secretVersion,
            tools: verified.tools,
          }
        : null
    },
    trustedLocalPrincipal: () =>
      configuredAdmin(loadSettings().auth) === null ? localPrincipal() : null,
    // The REAL gate over the real registry and roster.
    authorize: authorizeCall,
    // The real predicate for a server bound to every interface.
    exposedWithoutAdmin: () => configuredAdmin(loadSettings().auth) === null,
    remoteAddress: () => undefined,
    // The REAL audit store, over the same temporary database.
    recordWriteAudit: (entry) => {
      recordExternalMcpWriteAudit(entry)
    },
    buildCatalog: () =>
      buildExternalMcpCatalog({
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
  app.all(EXTERNAL_MCP_PATH, (c) => route.handler(c))
  app.all(`${EXTERNAL_MCP_PATH}/*`, (c) => route.handler(c))
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

/** The administrator most keys are owned by; it reaches the whole registry. */
const ADMIN = 'root'
/**
 * A NON-administrator account, scoped to the project workspace alone. It is what
 * makes the injection scenario meaningful: an administrator-owned key reaching
 * the neighbouring workspace is the feature working, not a leak.
 */
const AGENT = 'agent'

/** Configure `basic` with the administrator and the narrowly-scoped account. */
function useAdminAccount(): void {
  const auth: AuthConfig = {
    enabled: true,
    provider: {
      kind: 'basic',
      accounts: [
        { username: ADMIN, passwordHash: hashPassword('correct horse') },
        { username: AGENT, passwordHash: hashPassword('battery staple') },
      ],
      adminUsername: ADMIN,
    },
    session: { ttlSeconds: 3600, signingKeyRef: 'C3_AUTH_KEY' },
  }
  saveSettings({ ...loadSettings(), auth })
}

/** Mint a key filed under the project workspace, owned by the administrator by default. */
function mintKey(
  name: string,
  tools: readonly string[],
  owner: string = ADMIN,
): ReturnType<typeof createMcpApiKey> {
  return createMcpApiKey(name, projectWs, owner, tools, Date.now())
}

function mcpUrl(host: string): URL {
  return new URL(`http://${host}:${port}${EXTERNAL_MCP_PATH}`)
}

/** Connect the way a real client is configured: bearer + workspace, both headers. */
async function connect(host: string, key: string, workspace = projectWs): Promise<Client> {
  const client = new Client({ name: 'external-e2e', version: '1.0.0' })
  await client.connect(
    new StreamableHTTPClientTransport(mcpUrl(host), {
      requestInit: {
        headers: { authorization: `Bearer ${key}`, 'x-c3-workspace': workspace },
      },
    }),
  )
  return client
}

describe('external MCP over a real Streamable HTTP client', () => {
  it('advertises exactly the granted scope — read-only by default, no write tool', async () => {
    const created = await mintKey('default', [...EXTERNAL_MCP_READ_TOOLS])
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
    const created = await mintKey('reader', [...EXTERNAL_MCP_READ_TOOLS])
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
    const created = await mintKey('narrow', [...EXTERNAL_MCP_READ_TOOLS])
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
    const created = await mintKey('writer', ['find_intents', 'view_intent', 'save_intents'])
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

  it('advertises and persists status/automate through the external save_intents contract', async () => {
    const [draft, invalidDraft] = insertIntents(
      projectDir,
      [
        {
          title: 'Activate externally',
          shortEnTitle: 'activate-external',
          content: '',
          priority: 'P1',
        },
        { title: 'Remain draft', shortEnTitle: 'remain-draft', content: 'before', priority: 'P2' },
      ],
      'draft',
    )
    const created = await mintKey('activator', ['find_intents', 'view_intent', 'save_intents'])
    const client = await connect('127.0.0.1', created.key)
    try {
      const contract = (await client.listTools()).tools.find(
        (tool) => tool.name === 'save_intents',
      )!
      expect(JSON.stringify(contract.inputSchema)).toContain('status')
      expect(JSON.stringify(contract.inputSchema)).toContain('automate')
      expect(contract.description).toContain('Acceptance')
      expect(contract.description).toContain('管理员为当前 key 授予本写工具即构成调用授权')
      expect(contract.description).not.toContain('用户在对话中明确确认后才调用')

      const activated = await client.callTool({
        name: 'save_intents',
        arguments: {
          intents: [
            {
              id: draft.id,
              title: draft.title,
              shortEnTitle: draft.shortEnTitle,
              content: draft.content,
              priority: draft.priority,
              status: 'todo',
              automate: true,
            },
          ],
        },
      })
      expect(activated.isError).toBeFalsy()
      expect(getIntent(draft.id)).toMatchObject({ status: 'todo', automate: true })

      const rejected = await client.callTool({
        name: 'save_intents',
        arguments: {
          intents: [
            {
              id: invalidDraft.id,
              title: 'Must not change',
              shortEnTitle: invalidDraft.shortEnTitle,
              content: 'after',
              priority: invalidDraft.priority,
              automate: true,
            },
          ],
        },
      })
      expect(rejected.isError).toBe(true)
      expect(JSON.stringify(rejected.content)).toContain('automate=true')
      expect(getIntent(invalidDraft.id)).toMatchObject({
        title: 'Remain draft',
        content: 'before',
        status: 'draft',
        automate: false,
      })
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

    const created = await mintKey('reviewer', ['find_intents', 'view_intent', 'submit_spec_review'])
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

  it('refuses to act on an intent outside the session’s selected workspace', async () => {
    const [foreign] = insertIntents(otherDir, [
      { title: 'Foreign neighbour', shortEnTitle: 'foreign', content: '', priority: 'P3' },
    ])
    const created = await mintKey('guarded-reviewer', ['submit_spec_review'])
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
    const created = await mintKey('launcher', [
      'find_intents',
      'view_intent',
      'start_session_for_intent',
    ])
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
    const created = await mintKey('publisher', [...EXTERNAL_MCP_READ_TOOLS])
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
      expect(published[0].sessionId).toBe(externalMcpSourceId(created.meta.id, projectWs))
      expect(published[0].event.type).toBe('custom:ping')
    } finally {
      await client.close()
    }
  })

  it('reaches a second workspace with the SAME key by starting a new session', async () => {
    const otherWs = pathToName(otherDir)!
    const created = await mintKey('roaming', [...EXTERNAL_MCP_READ_TOOLS])

    const inProject = await connect('127.0.0.1', created.key, projectWs)
    try {
      const res = await inProject.callTool({ name: 'find_intents', arguments: {} })
      expect(JSON.stringify(res.content)).toContain('Ship the external MCP route')
    } finally {
      await inProject.close()
    }

    // One key, another workspace: the owner's scope decides, not the key.
    const inOther = await connect('127.0.0.1', created.key, otherWs)
    try {
      const res = await inOther.callTool({ name: 'find_intents', arguments: {} })
      const text = JSON.stringify(res.content)
      expect(text).toContain('Unrelated neighbour intent')
      expect(text).not.toContain('Ship the external MCP route')
    } finally {
      await inOther.close()
    }
  })

  it('refuses a session for a workspace name the registry does not have', async () => {
    const created = await mintKey('unknown-ws', [...EXTERNAL_MCP_READ_TOOLS])
    const res = await fetch(`http://127.0.0.1:${port}${EXTERNAL_MCP_PATH}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${created.key}`,
        'x-c3-workspace': 'never-registered',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'x', version: '1' },
        },
      }),
    })
    expect(res.status).toBe(403)
  })

  it('accepts a connection from a non-loopback address — no loopback guard applies', async () => {
    const created = await mintKey('lan', [...EXTERNAL_MCP_READ_TOOLS])
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

  it('leaves the neighbouring workspace untouched under a prompt-injected write', async () => {
    // The scenario: something in the model's context told it to "write the
    // result into the other project", handing it a plausible workspace name and
    // an id it saw quoted elsewhere. Both are real — and neither is this key's.
    const otherWs = pathToName(otherDir)!
    const [foreign] = insertIntents(otherDir, [
      { title: 'Injection target', shortEnTitle: 'injection-target', content: '', priority: 'P1' },
    ])
    // Owned by the narrowly-scoped account: `otherWs` is outside its reach, so
    // naming it is a forbidden call rather than a legitimate cross-workspace
    // write an administrator would be entitled to make.
    const foreignDiscussion = createDiscussion({
      workspacePath: otherDir,
      title: 'Neighbour discussion',
      type: 'design',
    })
    const created = await mintKey(
      'injected',
      [
        'find_intents',
        'save_intents',
        'save_intent_directly',
        'submit_spec_review',
        'start_session_for_intent',
        'start_discussion',
      ],
      AGENT,
    )
    const client = await connect('127.0.0.1', created.key, projectWs)
    published.length = 0
    const launchesBefore = launches.length
    try {
      // 1. Update an intent that lives in the other workspace.
      const hijackUpsert = await client.callTool({
        name: 'save_intents',
        arguments: {
          intents: [
            {
              id: foreign.id,
              title: 'Rewritten by injection',
              shortEnTitle: 'rewritten',
              content: 'x',
              priority: 'P0',
            },
          ],
        },
      })
      expect(hijackUpsert.isError).toBe(true)

      // 2. Same, but "authorized" by naming the other workspace explicitly.
      const hijackTarget = await client.callTool({
        name: 'save_intents',
        arguments: {
          workspaceName: otherWs,
          intents: [
            {
              id: foreign.id,
              title: 'Rewritten by injection',
              shortEnTitle: 'rewritten',
              content: 'x',
              priority: 'P0',
            },
          ],
        },
      })
      expect(hijackTarget.isError).toBe(true)
      // Indistinguishable from an un-granted tool: the refusal says nothing
      // about whether that workspace exists.
      expect((hijackTarget.content as Array<{ text: string }>)[0].text).toBe(
        'forbidden: tool "save_intents" is not authorized for this key',
      )

      // 3. A brand-new intent in THIS workspace that depends on a foreign id —
      //    a cross-workspace edge smuggled in as a dependency.
      const hijackDep = await client.callTool({
        name: 'save_intents',
        arguments: {
          intents: [
            {
              title: 'Innocent looking',
              shortEnTitle: 'innocent',
              content: '',
              priority: 'P2',
              dependsOn: [foreign.id],
            },
          ],
        },
      })
      expect(hijackDep.isError).toBe(true)

      // 4. Record a verdict on the foreign intent, and 5. launch a session for it.
      const hijackReview = await client.callTool({
        name: 'submit_spec_review',
        arguments: { intentId: foreign.id, verdict: 'pass', reason: 'looks fine' },
      })
      expect(hijackReview.isError).toBe(true)
      const hijackLaunch = await client.callTool({
        name: 'start_session_for_intent',
        arguments: { intentId: foreign.id, sessionType: 'work' },
      })
      expect(hijackLaunch.isError).toBe(true)

      // 6. The same foreign dependency, smuggled through the OTHER intent
      //    writer — create-only, so there is no upsert target to refuse, and the
      //    edge would be the only thing crossing.
      const hijackDirectDep = await client.callTool({
        name: 'save_intent_directly',
        arguments: {
          intents: [
            {
              title: 'Innocent looking draft',
              shortEnTitle: 'innocent-draft',
              content: '',
              priority: 'P2',
              dependsOn: [foreign.id],
            },
          ],
        },
      })
      expect(hijackDirectDep.isError).toBe(true)

      // 7. Start the neighbour's discussion.
      const hijackStart = await client.callTool({
        name: 'start_discussion',
        arguments: { discussionId: foreignDiscussion.id },
      })
      expect(hijackStart.isError).toBe(true)

      // Nothing crossed: the foreign intent is byte-for-byte what it was, no
      // event was published, no agent was launched, and this workspace grew no
      // intent naming the foreign id.
      const after = getIntent(foreign.id)!
      expect(after.title).toBe(foreign.title)
      expect(after.specReviewVerdict).toBeNull()
      expect(published).toHaveLength(0)
      expect(launches.length).toBe(launchesBefore)
      const here = await client.callTool({ name: 'find_intents', arguments: {} })
      expect(JSON.stringify(here.content)).not.toContain('Innocent looking')
    } finally {
      await client.close()
    }
  })

  it('leaves one audit row per attempted write, and no row for a read', async () => {
    const created = await mintKey('audited', ['find_intents', 'save_intents'])
    const before = listExternalMcpWriteAudits(1000).length
    const client = await connect('127.0.0.1', created.key)
    try {
      await client.callTool({ name: 'find_intents', arguments: {} })
      await client.callTool({
        name: 'save_intents',
        arguments: {
          intents: [{ title: 'Audited', shortEnTitle: 'audited', content: '', priority: 'P3' }],
        },
      })
      await client.callTool({
        name: 'save_intents',
        arguments: { workspaceName: 'not-a-workspace' },
      })
    } finally {
      await client.close()
    }
    const rows = listExternalMcpWriteAudits(1000)
    expect(rows.length).toBe(before + 2)
    const mine = rows.filter((r) => r.keyId === created.meta.id)
    expect(mine.map((r) => r.result).sort()).toEqual(['rejected', 'success'])
    for (const row of mine) {
      expect(row.tool).toBe('save_intents')
      expect(row.ownerSubject).toBe(ADMIN)
      expect(row.occurredAt).toBeGreaterThan(0)
      expect(JSON.stringify(row)).not.toContain(created.key)
    }
    expect(mine.find((r) => r.result === 'success')?.workspaceName).toBe(projectWs)
    expect(mine.find((r) => r.result === 'rejected')?.workspaceName).toBe('not-a-workspace')
  })

  it('audits EVERY write tool in the catalog, granted or not', async () => {
    // Granted nothing: each write call is refused before its handler, and each
    // refusal must still be attributable — probing is exactly the behaviour that
    // must not be the one that leaves no trace.
    const created = await mintKey('audited-all', ['find_intents'])
    const before = listExternalMcpWriteAudits(1000).length
    const client = await connect('127.0.0.1', created.key)
    try {
      for (const name of EXTERNAL_MCP_WRITE_TOOLS) {
        const res = await client.callTool({ name, arguments: {} })
        expect(res.isError, name).toBe(true)
      }
    } finally {
      await client.close()
    }
    const mine = listExternalMcpWriteAudits(1000).filter((r) => r.keyId === created.meta.id)
    expect(listExternalMcpWriteAudits(1000).length).toBe(before + EXTERNAL_MCP_WRITE_TOOLS.length)
    expect(mine.map((r) => r.tool).sort()).toEqual([...EXTERNAL_MCP_WRITE_TOOLS].sort())
    expect(new Set(mine.map((r) => r.result))).toEqual(new Set(['rejected']))
  })

  it('classifies a granted write refused on id ownership as rejected, not failure', async () => {
    // The distinction the audit trail rests on: `failure` means a handler ran
    // and returned an error, `rejected` means the call never reached one. A
    // foreign id is always the second — otherwise the same probe reads as two
    // different events depending on which tool the caller aimed it at.
    const [foreign] = insertIntents(otherDir, [
      { title: 'Neighbour', shortEnTitle: 'neighbour-audit', content: '', priority: 'P2' },
    ])
    const foreignDiscussion = createDiscussion({
      workspacePath: otherDir,
      title: 'Neighbour discussion',
      type: 'design',
    })
    const granted = ['save_intents', 'save_intent_directly', 'start_discussion'] as const
    const created = await mintKey('audited-ownership', granted, AGENT)
    const client = await connect('127.0.0.1', created.key)
    try {
      const dep = {
        intents: [
          {
            title: 'Edge to elsewhere',
            shortEnTitle: 'edge-elsewhere',
            content: '',
            priority: 'P2',
            dependsOn: [foreign.id],
          },
        ],
      }
      for (const name of ['save_intents', 'save_intent_directly']) {
        expect((await client.callTool({ name, arguments: dep })).isError, name).toBe(true)
      }
      expect(
        (
          await client.callTool({
            name: 'start_discussion',
            arguments: { discussionId: foreignDiscussion.id },
          })
        ).isError,
      ).toBe(true)
    } finally {
      await client.close()
    }
    const mine = listExternalMcpWriteAudits(1000).filter((r) => r.keyId === created.meta.id)
    expect(mine.map((r) => r.tool).sort()).toEqual([...granted].sort())
    expect(new Set(mine.map((r) => r.result))).toEqual(new Set(['rejected']))
  })

  it('answers whoami and list_workspaces from the real effective scope', async () => {
    const created = await mintKey('introspecting', ['list_workspaces', 'whoami'])
    const client = await connect('127.0.0.1', created.key)
    try {
      const listed = await client.callTool({ name: 'list_workspaces', arguments: {} })
      const workspaces = JSON.parse((listed.content as Array<{ text: string }>)[0].text) as {
        workspaces: string[]
      }
      // The administrator reaches the whole registry — names only, never paths.
      expect(workspaces.workspaces).toContain(projectWs)
      expect(workspaces.workspaces).toContain(pathToName(otherDir)!)
      expect(JSON.stringify(workspaces)).not.toContain(projectDir)

      const who = await client.callTool({ name: 'whoami', arguments: {} })
      const identity = JSON.parse((who.content as Array<{ text: string }>)[0].text) as {
        keyId: string
        owner: string
        workspace: string
        workspaces: string[]
        tools: string[]
      }
      expect(identity).toMatchObject({
        keyId: created.meta.id,
        owner: ADMIN,
        workspace: projectWs,
        tools: ['list_workspaces', 'whoami'],
      })
      expect(identity.workspaces).toEqual(workspaces.workspaces)
      expect(JSON.stringify(identity)).not.toContain(created.key)
      expect(JSON.stringify(identity)).not.toContain(projectDir)
    } finally {
      await client.close()
    }
  })

  it('leaves every former URL form unreachable', async () => {
    const created = await mintKey('legacy-address', [...EXTERNAL_MCP_READ_TOOLS])
    for (const path of [
      `/mcp/${encodeURIComponent(created.key)}`,
      '/mcp/v1?token=whatever',
      '/mcp/',
    ]) {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST' })
      expect(res.status, path).toBe(404)
    }
  })

  it('refuses a credential that is not a bearer header', async () => {
    const created = await mintKey('query-addressed', [...EXTERNAL_MCP_READ_TOOLS])
    const viaQuery = await fetch(
      `http://127.0.0.1:${port}${EXTERNAL_MCP_PATH}?token=${encodeURIComponent(created.key)}`,
      { method: 'POST', headers: { 'x-c3-workspace': projectWs } },
    )
    expect(viaQuery.status).toBe(401)
    const viaHeader = await fetch(`http://127.0.0.1:${port}${EXTERNAL_MCP_PATH}`, {
      method: 'POST',
      headers: { 'x-api-key': created.key, 'x-c3-workspace': projectWs },
    })
    expect(viaHeader.status).toBe(401)
  })

  it('refuses the whole surface while exposed with no administrator', async () => {
    const created = await mintKey('during-outage', [...EXTERNAL_MCP_READ_TOOLS])
    const settings = loadSettings()
    saveSettings({ ...settings, auth: undefined })
    try {
      const res = await fetch(`http://127.0.0.1:${port}${EXTERNAL_MCP_PATH}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${created.key}`,
          'x-c3-workspace': projectWs,
        },
      })
      expect(res.status).toBe(503)
      const body = (await res.json()) as { message: string }
      expect(body.message).toMatch(/administrator/)
    } finally {
      useAdminAccount()
    }
  })

  it('stops the open session AND the next handshake once the key is revoked', async () => {
    const created = await mintKey('doomed', [...EXTERNAL_MCP_READ_TOOLS])
    const client = await connect('127.0.0.1', created.key)
    expect((await client.listTools()).tools).not.toHaveLength(0)

    expect(revokeMcpApiKey(created.meta.id)).toBe(true)
    route.closeSessionsForKey(created.meta.id)

    await expect(client.listTools()).rejects.toThrow()
    await expect(connect('127.0.0.1', created.key)).rejects.toThrow()
    await client.close().catch(() => undefined)
  })
})
