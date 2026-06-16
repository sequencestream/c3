/**
 * Auth gate for the workspace-registry entry points (workspaceId-identity
 * hardening). `add_workspace` is the ONLY message where an absolute path
 * legitimately enters the system — it establishes a new trust root — so it (and
 * its `remove` counterpart) must be refused on an unauthenticated connection.
 */
import { describe, it, expect, vi } from 'vitest'
import type { Conn } from '../../transport/handler-registry.js'
import type { ServerToClient } from '@ccc/shared/protocol'

const h = vi.hoisted(() => ({ added: 0, removed: 0 }))
vi.mock('../../state.js', () => ({
  addWorkspace: vi.fn(() => {
    h.added++
    return '/abs/proj'
  }),
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

import { addWorkspaceHandler, removeWorkspaceHandler } from './index.js'

function capture(authed: boolean): { conn: Conn; sent: ServerToClient[] } {
  const sent: ServerToClient[] = []
  const conn: Conn = {
    send: (m) => sent.push(m),
    viewing: null,
    deliver: () => {},
    sendWorkspaces: () => {},
    sendSessions: async () => {},
    authed,
    authToken: authed ? 'tok' : null,
    subject: null,
  }
  return { conn, sent }
}

const KCTX = { broadcastStatuses: () => {} } as never

describe('workspace registry auth gate', () => {
  it('refuses add_workspace on an unauthenticated connection', async () => {
    h.added = 0
    const { conn, sent } = capture(false)
    await addWorkspaceHandler(KCTX, conn, { type: 'add_workspace', path: '/abs/proj' })
    expect(sent[0]).toEqual({ type: 'unauthenticated', reason: 'missing' })
    expect(h.added).toBe(0) // never reached the registry
  })

  it('refuses remove_workspace on an unauthenticated connection', () => {
    h.removed = 0
    const { conn, sent } = capture(false)
    removeWorkspaceHandler(KCTX, conn, { type: 'remove_workspace', path: '/abs/proj' })
    expect(sent[0]).toEqual({ type: 'unauthenticated', reason: 'missing' })
    expect(h.removed).toBe(0)
  })

  it('admits add_workspace on an authenticated connection', async () => {
    h.added = 0
    const { conn, sent } = capture(true)
    await addWorkspaceHandler(KCTX, conn, { type: 'add_workspace', path: '/abs/proj' })
    expect(sent.some((m) => m.type === 'unauthenticated')).toBe(false)
    expect(h.added).toBe(1)
  })
})
