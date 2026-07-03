/**
 * Auth + admin gate for the workspace-registry entry points (workspaceId-identity
 * hardening; WS-R* admin-only add/remove). `add_workspace` is the ONLY message
 * where an absolute path legitimately enters the system — it establishes a new
 * trust root — so it (and its `remove` counterpart) must be refused on an
 * unauthenticated connection AND on any connection that is not the configured
 * admin. Viewing / entering / editing a workspace is deliberately unaffected.
 */
import { describe, it, expect, vi } from 'vitest'
import type { Conn } from '../../transport/handler-registry.js'
import type { ServerToClient, SystemSettings, AuthConfig } from '@ccc/shared/protocol'

const h = vi.hoisted(() => ({
  added: 0,
  removed: 0,
  // The auth block `isAdminConn` reads through `loadSettings()`. Default: no auth
  // (inert admin gate ⇒ every connection trusted) so the existing cases still pass.
  auth: undefined as AuthConfig | undefined,
}))
vi.mock('../../state.js', () => ({
  addWorkspace: vi.fn(() => {
    h.added++
    return '/abs/proj'
  }),
  listWorkspaces: vi.fn(() => []),
  pathToId: vi.fn(() => null),
  resolveWorkspaceRoot: vi.fn(() => '/abs/proj'),
  removeWorkspace: vi.fn(() => {
    h.removed++
  }),
}))
vi.mock('../../runs.js', () => ({
  getRuntime: vi.fn(() => undefined),
  removeRuntimesForWorkspace: vi.fn(),
}))
vi.mock('../schedules/store.js', () => ({ isStoreAvailable: () => false }))
vi.mock('../schedules/archiver.js', () => ({ onWorkspaceRemoved: vi.fn() }))
// `requireAdmin` → `isAdminConn` reads the active auth block off disk.
vi.mock('../../kernel/config/index.js', () => ({
  c3HomeDir: () => '/tmp/c3-workspace-test',
  loadSettings: () => ({ auth: h.auth }) as SystemSettings,
}))

import { addWorkspaceHandler, removeWorkspaceHandler } from './index.js'

const SESSION = { ttlSeconds: 3600, signingKeyRef: 'k' }
/** A `basic` provider with `admin` as the unique admin and an `alice` member. */
function basicAuth(admin: string): AuthConfig {
  return {
    enabled: true,
    provider: {
      kind: 'basic',
      accounts: [
        { username: admin, passwordHash: 'h' },
        { username: 'alice', passwordHash: 'h' },
      ],
      adminUsername: admin,
    },
    session: SESSION,
  }
}

function capture(
  authed: boolean,
  subject: string | null = null,
): { conn: Conn; sent: ServerToClient[] } {
  const sent: ServerToClient[] = []
  const conn: Conn = {
    send: (m) => sent.push(m),
    viewing: null,
    deliver: () => {},
    sendWorkspaces: () => {},
    sendSessions: async () => {},
    authed,
    authToken: authed ? 'tok' : null,
    subject,
  }
  return { conn, sent }
}

const KCTX = { broadcastStatuses: () => {} } as never

describe('workspace registry auth gate', () => {
  it('refuses add_workspace on an unauthenticated connection', async () => {
    h.added = 0
    h.auth = undefined
    const { conn, sent } = capture(false)
    await addWorkspaceHandler(KCTX, conn, { type: 'add_workspace', path: '/abs/proj' })
    expect(sent[0]).toEqual({ type: 'unauthenticated', reason: 'missing' })
    expect(h.added).toBe(0) // never reached the registry
  })

  it('refuses remove_workspace on an unauthenticated connection', () => {
    h.removed = 0
    h.auth = undefined
    const { conn, sent } = capture(false)
    removeWorkspaceHandler(KCTX, conn, { type: 'remove_workspace', workspaceId: 'ws-1' })
    expect(sent[0]).toEqual({ type: 'unauthenticated', reason: 'missing' })
    expect(h.removed).toBe(0)
  })

  it('admits add_workspace on an authenticated connection (inert admin gate)', async () => {
    h.added = 0
    h.auth = undefined // no admin gate applies ⇒ loopback trust
    const { conn, sent } = capture(true)
    await addWorkspaceHandler(KCTX, conn, { type: 'add_workspace', path: '/abs/proj' })
    expect(sent.some((m) => m.type === 'unauthenticated')).toBe(false)
    expect(h.added).toBe(1)
  })
})

describe('workspace registry admin gate (WS-R*)', () => {
  it('admits add_workspace for the configured admin', async () => {
    h.added = 0
    h.auth = basicAuth('admin')
    const { conn, sent } = capture(true, 'admin')
    await addWorkspaceHandler(KCTX, conn, { type: 'add_workspace', path: '/abs/proj' })
    expect(sent.some((m) => m.type === 'error')).toBe(false)
    expect(h.added).toBe(1)
  })

  it('admits remove_workspace for the configured admin', () => {
    h.removed = 0
    h.auth = basicAuth('admin')
    const { conn, sent } = capture(true, 'admin')
    removeWorkspaceHandler(KCTX, conn, { type: 'remove_workspace', workspaceId: 'ws-1' })
    expect(sent.some((m) => m.type === 'error')).toBe(false)
    expect(h.removed).toBe(1)
  })

  it('refuses add_workspace for a non-admin member with auth.adminOnly', async () => {
    h.added = 0
    h.auth = basicAuth('admin')
    const { conn, sent } = capture(true, 'alice')
    await addWorkspaceHandler(KCTX, conn, { type: 'add_workspace', path: '/abs/proj' })
    expect(sent[0]).toEqual({ type: 'error', error: { code: 'auth.adminOnly' } })
    expect(h.added).toBe(0) // never reached the registry
  })

  it('refuses remove_workspace for a non-admin member with auth.adminOnly', () => {
    h.removed = 0
    h.auth = basicAuth('admin')
    const { conn, sent } = capture(true, 'alice')
    removeWorkspaceHandler(KCTX, conn, { type: 'remove_workspace', workspaceId: 'ws-1' })
    expect(sent[0]).toEqual({ type: 'error', error: { code: 'auth.adminOnly' } })
    expect(h.removed).toBe(0)
  })
})
