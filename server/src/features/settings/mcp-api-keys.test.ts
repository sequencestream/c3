/**
 * The admin-gated key-management handlers. The store and the workspace registry
 * are stubbed — persistence has its own tests in
 * `kernel/config/mcp-api-keys.test.ts` — so what is asserted here is exactly what
 * these handlers own: the administrator gate, the id ⇄ path translation, the
 * server-decided initial scope, the all-or-nothing tool-scope rule, the single
 * appearance of the plaintext, and revocation/re-scoping reaching live sessions.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ServerToClient } from '@ccc/shared/protocol'
import type { Conn } from '../../transport/handler-registry.js'
import type { KernelContext } from '../../kernel/types.js'
import type { McpApiKeyInfo } from '../../kernel/config/mcp-api-keys.js'

const READ_TOOLS = [
  'find_intents',
  'view_intent',
  'find_discussions',
  'view_discussion',
  'publish_event',
]

const h = vi.hoisted(() => ({
  admin: true,
  records: [] as McpApiKeyInfo[],
  created: null as { name: string; workspace: string; tools: string[] } | null,
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
  listMcpApiKeysForWorkspace: (workspace: string) =>
    h.records.filter((r) => r.workspace === workspace),
  createMcpApiKey: async (name: string, workspace: string, tools: string[]) => {
    if (h.throwOnWrite) throw new Error('disk full')
    h.created = { name, workspace, tools: [...tools] }
    const meta: McpApiKeyInfo = {
      id: 'key-new',
      name,
      createdAt: 10,
      lastUsedAt: null,
      workspace,
      tools: [...tools],
      displayPrefix: 'c3k_key-new',
    }
    h.records = [...h.records, meta]
    return { meta, key: 'c3k_key-new_THE-PLAINTEXT' }
  },
  updateMcpApiKeyInWorkspace: (
    id: string,
    workspace: string,
    patch: { name?: string; tools?: string[] },
  ) => {
    const rec = h.records.find((r) => r.id === id && r.workspace === workspace)
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
  revokeMcpApiKeyInWorkspace: (id: string, workspace: string) => {
    const idx = h.records.findIndex((r) => r.id === id && r.workspace === workspace)
    if (idx < 0) return false
    h.revoked.push(id)
    h.records = h.records.filter((r) => r.id !== id)
    return true
  },
}))

vi.mock('../external-mcp/workspace-scope.js', () => ({
  workspaceIdToCanonicalPath: (id: string) => h.registry.get(id) ?? null,
  canonicalPathToWorkspaceId: (path: string) =>
    [...h.registry.entries()].find(([, p]) => p === path)?.[0] ?? null,
  resolveRegisteredWorkspacePath: (path: string) =>
    [...h.registry.values()].includes(path) && !h.goneDirs.has(path) ? path : null,
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
  listMcpApiKeysHandler,
  revokeMcpApiKeyHandler,
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
    workspace: '/canon/alpha',
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
  h.throwOnWrite = false
  h.goneDirs.clear()
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
    listMcpApiKeysHandler(ctx, list.conn, { type: 'list_mcp_api_keys', workspaceId: 'ws-alpha' })
    expect(list.sent[0]).toMatchObject({ type: 'mcp_api_keys' })

    const create = makeConn()
    await createMcpApiKeyHandler(ctx, create.conn, {
      type: 'create_mcp_api_key',
      workspaceId: 'ws-alpha',
      name: 'x',
    })

    const update = makeConn()
    updateMcpApiKeyHandler(ctx, update.conn, {
      type: 'update_mcp_api_key',
      workspaceId: 'ws-alpha',
      id: 'key-1',
      tools: [],
    })

    const revoke = makeConn()
    revokeMcpApiKeyHandler(ctx, revoke.conn, {
      type: 'revoke_mcp_api_key',
      workspaceId: 'ws-alpha',
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
      key({ id: 'key-a', workspace: '/canon/alpha' }),
      key({ id: 'key-b', workspace: '/canon/beta' }),
    ])
    const { conn, sent } = makeConn()
    listMcpApiKeysHandler(ctx, conn, { type: 'list_mcp_api_keys', workspaceId: 'ws-alpha' })

    const msg = sent[0] as Extract<ServerToClient, { type: 'mcp_api_keys' }>
    expect(msg.workspaceId).toBe('ws-alpha')
    expect(msg.keys.map((k) => k.id)).toEqual(['key-a'])
    expect(msg.keys[0]).toEqual({
      id: 'key-a',
      name: 'ci',
      createdAt: 1,
      lastUsedAt: null,
      workspaceId: 'ws-alpha',
      unavailable: false,
      tools: [...READ_TOOLS],
      displayPrefix: 'c3k_key-a',
    })
    expect(msg.catalog.length).toBeGreaterThan(0)
    expect(JSON.stringify(msg)).not.toContain('salt')
    expect((msg as { created?: unknown }).created).toBeUndefined()
  })

  it('marks a key unavailable when its workspace directory is gone, without disclosing the path', () => {
    seed([key()])
    h.goneDirs.add('/canon/alpha')
    const { conn, sent } = makeConn()
    listMcpApiKeysHandler(ctx, conn, { type: 'list_mcp_api_keys', workspaceId: 'ws-alpha' })
    const msg = sent[0] as Extract<ServerToClient, { type: 'mcp_api_keys' }>
    expect(msg.keys[0].workspaceId).toBe('ws-alpha')
    expect(msg.keys[0].unavailable).toBe(true)
    // The path stays server-side.
    expect(JSON.stringify(msg)).not.toContain('/canon/alpha')
  })

  it('rejects an unknown workspace id outright', () => {
    const { conn, sent } = makeConn()
    listMcpApiKeysHandler(ctx, conn, { type: 'list_mcp_api_keys', workspaceId: 'ws-forged' })
    expect(sent).toEqual([
      {
        type: 'error',
        error: { code: 'mcpApiKey.unknownWorkspace', params: { workspaceId: 'ws-forged' } },
      },
    ])
  })
})

describe('create_mcp_api_key', () => {
  it('returns the plaintext exactly once, alongside the refreshed roster', async () => {
    const { conn, sent } = makeConn()
    await createMcpApiKeyHandler(ctx, conn, {
      type: 'create_mcp_api_key',
      workspaceId: 'ws-alpha',
      name: 'ci bot',
    })

    const msg = sent[0] as Extract<ServerToClient, { type: 'mcp_api_keys' }>
    expect(msg.type).toBe('mcp_api_keys')
    expect(msg.created?.key).toBe('c3k_key-new_THE-PLAINTEXT')
    expect(msg.created?.meta.workspaceId).toBe('ws-alpha')
    expect(msg.keys).toHaveLength(1)

    // A subsequent list carries no plaintext — it existed only in that one reply.
    const again = makeConn()
    listMcpApiKeysHandler(ctx, again.conn, { type: 'list_mcp_api_keys', workspaceId: 'ws-alpha' })
    expect(JSON.stringify(again.sent)).not.toContain('THE-PLAINTEXT')
  })

  it('binds the resolved canonical path, NOT the id, and forces the read-only scope', async () => {
    const { conn } = makeConn()
    await createMcpApiKeyHandler(ctx, conn, {
      type: 'create_mcp_api_key',
      workspaceId: 'ws-beta',
      name: 'ci',
    })
    // The handler decides the initial scope: full read-only set, no write tool.
    expect(h.created).toEqual({ name: 'ci', workspace: '/canon/beta', tools: READ_TOOLS })
  })

  it('rejects an unknown workspace id and mints nothing', async () => {
    const { conn, sent } = makeConn()
    await createMcpApiKeyHandler(ctx, conn, {
      type: 'create_mcp_api_key',
      workspaceId: 'ws-forged',
      name: 'ci',
    })
    expect(sent).toEqual([
      {
        type: 'error',
        error: { code: 'mcpApiKey.unknownWorkspace', params: { workspaceId: 'ws-forged' } },
      },
    ])
    expect(h.created).toBeNull()
  })

  it('reports a failed write instead of echoing a pseudo-success', async () => {
    h.throwOnWrite = true
    const { conn, sent } = makeConn()
    await createMcpApiKeyHandler(ctx, conn, {
      type: 'create_mcp_api_key',
      workspaceId: 'ws-alpha',
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
      workspaceId: 'ws-alpha',
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
      workspaceId: 'ws-alpha',
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
      workspaceId: 'ws-alpha',
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
      workspaceId: 'ws-alpha',
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
      workspaceId: 'ws-alpha',
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
      workspaceId: 'ws-alpha',
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
      workspaceId: 'ws-forged',
      id: 'key-1',
      tools: [],
    })
    expect(sent[0]).toMatchObject({ error: { code: 'mcpApiKey.unknownWorkspace' } })
    expect(h.updatedTools).toBeNull()
  })

  it('rejects an update when the key belongs to another workspace', () => {
    seed([key({ id: 'key-beta', workspace: '/canon/beta' })])
    const { conn, sent } = makeConn()
    updateMcpApiKeyHandler(ctx, conn, {
      type: 'update_mcp_api_key',
      workspaceId: 'ws-alpha',
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
      workspaceId: 'ws-alpha',
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
    seed([key(), key({ id: 'key-2', workspace: '/canon/alpha' })])
    const { conn, sent } = makeConn()
    revokeMcpApiKeyHandler(ctx, conn, {
      type: 'revoke_mcp_api_key',
      workspaceId: 'ws-alpha',
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
      workspaceId: 'ws-alpha',
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
      workspaceId: 'ws-alpha',
      id: 'key-1',
    })
    expect(h.revoked).toEqual(['key-1'])
    expect((sent[0] as { type: string }).type).toBe('mcp_api_keys')
  })

  it('rejects a revoke when the key belongs to another workspace', () => {
    seed([key({ id: 'key-beta', workspace: '/canon/beta' })])
    const { conn, sent } = makeConn()
    revokeMcpApiKeyHandler(ctx, conn, {
      type: 'revoke_mcp_api_key',
      workspaceId: 'ws-alpha',
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
