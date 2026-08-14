/**
 * The admin-gated key-management handlers. The store and the workspace registry
 * are stubbed — persistence has its own tests in
 * `kernel/config/mcp-api-keys.test.ts` — so what is asserted here is exactly what
 * these handlers own: the administrator gate, the id ⇄ path translation, the
 * server-decided initial scope, the all-or-nothing tool-scope rule, the single
 * appearance of the plaintext, and revocation/re-scoping reaching live sessions.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { EXTERNAL_MCP_DEFAULT_TOOLS, type ServerToClient } from '@ccc/shared/protocol'
import type { Conn } from '../../transport/handler-registry.js'
import type { KernelContext } from '../../kernel/types.js'
import type { McpApiKeyInfo } from '../../kernel/config/mcp-api-keys.js'

/**
 * What the server forces onto a fresh key. Taken from the shared list rather
 * than spelled out again: this file asserts that the handler ignores whatever
 * the client asked for, not what the default set happens to contain today.
 */
const READ_TOOLS = [...EXTERNAL_MCP_DEFAULT_TOOLS]

const h = vi.hoisted(() => ({
  admin: true,
  records: [] as McpApiKeyInfo[],
  created: null as {
    name: string
    workspaceName: string | null
    ownerSubject: string
    tools: string[]
  } | null,
  /** Successful self-service resets, in order: `<id>@<owner>`. */
  reset: [] as string[],
  /** Next plaintext `replaceMcpApiKeySecretForOwner` hands back. */
  resetSecret: 'c3k_key-1_ROTATED-PLAINTEXT',
  /** Owners this deployment still recognizes; anything else is a dead key. */
  validOwners: new Set<string>(['admin']),
  updatedTools: null as { id: string; tools: string[] } | null,
  renamed: null as { id: string; name: string } | null,
  revoked: [] as string[],
  closed: [] as string[],
  throwOnWrite: false,
  /** Registered workspaces: id → canonical path. */
  registry: new Map<string, string>([
    ['ws-alpha', '/canon/alpha'],
    ['ws-beta', '/canon/beta'],
  ]),
  /** Registered paths whose directory has vanished (key unusable). */
  goneDirs: new Set<string>(),
}))

vi.mock('../auth/authz.js', () => ({
  requireAdmin: (conn: Conn) => {
    if (h.admin) return true
    conn.send({ type: 'error', error: { code: 'auth.adminOnly' } })
    return false
  },
}))

vi.mock('../../kernel/config/mcp-api-keys.js', () => ({
  listMcpApiKeysForWorkspace: (workspaceName: string) =>
    h.records.filter((r) => r.workspaceName === workspaceName),
  listMcpApiKeysForOwner: (ownerSubject: string) =>
    h.records.filter((r) => r.ownerSubject === ownerSubject),
  // Owner matching lives INSIDE the store operation, so the mock refuses a
  // foreign id exactly the way the real one does.
  replaceMcpApiKeySecretForOwner: async (id: string, ownerSubject: string) => {
    if (h.throwOnWrite) throw new Error('disk full')
    const rec = h.records.find((r) => r.id === id && r.ownerSubject === ownerSubject)
    if (!rec) return null
    rec.secretVersion += 1
    h.reset.push(`${id}@${ownerSubject}`)
    return { meta: rec, key: h.resetSecret }
  },
  revokeMcpApiKeyForOwner: (id: string, ownerSubject: string) => {
    const idx = h.records.findIndex((r) => r.id === id && r.ownerSubject === ownerSubject)
    if (idx < 0) return false
    h.revoked.push(id)
    h.records = h.records.filter((r) => r.id !== id)
    return true
  },
  createMcpApiKey: async (
    name: string,
    workspaceName: string | null,
    ownerSubject: string,
    tools: string[],
  ) => {
    if (h.throwOnWrite) throw new Error('disk full')
    h.created = { name, workspaceName, ownerSubject, tools: [...tools] }
    const meta: McpApiKeyInfo = {
      id: 'key-new',
      name,
      createdAt: 10,
      lastUsedAt: null,
      ownerSubject,
      secretVersion: 1,
      workspaceName,
      tools: [...tools],
      displayPrefix: 'c3k_key-new',
    }
    h.records = [...h.records, meta]
    return { meta, key: 'c3k_key-new_THE-PLAINTEXT' }
  },
  updateMcpApiKeyInWorkspace: (
    id: string,
    workspaceName: string,
    patch: { name?: string; tools?: string[] },
  ) => {
    const rec = h.records.find((r) => r.id === id && r.workspaceName === workspaceName)
    if (!rec) return null
    if (patch.name !== undefined) {
      h.renamed = { id, name: patch.name }
      rec.name = patch.name
    }
    if (patch.tools !== undefined) {
      h.updatedTools = { id, tools: [...patch.tools] }
      rec.tools = [...patch.tools]
    }
    return rec
  },
  revokeMcpApiKeyInWorkspace: (id: string, workspaceName: string) => {
    const idx = h.records.findIndex((r) => r.id === id && r.workspaceName === workspaceName)
    if (idx < 0) return false
    h.revoked.push(id)
    h.records = h.records.filter((r) => r.id !== id)
    return true
  },
}))

vi.mock('../external-mcp/workspace-scope.js', () => ({
  workspaceNameToCanonicalPath: (id: string) => h.registry.get(id) ?? null,
  canonicalPathToWorkspaceName: (path: string) =>
    [...h.registry.entries()].find(([, p]) => p === path)?.[0] ?? null,
  resolveRegisteredWorkspacePath: (path: string) =>
    [...h.registry.values()].includes(path) && !h.goneDirs.has(path) ? path : null,
}))

vi.mock('../../state.js', () => ({
  resolveWorkspaceRoot: (name: string) => h.registry.get(name) ?? null,
  isDirectory: (path: string) => !h.goneDirs.has(path),
}))

vi.mock('../auth/authorization.js', () => ({
  resolveAuthSubject: (subject: string | null) => subject,
  isValidOwner: (owner: string) => h.validOwners.has(owner),
}))

vi.mock('../external-mcp/tools.js', () => ({
  externalMcpToolDescriptors: () => [
    { name: 'find_intents', access: 'read' },
    { name: 'view_intent', access: 'read' },
    { name: 'find_discussions', access: 'read' },
    { name: 'view_discussion', access: 'read' },
    { name: 'publish_event', access: 'read' },
    { name: 'save_intents', access: 'write' },
  ],
  normalizeExternalMcpToolScope: (names: readonly string[]) => {
    const known = new Set([
      'find_intents',
      'view_intent',
      'find_discussions',
      'view_discussion',
      'publish_event',
      'save_intents',
    ])
    const out: string[] = []
    for (const raw of names) {
      const name = typeof raw === 'string' ? raw.trim() : ''
      if (!known.has(name) || out.includes(name))
        return { ok: false as const, offender: String(raw) }
      out.push(name)
    }
    return { ok: true as const, tools: out }
  },
}))

const {
  createMcpApiKeyHandler,
  createMyMcpApiKeyHandler,
  listMcpApiKeysHandler,
  listMyMcpApiKeysHandler,
  resetMyMcpApiKeyHandler,
  revokeMcpApiKeyHandler,
  revokeMyMcpApiKeyHandler,
  setExternalMcpSessionCloser,
  updateMcpApiKeyHandler,
} = await import('./mcp-api-keys.js')

const ctx = {} as KernelContext

function makeConn(): { conn: Conn; sent: ServerToClient[] } {
  const sent: ServerToClient[] = []
  const conn = {
    send: (m: ServerToClient) => sent.push(m),
    authed: true,
    authToken: 'tok',
    subject: 'admin',
  } as unknown as Conn
  return { conn, sent }
}

function seed(records: McpApiKeyInfo[]): void {
  h.records = records
}

function key(over: Partial<McpApiKeyInfo> = {}): McpApiKeyInfo {
  const merged = {
    id: 'key-1',
    name: 'ci',
    createdAt: 1,
    lastUsedAt: null,
    ownerSubject: 'admin',
    secretVersion: 1,
    workspaceName: 'ws-alpha',
    tools: [...READ_TOOLS],
    displayPrefix: 'c3k_key-1',
    ...over,
  }
  return { ...merged, displayPrefix: `c3k_${merged.id}` }
}

beforeEach(() => {
  h.admin = true
  h.records = []
  h.created = null
  h.updatedTools = null
  h.renamed = null
  h.revoked = []
  h.closed = []
  h.reset = []
  h.resetSecret = 'c3k_key-1_ROTATED-PLAINTEXT'
  h.throwOnWrite = false
  h.goneDirs.clear()
  h.validOwners = new Set(['admin'])
  setExternalMcpSessionCloser((id) => h.closed.push(id))
})

describe('the administrator gate', () => {
  it('lets a non-admin view the metadata-only roster but refuses every mutation', async () => {
    h.admin = false
    seed([key()])

    // Listing is NOT admin-gated: the roster carries no secret, and hiding it from
    // non-administrators would only make the feature look absent rather than
    // restricted. What it returns is exactly the metadata a view is allowed to see.
    const list = makeConn()
    listMcpApiKeysHandler(ctx, list.conn, { type: 'list_mcp_api_keys', workspaceName: 'ws-alpha' })
    expect(list.sent[0]).toMatchObject({ type: 'mcp_api_keys' })

    const create = makeConn()
    await createMcpApiKeyHandler(ctx, create.conn, {
      type: 'create_mcp_api_key',
      workspaceName: 'ws-alpha',
      name: 'x',
    })

    const update = makeConn()
    updateMcpApiKeyHandler(ctx, update.conn, {
      type: 'update_mcp_api_key',
      workspaceName: 'ws-alpha',
      id: 'key-1',
      tools: [],
    })

    const revoke = makeConn()
    revokeMcpApiKeyHandler(ctx, revoke.conn, {
      type: 'revoke_mcp_api_key',
      workspaceName: 'ws-alpha',
      id: 'key-1',
    })

    for (const { sent } of [create, update, revoke]) {
      expect(sent).toEqual([{ type: 'error', error: { code: 'auth.adminOnly' } }])
    }
    expect(h.created).toBeNull()
    expect(h.updatedTools).toBeNull()
    expect(h.revoked).toEqual([])
    expect(h.records).toHaveLength(1)
  })
})

describe('list_mcp_api_keys', () => {
  it('is scoped to the named workspace and carries the catalog but no secrets', () => {
    seed([
      key({ id: 'key-a', workspaceName: 'ws-alpha' }),
      key({ id: 'key-b', workspaceName: 'ws-beta' }),
    ])
    const { conn, sent } = makeConn()
    listMcpApiKeysHandler(ctx, conn, { type: 'list_mcp_api_keys', workspaceName: 'ws-alpha' })

    const msg = sent[0] as Extract<ServerToClient, { type: 'mcp_api_keys' }>
    expect(msg.workspaceName).toBe('ws-alpha')
    expect(msg.keys.map((k) => k.id)).toEqual(['key-a'])
    expect(msg.keys[0]).toEqual({
      id: 'key-a',
      name: 'ci',
      createdAt: 1,
      lastUsedAt: null,
      workspaceName: 'ws-alpha',
      unavailable: false,
      tools: [...READ_TOOLS],
      displayPrefix: 'c3k_key-a',
    })
    expect(msg.catalog.length).toBeGreaterThan(0)
    expect(JSON.stringify(msg)).not.toContain('salt')
    expect((msg as { created?: unknown }).created).toBeUndefined()
  })

  it('marks a key unavailable when its owner is no longer recognized, without disclosing the path', () => {
    seed([key({ ownerSubject: 'departed' })])
    const { conn, sent } = makeConn()
    listMcpApiKeysHandler(ctx, conn, { type: 'list_mcp_api_keys', workspaceName: 'ws-alpha' })
    const msg = sent[0] as Extract<ServerToClient, { type: 'mcp_api_keys' }>
    expect(msg.keys[0].workspaceName).toBe('ws-alpha')
    expect(msg.keys[0].unavailable).toBe(true)
    // The host path is never on the wire, whatever the key's state.
    expect(JSON.stringify(msg)).not.toContain('/canon/alpha')
  })

  it('rejects an unknown workspace id outright', () => {
    const { conn, sent } = makeConn()
    listMcpApiKeysHandler(ctx, conn, { type: 'list_mcp_api_keys', workspaceName: 'ws-forged' })
    expect(sent).toEqual([
      {
        type: 'error',
        error: { code: 'mcpApiKey.unknownWorkspace', params: { workspaceName: 'ws-forged' } },
      },
    ])
  })
})

describe('create_mcp_api_key', () => {
  it('returns the plaintext exactly once, alongside the refreshed roster', async () => {
    const { conn, sent } = makeConn()
    await createMcpApiKeyHandler(ctx, conn, {
      type: 'create_mcp_api_key',
      workspaceName: 'ws-alpha',
      name: 'ci bot',
    })

    const msg = sent[0] as Extract<ServerToClient, { type: 'mcp_api_keys' }>
    expect(msg.type).toBe('mcp_api_keys')
    expect(msg.created?.key).toBe('c3k_key-new_THE-PLAINTEXT')
    expect(msg.created?.meta.workspaceName).toBe('ws-alpha')
    expect(msg.keys).toHaveLength(1)

    // A subsequent list carries no plaintext — it existed only in that one reply.
    const again = makeConn()
    listMcpApiKeysHandler(ctx, again.conn, { type: 'list_mcp_api_keys', workspaceName: 'ws-alpha' })
    expect(JSON.stringify(again.sent)).not.toContain('THE-PLAINTEXT')
  })

  it('files the key under the named workspace, owns it by the verified subject, and forces the read-only scope', async () => {
    const { conn } = makeConn()
    await createMcpApiKeyHandler(ctx, conn, {
      type: 'create_mcp_api_key',
      workspaceName: 'ws-beta',
      name: 'ci',
    })
    // The handler decides both: the owner is the connection's verified subject
    // (never the page it was created from), and the initial scope is the full
    // read-only set with no write tool.
    expect(h.created).toEqual({
      name: 'ci',
      workspaceName: 'ws-beta',
      ownerSubject: 'admin',
      tools: READ_TOOLS,
    })
  })

  it('refuses to mint a key when no subject can be resolved', async () => {
    const { conn, sent } = makeConn()
    ;(conn as { subject: string | null }).subject = null
    await createMcpApiKeyHandler(ctx, conn, {
      type: 'create_mcp_api_key',
      workspaceName: 'ws-beta',
      name: 'ci',
    })
    expect(h.created).toBeNull()
    expect(sent).toEqual([{ type: 'error', error: { code: 'auth.adminOnly' } }])
  })

  it('rejects an unknown workspace id and mints nothing', async () => {
    const { conn, sent } = makeConn()
    await createMcpApiKeyHandler(ctx, conn, {
      type: 'create_mcp_api_key',
      workspaceName: 'ws-forged',
      name: 'ci',
    })
    expect(sent).toEqual([
      {
        type: 'error',
        error: { code: 'mcpApiKey.unknownWorkspace', params: { workspaceName: 'ws-forged' } },
      },
    ])
    expect(h.created).toBeNull()
  })

  it('reports a failed write instead of echoing a pseudo-success', async () => {
    h.throwOnWrite = true
    const { conn, sent } = makeConn()
    await createMcpApiKeyHandler(ctx, conn, {
      type: 'create_mcp_api_key',
      workspaceName: 'ws-alpha',
      name: 'ci',
    })
    expect(sent).toEqual([{ type: 'error', error: { code: 'mcpApiKey.saveFailed' } }])
  })
})

describe('update_mcp_api_key', () => {
  it('replaces the tool scope, then tears down that key’s live sessions', () => {
    seed([key()])
    const { conn, sent } = makeConn()
    updateMcpApiKeyHandler(ctx, conn, {
      type: 'update_mcp_api_key',
      workspaceName: 'ws-alpha',
      id: 'key-1',
      tools: ['save_intents'],
    })
    expect(h.updatedTools).toEqual({ id: 'key-1', tools: ['save_intents'] })
    expect(h.closed).toEqual(['key-1'])
    expect((sent[0] as { type: string }).type).toBe('mcp_api_keys')
  })

  it('accepts an explicitly empty scope as "calls nothing"', () => {
    seed([key()])
    const { conn } = makeConn()
    updateMcpApiKeyHandler(ctx, conn, {
      type: 'update_mcp_api_key',
      workspaceName: 'ws-alpha',
      id: 'key-1',
      tools: [],
    })
    expect(h.updatedTools).toEqual({ id: 'key-1', tools: [] })
  })

  it('renames without touching the scope', () => {
    seed([key()])
    const { conn } = makeConn()
    updateMcpApiKeyHandler(ctx, conn, {
      type: 'update_mcp_api_key',
      workspaceName: 'ws-alpha',
      id: 'key-1',
      name: 'release bot',
    })
    expect(h.renamed).toEqual({ id: 'key-1', name: 'release bot' })
    expect(h.updatedTools).toBeNull()
    expect(h.closed).toEqual([])
  })

  it('reports an unknown key id', () => {
    const { conn, sent } = makeConn()
    updateMcpApiKeyHandler(ctx, conn, {
      type: 'update_mcp_api_key',
      workspaceName: 'ws-alpha',
      id: 'ghost',
      tools: [],
    })
    expect(sent).toEqual([
      { type: 'error', error: { code: 'mcpApiKey.unknown', params: { id: 'ghost' } } },
    ])
  })

  it('rejects the whole update when a tool name is outside the catalog', () => {
    seed([key()])
    const { conn, sent } = makeConn()
    updateMcpApiKeyHandler(ctx, conn, {
      type: 'update_mcp_api_key',
      workspaceName: 'ws-alpha',
      id: 'key-1',
      tools: ['save_intents', 'not_a_tool'],
    })
    expect(sent[0]).toMatchObject({
      error: { code: 'mcpApiKey.unknownTool', params: { tool: 'not_a_tool' } },
    })
    expect(h.updatedTools).toBeNull()
    expect(h.closed).toEqual([])
  })

  it('rejects a duplicate tool name whole', () => {
    seed([key()])
    const { conn, sent } = makeConn()
    updateMcpApiKeyHandler(ctx, conn, {
      type: 'update_mcp_api_key',
      workspaceName: 'ws-alpha',
      id: 'key-1',
      tools: ['save_intents', 'save_intents'],
    })
    expect(sent[0]).toMatchObject({ error: { code: 'mcpApiKey.unknownTool' } })
    expect(h.updatedTools).toBeNull()
  })

  it('rejects an unknown workspace id before touching anything', () => {
    seed([key()])
    const { conn, sent } = makeConn()
    updateMcpApiKeyHandler(ctx, conn, {
      type: 'update_mcp_api_key',
      workspaceName: 'ws-forged',
      id: 'key-1',
      tools: [],
    })
    expect(sent[0]).toMatchObject({ error: { code: 'mcpApiKey.unknownWorkspace' } })
    expect(h.updatedTools).toBeNull()
  })

  it('rejects an update when the key belongs to another workspace', () => {
    seed([key({ id: 'key-beta', workspaceName: '/canon/beta' })])
    const { conn, sent } = makeConn()
    updateMcpApiKeyHandler(ctx, conn, {
      type: 'update_mcp_api_key',
      workspaceName: 'ws-alpha',
      id: 'key-beta',
      tools: ['save_intents'],
    })
    expect(sent).toEqual([
      { type: 'error', error: { code: 'mcpApiKey.unknown', params: { id: 'key-beta' } } },
    ])
    expect(h.updatedTools).toBeNull()
    expect(h.records[0].tools).toEqual(READ_TOOLS)
  })

  it('does not partially apply a rename when tools validation fails', () => {
    seed([key()])
    const { conn, sent } = makeConn()
    updateMcpApiKeyHandler(ctx, conn, {
      type: 'update_mcp_api_key',
      workspaceName: 'ws-alpha',
      id: 'key-1',
      name: 'new name',
      tools: ['not_a_tool'],
    })
    expect(sent[0]).toMatchObject({
      error: { code: 'mcpApiKey.unknownTool', params: { tool: 'not_a_tool' } },
    })
    expect(h.renamed).toBeNull()
    expect(h.updatedTools).toBeNull()
    expect(h.records[0].name).toBe('ci')
  })
})

describe('revoke_mcp_api_key', () => {
  it('deletes the record AND tears down that key’s live MCP sessions', () => {
    seed([key(), key({ id: 'key-2', workspaceName: 'ws-alpha' })])
    const { conn, sent } = makeConn()
    revokeMcpApiKeyHandler(ctx, conn, {
      type: 'revoke_mcp_api_key',
      workspaceName: 'ws-alpha',
      id: 'key-1',
    })

    expect(h.revoked).toEqual(['key-1'])
    expect(h.closed).toEqual(['key-1'])
    const msg = sent[0] as Extract<ServerToClient, { type: 'mcp_api_keys' }>
    expect(msg.keys.map((k) => k.id)).toEqual(['key-2'])
  })

  it('reports an unknown id and closes nothing', () => {
    seed([key()])
    const { conn, sent } = makeConn()
    revokeMcpApiKeyHandler(ctx, conn, {
      type: 'revoke_mcp_api_key',
      workspaceName: 'ws-alpha',
      id: 'ghost',
    })
    expect(sent).toEqual([
      { type: 'error', error: { code: 'mcpApiKey.unknown', params: { id: 'ghost' } } },
    ])
    expect(h.closed).toEqual([])
  })

  it('still revokes when no route is wired (unit/embedded server)', () => {
    setExternalMcpSessionCloser(null)
    seed([key()])
    const { conn, sent } = makeConn()
    revokeMcpApiKeyHandler(ctx, conn, {
      type: 'revoke_mcp_api_key',
      workspaceName: 'ws-alpha',
      id: 'key-1',
    })
    expect(h.revoked).toEqual(['key-1'])
    expect((sent[0] as { type: string }).type).toBe('mcp_api_keys')
  })

  it('rejects a revoke when the key belongs to another workspace', () => {
    seed([key({ id: 'key-beta', workspaceName: '/canon/beta' })])
    const { conn, sent } = makeConn()
    revokeMcpApiKeyHandler(ctx, conn, {
      type: 'revoke_mcp_api_key',
      workspaceName: 'ws-alpha',
      id: 'key-beta',
    })
    expect(sent).toEqual([
      { type: 'error', error: { code: 'mcpApiKey.unknown', params: { id: 'key-beta' } } },
    ])
    expect(h.revoked).toEqual([])
    expect(h.records).toHaveLength(1)
    expect(h.closed).toEqual([])
  })
})

/**
 * Self-service. The property under test throughout is that the OWNER is taken
 * from the connection and never from the message — so an administrator has no
 * more power over someone else's key than anyone else, and a forged id discloses
 * nothing.
 */
describe('the self-service key surface', () => {
  function connAs(subject: string | null): { conn: Conn; sent: ServerToClient[] } {
    const c = makeConn()
    ;(c.conn as { subject: string | null }).subject = subject
    return c
  }

  describe('list_my_mcp_api_keys', () => {
    it('returns only the caller’s own keys, with no owner, catalog or hash material', () => {
      seed([
        key({ id: 'mine-1', ownerSubject: 'alice', workspaceName: null }),
        key({ id: 'mine-2', ownerSubject: 'alice', workspaceName: null }),
        key({ id: 'theirs', ownerSubject: 'bob', workspaceName: null }),
      ])
      const { conn, sent } = connAs('alice')
      listMyMcpApiKeysHandler(ctx, conn, { type: 'list_my_mcp_api_keys' })

      const msg = sent[0] as Extract<ServerToClient, { type: 'my_mcp_api_keys' }>
      expect(msg.type).toBe('my_mcp_api_keys')
      expect(msg.keys.map((k) => k.id)).toEqual(['mine-1', 'mine-2'])
      // Bob's key is not merely hidden in the UI — it never crosses the wire.
      expect(JSON.stringify(msg)).not.toContain('theirs')
      expect(JSON.stringify(msg)).not.toContain('ownerSubject')
      expect(JSON.stringify(msg)).not.toContain('salt')
      // No tool catalog: self-service has no scope editor, so shipping the
      // grantable list would only advertise one that does not exist.
      expect((msg as { catalog?: unknown }).catalog).toBeUndefined()
    })

    it('needs no administrator authority', () => {
      h.admin = false
      seed([key({ id: 'mine', ownerSubject: 'alice', workspaceName: null })])
      const { conn, sent } = connAs('alice')
      listMyMcpApiKeysHandler(ctx, conn, { type: 'list_my_mcp_api_keys' })
      expect((sent[0] as { type: string }).type).toBe('my_mcp_api_keys')
    })

    it('refuses a connection with no resolvable identity', () => {
      const { conn, sent } = connAs(null)
      listMyMcpApiKeysHandler(ctx, conn, { type: 'list_my_mcp_api_keys' })
      expect(sent).toEqual([{ type: 'error', error: { code: 'mcpApiKey.noIdentity' } }])
    })
  })

  describe('create_my_mcp_api_key', () => {
    it('files the key under NO workspace, owns it by the connection, and forces the default scope', async () => {
      const { conn, sent } = connAs('alice')
      await createMyMcpApiKeyHandler(ctx, conn, {
        type: 'create_my_mcp_api_key',
        name: 'laptop',
      })
      // `null` is the persisted filing state — not an empty string, not a
      // synthesized workspace name.
      expect(h.created).toEqual({
        name: 'laptop',
        workspaceName: null,
        ownerSubject: 'alice',
        tools: READ_TOOLS,
      })
      const msg = sent[0] as Extract<ServerToClient, { type: 'my_mcp_api_keys' }>
      expect(msg.created?.key).toBe('c3k_key-new_THE-PLAINTEXT')
      expect(msg.created?.meta.workspaceName).toBeNull()
    })

    it('needs no administrator authority, and the plaintext appears exactly once', async () => {
      h.admin = false
      const create = connAs('alice')
      await createMyMcpApiKeyHandler(ctx, create.conn, {
        type: 'create_my_mcp_api_key',
        name: 'laptop',
      })
      expect(h.created?.ownerSubject).toBe('alice')

      const again = connAs('alice')
      listMyMcpApiKeysHandler(ctx, again.conn, { type: 'list_my_mcp_api_keys' })
      expect(JSON.stringify(again.sent)).not.toContain('THE-PLAINTEXT')
    })

    it('mints nothing when no identity resolves', async () => {
      const { conn, sent } = connAs(null)
      await createMyMcpApiKeyHandler(ctx, conn, { type: 'create_my_mcp_api_key', name: 'x' })
      expect(h.created).toBeNull()
      expect(sent).toEqual([{ type: 'error', error: { code: 'mcpApiKey.noIdentity' } }])
    })

    it('reports a failed write instead of echoing a pseudo-success', async () => {
      h.throwOnWrite = true
      const { conn, sent } = connAs('alice')
      await createMyMcpApiKeyHandler(ctx, conn, { type: 'create_my_mcp_api_key', name: 'x' })
      expect(sent).toEqual([{ type: 'error', error: { code: 'mcpApiKey.saveFailed' } }])
    })
  })

  describe('reset_my_mcp_api_key', () => {
    it('keeps the id and bumps the secret version, returns a new plaintext once, and closes that key’s sessions', async () => {
      seed([key({ id: 'mine', ownerSubject: 'alice', workspaceName: null })])
      h.resetSecret = 'c3k_mine_SECOND-PLAINTEXT'
      const { conn, sent } = connAs('alice')
      await resetMyMcpApiKeyHandler(ctx, conn, { type: 'reset_my_mcp_api_key', id: 'mine' })

      expect(h.reset).toEqual(['mine@alice'])
      const msg = sent[0] as Extract<ServerToClient, { type: 'my_mcp_api_keys' }>
      expect(msg.created?.key).toBe('c3k_mine_SECOND-PLAINTEXT')
      // Same key, new secret: the id survives, the version moves.
      expect(msg.created?.meta.id).toBe('mine')
      expect(h.records[0].secretVersion).toBe(2)
      // Persist-first, close-second: the teardown ran only after the store returned.
      expect(h.closed).toEqual(['mine'])
    })

    it('refuses another owner’s id exactly like an unknown one, and mutates nothing', async () => {
      seed([key({ id: 'theirs', ownerSubject: 'bob', workspaceName: null })])
      const foreign = connAs('alice')
      await resetMyMcpApiKeyHandler(ctx, foreign.conn, {
        type: 'reset_my_mcp_api_key',
        id: 'theirs',
      })
      const unknown = connAs('alice')
      await resetMyMcpApiKeyHandler(ctx, unknown.conn, {
        type: 'reset_my_mcp_api_key',
        id: 'ghost',
      })

      // Identical refusals — an id cannot be swept to learn who holds it.
      expect(foreign.sent).toEqual([
        { type: 'error', error: { code: 'mcpApiKey.unknown', params: { id: 'theirs' } } },
      ])
      expect(unknown.sent).toEqual([
        { type: 'error', error: { code: 'mcpApiKey.unknown', params: { id: 'ghost' } } },
      ])
      expect(h.reset).toEqual([])
      expect(h.records[0].secretVersion).toBe(1)
      expect(h.closed).toEqual([])
    })

    it('gives the administrator no power over another owner’s key', async () => {
      h.admin = true
      seed([key({ id: 'theirs', ownerSubject: 'bob', workspaceName: null })])
      const { conn, sent } = connAs('admin')
      await resetMyMcpApiKeyHandler(ctx, conn, { type: 'reset_my_mcp_api_key', id: 'theirs' })
      expect(sent[0]).toMatchObject({ error: { code: 'mcpApiKey.unknown' } })
      expect(h.reset).toEqual([])
    })

    it('still rotates when no route is wired (unit/embedded server)', async () => {
      setExternalMcpSessionCloser(null)
      seed([key({ id: 'mine', ownerSubject: 'alice', workspaceName: null })])
      const { conn, sent } = connAs('alice')
      await resetMyMcpApiKeyHandler(ctx, conn, { type: 'reset_my_mcp_api_key', id: 'mine' })
      expect(h.reset).toEqual(['mine@alice'])
      expect((sent[0] as { type: string }).type).toBe('my_mcp_api_keys')
    })
  })

  describe('revoke_my_mcp_api_key', () => {
    it('deletes only an owned key and tears down its live sessions', () => {
      seed([
        key({ id: 'mine', ownerSubject: 'alice', workspaceName: null }),
        key({ id: 'other', ownerSubject: 'alice', workspaceName: null }),
      ])
      const { conn, sent } = connAs('alice')
      revokeMyMcpApiKeyHandler(ctx, conn, { type: 'revoke_my_mcp_api_key', id: 'mine' })

      expect(h.revoked).toEqual(['mine'])
      expect(h.closed).toEqual(['mine'])
      const msg = sent[0] as Extract<ServerToClient, { type: 'my_mcp_api_keys' }>
      expect(msg.keys.map((k) => k.id)).toEqual(['other'])
      expect(msg.created).toBeUndefined()
    })

    it('refuses another owner’s id, deleting nothing and closing nothing', () => {
      seed([key({ id: 'theirs', ownerSubject: 'bob', workspaceName: null })])
      const { conn, sent } = connAs('alice')
      revokeMyMcpApiKeyHandler(ctx, conn, { type: 'revoke_my_mcp_api_key', id: 'theirs' })
      expect(sent).toEqual([
        { type: 'error', error: { code: 'mcpApiKey.unknown', params: { id: 'theirs' } } },
      ])
      expect(h.revoked).toEqual([])
      expect(h.records).toHaveLength(1)
      expect(h.closed).toEqual([])
    })
  })

  it('keeps a self-service key out of every workspace-addressed roster', () => {
    seed([
      key({ id: 'unfiled', ownerSubject: 'alice', workspaceName: null }),
      key({ id: 'filed', ownerSubject: 'admin', workspaceName: 'ws-alpha' }),
    ])
    const { conn, sent } = makeConn()
    listMcpApiKeysHandler(ctx, conn, { type: 'list_mcp_api_keys', workspaceName: 'ws-alpha' })
    const msg = sent[0] as Extract<ServerToClient, { type: 'mcp_api_keys' }>
    expect(msg.keys.map((k) => k.id)).toEqual(['filed'])
  })
})
