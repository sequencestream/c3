/**
 * The admin-gated key-management handlers. The store and the workspace registry
 * are stubbed — persistence has its own tests in
 * `kernel/config/mcp-api-keys.test.ts` — so what is asserted here is exactly what
 * these handlers own: the administrator gate, the id ⇄ path translation, the
 * all-or-nothing grant rule, the single appearance of the plaintext, and the
 * revocation reaching live sessions.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ServerToClient } from '@ccc/shared/protocol'
import type { Conn } from '../../transport/handler-registry.js'
import type { KernelContext } from '../../kernel/types.js'
import type { McpApiKeyInfo } from '../../kernel/config/mcp-api-keys.js'

const h = vi.hoisted(() => ({
  admin: true,
  records: [] as McpApiKeyInfo[],
  created: null as { name: string; workspaces: string[] } | null,
  updatedWorkspaces: null as { id: string; workspaces: string[] } | null,
  renamed: null as { id: string; name: string } | null,
  revoked: [] as string[],
  closed: [] as string[],
  throwOnWrite: false,
  /** Registered workspaces: id → canonical path. */
  registry: new Map<string, string>([
    ['ws-alpha', '/canon/alpha'],
    ['ws-beta', '/canon/beta'],
  ]),
}))

vi.mock('../auth/authz.js', () => ({
  requireAdmin: (conn: Conn) => {
    if (h.admin) return true
    conn.send({ type: 'error', error: { code: 'auth.adminOnly' } })
    return false
  },
}))

vi.mock('../../kernel/config/mcp-api-keys.js', () => ({
  listMcpApiKeys: () => h.records,
  createMcpApiKey: async (name: string, workspaces: string[]) => {
    if (h.throwOnWrite) throw new Error('disk full')
    h.created = { name, workspaces: [...workspaces] }
    const meta: McpApiKeyInfo = {
      id: 'key-new',
      name,
      createdAt: 10,
      lastUsedAt: null,
      workspaces: [...workspaces],
      displayPrefix: 'c3k_key-new',
    }
    h.records = [...h.records, meta]
    return { meta, key: 'c3k_key-new_THE-PLAINTEXT' }
  },
  updateMcpApiKeyWorkspaces: (id: string, workspaces: string[]) => {
    const rec = h.records.find((r) => r.id === id)
    if (!rec) return null
    h.updatedWorkspaces = { id, workspaces: [...workspaces] }
    rec.workspaces = [...workspaces]
    return rec
  },
  renameMcpApiKey: (id: string, name: string) => {
    const rec = h.records.find((r) => r.id === id)
    if (!rec) return null
    h.renamed = { id, name }
    rec.name = name
    return rec
  },
  revokeMcpApiKey: (id: string) => {
    const idx = h.records.findIndex((r) => r.id === id)
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
}))

const {
  createMcpApiKeyHandler,
  listMcpApiKeysHandler,
  revokeMcpApiKeyHandler,
  setExternalMcpRevocationHook,
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
  return {
    id: 'key-1',
    name: 'ci',
    createdAt: 1,
    lastUsedAt: null,
    workspaces: ['/canon/alpha'],
    displayPrefix: 'c3k_key-1',
    ...over,
  }
}

beforeEach(() => {
  h.admin = true
  h.records = []
  h.created = null
  h.updatedWorkspaces = null
  h.renamed = null
  h.revoked = []
  h.closed = []
  h.throwOnWrite = false
  setExternalMcpRevocationHook((id) => h.closed.push(id))
})

describe('the administrator gate', () => {
  it('refuses every operation for a non-admin, and mutates nothing', async () => {
    h.admin = false
    seed([key()])

    const list = makeConn()
    listMcpApiKeysHandler(ctx, list.conn, { type: 'list_mcp_api_keys' })

    const create = makeConn()
    await createMcpApiKeyHandler(ctx, create.conn, {
      type: 'create_mcp_api_key',
      name: 'x',
      workspaceIds: ['ws-alpha'],
    })

    const update = makeConn()
    updateMcpApiKeyHandler(ctx, update.conn, {
      type: 'update_mcp_api_key',
      id: 'key-1',
      workspaceIds: [],
    })

    const revoke = makeConn()
    revokeMcpApiKeyHandler(ctx, revoke.conn, { type: 'revoke_mcp_api_key', id: 'key-1' })

    for (const { sent } of [list, create, update, revoke]) {
      expect(sent).toEqual([{ type: 'error', error: { code: 'auth.adminOnly' } }])
    }
    expect(h.created).toBeNull()
    expect(h.updatedWorkspaces).toBeNull()
    expect(h.revoked).toEqual([])
    expect(h.records).toHaveLength(1)
  })
})

describe('list_mcp_api_keys', () => {
  it('translates authorized paths to workspace ids and carries no hash material', () => {
    seed([key({ workspaces: ['/canon/alpha', '/canon/beta'] })])
    const { conn, sent } = makeConn()
    listMcpApiKeysHandler(ctx, conn, { type: 'list_mcp_api_keys' })

    expect(sent).toEqual([
      {
        type: 'mcp_api_keys',
        keys: [
          {
            id: 'key-1',
            name: 'ci',
            createdAt: 1,
            lastUsedAt: null,
            workspaceIds: ['ws-alpha', 'ws-beta'],
            staleWorkspaces: [],
            displayPrefix: 'c3k_key-1',
          },
        ],
      },
    ])
  })

  it('surfaces a grant whose workspace c3 no longer has, without pretending it works', () => {
    seed([key({ workspaces: ['/canon/alpha', '/canon/removed'] })])
    const { conn, sent } = makeConn()
    listMcpApiKeysHandler(ctx, conn, { type: 'list_mcp_api_keys' })
    const [msg] = sent as [Extract<ServerToClient, { type: 'mcp_api_keys' }>]
    expect(msg.keys[0].workspaceIds).toEqual(['ws-alpha'])
    expect(msg.keys[0].staleWorkspaces).toEqual(['/canon/removed'])
  })

  it('never includes a plaintext key on a plain list', () => {
    seed([key()])
    const { conn, sent } = makeConn()
    listMcpApiKeysHandler(ctx, conn, { type: 'list_mcp_api_keys' })
    expect((sent[0] as { created?: unknown }).created).toBeUndefined()
  })
})

describe('create_mcp_api_key', () => {
  it('returns the plaintext exactly once, alongside the refreshed roster', async () => {
    const { conn, sent } = makeConn()
    await createMcpApiKeyHandler(ctx, conn, {
      type: 'create_mcp_api_key',
      name: 'ci bot',
      workspaceIds: ['ws-alpha'],
    })

    const msg = sent[0] as Extract<ServerToClient, { type: 'mcp_api_keys' }>
    expect(msg.type).toBe('mcp_api_keys')
    expect(msg.created?.key).toBe('c3k_key-new_THE-PLAINTEXT')
    expect(msg.created?.meta.workspaceIds).toEqual(['ws-alpha'])
    expect(msg.keys).toHaveLength(1)

    // A subsequent list carries no plaintext — it existed only in that one reply.
    const again = makeConn()
    listMcpApiKeysHandler(ctx, again.conn, { type: 'list_mcp_api_keys' })
    expect(JSON.stringify(again.sent)).not.toContain('THE-PLAINTEXT')
  })

  it('stores the canonical PATHS resolved from the ids, not the ids', async () => {
    const { conn } = makeConn()
    await createMcpApiKeyHandler(ctx, conn, {
      type: 'create_mcp_api_key',
      name: 'ci',
      workspaceIds: ['ws-beta', 'ws-alpha'],
    })
    expect(h.created).toEqual({ name: 'ci', workspaces: ['/canon/beta', '/canon/alpha'] })
  })

  it('refuses a key with no workspace at all', async () => {
    const { conn, sent } = makeConn()
    await createMcpApiKeyHandler(ctx, conn, {
      type: 'create_mcp_api_key',
      name: 'ci',
      workspaceIds: [],
    })
    expect(sent).toEqual([{ type: 'error', error: { code: 'mcpApiKey.noWorkspace' } }])
    expect(h.created).toBeNull()
  })

  it('rejects the whole grant when one workspace id is unknown', async () => {
    const { conn, sent } = makeConn()
    await createMcpApiKeyHandler(ctx, conn, {
      type: 'create_mcp_api_key',
      name: 'ci',
      workspaceIds: ['ws-alpha', 'ws-forged'],
    })
    expect(sent).toEqual([
      {
        type: 'error',
        error: { code: 'mcpApiKey.unknownWorkspace', params: { workspaceId: 'ws-forged' } },
      },
    ])
    // Nothing partially applied — no key exists with just the valid half.
    expect(h.created).toBeNull()
  })

  it('reports a failed write instead of echoing a pseudo-success', async () => {
    h.throwOnWrite = true
    const { conn, sent } = makeConn()
    await createMcpApiKeyHandler(ctx, conn, {
      type: 'create_mcp_api_key',
      name: 'ci',
      workspaceIds: ['ws-alpha'],
    })
    expect(sent).toEqual([{ type: 'error', error: { code: 'mcpApiKey.saveFailed' } }])
  })
})

describe('update_mcp_api_key', () => {
  it('replaces the grant with the resolved paths', () => {
    seed([key()])
    const { conn, sent } = makeConn()
    updateMcpApiKeyHandler(ctx, conn, {
      type: 'update_mcp_api_key',
      id: 'key-1',
      workspaceIds: ['ws-beta'],
    })
    expect(h.updatedWorkspaces).toEqual({ id: 'key-1', workspaces: ['/canon/beta'] })
    expect((sent[0] as { type: string }).type).toBe('mcp_api_keys')
  })

  it('accepts an explicitly empty grant as "reaches nothing"', () => {
    seed([key()])
    const { conn } = makeConn()
    updateMcpApiKeyHandler(ctx, conn, {
      type: 'update_mcp_api_key',
      id: 'key-1',
      workspaceIds: [],
    })
    expect(h.updatedWorkspaces).toEqual({ id: 'key-1', workspaces: [] })
  })

  it('renames without touching the grant', () => {
    seed([key()])
    const { conn } = makeConn()
    updateMcpApiKeyHandler(ctx, conn, {
      type: 'update_mcp_api_key',
      id: 'key-1',
      name: 'release bot',
    })
    expect(h.renamed).toEqual({ id: 'key-1', name: 'release bot' })
    expect(h.updatedWorkspaces).toBeNull()
  })

  it('reports an unknown key id', () => {
    const { conn, sent } = makeConn()
    updateMcpApiKeyHandler(ctx, conn, {
      type: 'update_mcp_api_key',
      id: 'ghost',
      workspaceIds: ['ws-alpha'],
    })
    expect(sent).toEqual([
      { type: 'error', error: { code: 'mcpApiKey.unknown', params: { id: 'ghost' } } },
    ])
  })

  it('rejects the whole update when a workspace id is unknown', () => {
    seed([key()])
    const { conn, sent } = makeConn()
    updateMcpApiKeyHandler(ctx, conn, {
      type: 'update_mcp_api_key',
      id: 'key-1',
      workspaceIds: ['ws-forged'],
    })
    expect(sent[0]).toMatchObject({ error: { code: 'mcpApiKey.unknownWorkspace' } })
    expect(h.updatedWorkspaces).toBeNull()
  })
})

describe('revoke_mcp_api_key', () => {
  it('deletes the record AND tears down that key’s live MCP sessions', () => {
    seed([key(), key({ id: 'key-2' })])
    const { conn, sent } = makeConn()
    revokeMcpApiKeyHandler(ctx, conn, { type: 'revoke_mcp_api_key', id: 'key-1' })

    expect(h.revoked).toEqual(['key-1'])
    expect(h.closed).toEqual(['key-1'])
    const msg = sent[0] as Extract<ServerToClient, { type: 'mcp_api_keys' }>
    expect(msg.keys.map((k) => k.id)).toEqual(['key-2'])
  })

  it('reports an unknown id and closes nothing', () => {
    seed([key()])
    const { conn, sent } = makeConn()
    revokeMcpApiKeyHandler(ctx, conn, { type: 'revoke_mcp_api_key', id: 'ghost' })
    expect(sent).toEqual([
      { type: 'error', error: { code: 'mcpApiKey.unknown', params: { id: 'ghost' } } },
    ])
    expect(h.closed).toEqual([])
  })

  it('still revokes when no route is wired (unit/embedded server)', () => {
    setExternalMcpRevocationHook(null)
    seed([key()])
    const { conn, sent } = makeConn()
    revokeMcpApiKeyHandler(ctx, conn, { type: 'revoke_mcp_api_key', id: 'key-1' })
    expect(h.revoked).toEqual(['key-1'])
    expect((sent[0] as { type: string }).type).toBe('mcp_api_keys')
  })
})
