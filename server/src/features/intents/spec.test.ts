/**
 * `approve_spec` handler — the human approval checkpoint. Verifies against the
 * real store that approving lands `spec_approved=true` + the current login
 * subject in `spec_approve_user` and broadcasts, and that approving an intent
 * with no authored spec is rejected (the defensive server guard behind the UI).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ServerToClient } from '@ccc/shared/protocol'
import type { Conn } from '../../transport/handler-registry.js'
import type { KernelContext } from '../../kernel/types.js'
import { resetDbForTests } from '../../kernel/infra/db.js'
import {
  addWorkspace,
  pathToId,
  resetStateCacheForTests,
  resolveWorkspaceRoot,
} from '../../state.js'
import { getIntent, insertIntents, resetStoreForTests, setSpecPath } from './store.js'
import { approveSpecHandler } from './spec.js'

let dir: string
let workspaceId: string
let proj: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'c3-approve-spec-'))
  process.env.CLAUDE_CONFIG_DIR = dir
  process.env.C3_DB_PATH = join(dir, 'c3.db')
  resetDbForTests()
  resetStoreForTests()
  resetStateCacheForTests()
  addWorkspace(dir, 1)
  workspaceId = pathToId(dir)!
  proj = resolveWorkspaceRoot(workspaceId)!
})

afterEach(() => {
  resetDbForTests()
  resetStateCacheForTests()
  delete process.env.CLAUDE_CONFIG_DIR
  delete process.env.C3_DB_PATH
  rmSync(dir, { recursive: true, force: true })
})

function fakeConn(over: Partial<Conn> = {}): { conn: Conn; sent: ServerToClient[] } {
  const sent: ServerToClient[] = []
  const conn = {
    send: (m: ServerToClient) => sent.push(m),
    subject: 'alice',
    authed: true,
    authToken: null,
    viewing: null,
    deliver: () => {},
    sendWorkspaces: () => {},
    sendSessions: async () => {},
    ...over,
  } as Conn
  return { conn, sent }
}

describe('approveSpecHandler', () => {
  it('approves: sets spec_approved=true + records the current subject, then broadcasts', () => {
    const [r] = insertIntents(proj, [
      { title: 'Cached endpoint', shortEnTitle: 'cache', content: '', priority: 'P1' },
    ])
    setSpecPath(r.id, '.specs/2026/06/18/2026-06-18-001-cache/spec.md')

    const broadcastIntents = vi.fn()
    const ctx = { broadcastIntents } as unknown as KernelContext
    const { conn, sent } = fakeConn({ subject: 'bob' })

    approveSpecHandler(ctx, conn, { type: 'approve_spec', workspaceId, intentId: r.id })

    const got = getIntent(r.id)
    expect(got?.specApproved).toBe(true)
    expect(got?.specApproveUser).toBe('bob')
    expect(broadcastIntents).toHaveBeenCalledWith(proj)
    expect(sent).toEqual([])
  })

  it('rejects approving an intent whose spec was never written (no specPath)', () => {
    const [r] = insertIntents(proj, [
      { title: 'No spec yet', shortEnTitle: 'nospec', content: '', priority: 'P2' },
    ])

    const broadcastIntents = vi.fn()
    const ctx = { broadcastIntents } as unknown as KernelContext
    const { conn, sent } = fakeConn()

    approveSpecHandler(ctx, conn, { type: 'approve_spec', workspaceId, intentId: r.id })

    expect(getIntent(r.id)?.specApproved).toBe(false)
    expect(broadcastIntents).not.toHaveBeenCalled()
    expect(sent).toEqual([{ type: 'error', error: { code: 'intent.specNotWritten' } }])
  })

  it('rejects an unknown intent id', () => {
    const broadcastIntents = vi.fn()
    const ctx = { broadcastIntents } as unknown as KernelContext
    const { conn, sent } = fakeConn()

    approveSpecHandler(ctx, conn, { type: 'approve_spec', workspaceId, intentId: 'nope' })

    expect(broadcastIntents).not.toHaveBeenCalled()
    expect(sent).toEqual([{ type: 'error', error: { code: 'intent.notFound' } }])
  })
})
