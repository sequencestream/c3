/**
 * `set_intent_spec_mode` handler — the per-intent spec-mode override write.
 *  - explicit `sdd` / `fast`: persisted to `spec_mode` and broadcast.
 *  - explicit `null`: clears the override back to workspace inheritance.
 *  - never touches `spec_status` / `spec_approved`: switching to fast does not
 *    revoke an approved spec, switching to sdd does not fabricate a pending one.
 *  - unknown intent: `intent.notFound`, nothing written, no broadcast.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ServerToClient } from '@ccc/shared/protocol'
import type { Conn } from '../../transport/handler-registry.js'
import type { KernelContext } from '../../kernel/types.js'
import { resetDbForTests } from '../../kernel/infra/db.js'
import { resetSettingsCacheForTests } from '../../kernel/config/index.js'
import {
  addWorkspace,
  pathToId,
  resetStateCacheForTests,
  resolveWorkspaceRoot,
} from '../../state.js'
import {
  getIntent,
  insertIntents,
  resetStoreForTests,
  setSpecApproved,
  setSpecPath,
} from './store.js'
import { setIntentSpecMode } from './index.js'
import { resetStoreForTests as resetSessionMetadataStoreForTests } from '../sessions/session-metadata-store.js'

let dir: string
let prevC3Dir: string | undefined
let proj: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'c3-intent-spec-mode-'))
  process.env.CLAUDE_CONFIG_DIR = dir
  process.env.C3_DB_PATH = join(dir, 'c3.db')
  prevC3Dir = process.env.C3_DIR
  process.env.C3_DIR = join(dir, 'c3home')
  resetDbForTests()
  resetStoreForTests()
  resetSessionMetadataStoreForTests()
  resetStateCacheForTests()
  resetSettingsCacheForTests()
  addWorkspace(dir, 1)
  proj = resolveWorkspaceRoot(pathToId(dir)!)!
})

afterEach(() => {
  resetDbForTests()
  resetSessionMetadataStoreForTests()
  resetStateCacheForTests()
  resetSettingsCacheForTests()
  delete process.env.CLAUDE_CONFIG_DIR
  delete process.env.C3_DB_PATH
  if (prevC3Dir === undefined) delete process.env.C3_DIR
  else process.env.C3_DIR = prevC3Dir
  rmSync(dir, { recursive: true, force: true })
})

function fakeConn(): { conn: Conn; sent: ServerToClient[] } {
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
  } as unknown as Conn
  return { conn, sent }
}

function fakeCtx(): { ctx: KernelContext; broadcastIntents: ReturnType<typeof vi.fn> } {
  const broadcastIntents = vi.fn()
  return { ctx: { broadcastIntents } as unknown as KernelContext, broadcastIntents }
}

function newIntent(): string {
  const [r] = insertIntents(proj, [{ title: 'T', shortEnTitle: 't', content: 'x', priority: 'P1' }])
  return r.id
}

describe('set_intent_spec_mode — override write + broadcast', () => {
  it('persists an explicit fast override and broadcasts', () => {
    const id = newIntent()
    const { ctx, broadcastIntents } = fakeCtx()
    const { conn, sent } = fakeConn()
    setIntentSpecMode(ctx, conn, { type: 'set_intent_spec_mode', intentId: id, mode: 'fast' })
    expect(getIntent(id)!.specMode).toBe('fast')
    expect(broadcastIntents).toHaveBeenCalledWith(proj)
    expect(sent).toEqual([])
  })

  it('persists an explicit sdd override', () => {
    const id = newIntent()
    const { ctx } = fakeCtx()
    const { conn } = fakeConn()
    setIntentSpecMode(ctx, conn, { type: 'set_intent_spec_mode', intentId: id, mode: 'sdd' })
    expect(getIntent(id)!.specMode).toBe('sdd')
  })

  it('clears the override back to workspace inheritance on an explicit null', () => {
    const id = newIntent()
    const { ctx, broadcastIntents } = fakeCtx()
    const { conn } = fakeConn()
    setIntentSpecMode(ctx, conn, { type: 'set_intent_spec_mode', intentId: id, mode: 'fast' })
    setIntentSpecMode(ctx, conn, { type: 'set_intent_spec_mode', intentId: id, mode: null })
    expect(getIntent(id)!.specMode).toBeNull()
    expect(broadcastIntents).toHaveBeenCalledTimes(2)
  })

  it('leaves spec_status / spec_approved untouched in both directions', () => {
    const id = newIntent()
    setSpecPath(id, 'doc/spec.md')
    setSpecApproved(id, true, 'alice')
    const { ctx } = fakeCtx()
    const { conn } = fakeConn()
    setIntentSpecMode(ctx, conn, { type: 'set_intent_spec_mode', intentId: id, mode: 'fast' })
    let after = getIntent(id)!
    expect(after.specStatus).toBe('approved')
    expect(after.specApproved).toBe(true)
    expect(after.specApproveUser).toBe('alice')

    setIntentSpecMode(ctx, conn, { type: 'set_intent_spec_mode', intentId: id, mode: 'sdd' })
    after = getIntent(id)!
    expect(after.specStatus).toBe('approved')
    expect(after.specApproved).toBe(true)
  })

  it('rejects an unknown intent with intent.notFound and does not broadcast', () => {
    const { ctx, broadcastIntents } = fakeCtx()
    const { conn, sent } = fakeConn()
    setIntentSpecMode(ctx, conn, {
      type: 'set_intent_spec_mode',
      intentId: 'nope',
      mode: 'fast',
    })
    expect(sent).toEqual([{ type: 'error', error: { code: 'intent.notFound' } }])
    expect(broadcastIntents).not.toHaveBeenCalled()
  })
})
