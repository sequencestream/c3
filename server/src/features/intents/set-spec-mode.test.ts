/**
 * `set_intent_spec_mode` handler — the per-intent spec-mode override write.
 *  - explicit `sdd` / `fast`: persisted to `spec_mode` and broadcast.
 *  - explicit `null`: clears the override back to workspace inheritance.
 *  - never touches `spec_status` / `spec_approved`: switching to fast does not
 *    revoke an approved spec, switching to sdd does not fabricate a pending one.
 *  - unknown intent: `intent.notFound`, nothing written, no broadcast.
 *  - spec or development already started: `intent.specModeLocked`, nothing
 *    written, no broadcast — the backstop behind the UI that hides the control.
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
  setLastWorkSession,
  setSpecApproved,
  setSpecPath,
  setSpecReviewSessionId,
  setSpecSessionId,
  upsertIntentPr,
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

describe('set_intent_spec_mode — locked once spec or development has started', () => {
  const LOCKED = [{ type: 'error', error: { code: 'intent.specModeLocked' } }]

  /** Set the override while still editable, so each lock case has a value to protect. */
  function seedOverride(id: string): void {
    const { ctx } = fakeCtx()
    const { conn } = fakeConn()
    setIntentSpecMode(ctx, conn, { type: 'set_intent_spec_mode', intentId: id, mode: 'sdd' })
    expect(getIntent(id)!.specMode).toBe('sdd')
  }

  /** Apply `start` to a seeded intent, then assert the next write is refused outright. */
  function expectLocked(start: (id: string) => void): void {
    const id = newIntent()
    seedOverride(id)
    start(id)
    const { ctx, broadcastIntents } = fakeCtx()
    const { conn, sent } = fakeConn()
    setIntentSpecMode(ctx, conn, { type: 'set_intent_spec_mode', intentId: id, mode: 'fast' })
    expect(sent).toEqual(LOCKED)
    expect(getIntent(id)!.specMode).toBe('sdd')
    expect(broadcastIntents).not.toHaveBeenCalled()
  }

  it('refuses once a spec document exists (specPath set)', () => {
    expectLocked((id) => setSpecPath(id, 'doc/spec.md'))
  })

  it('refuses once the spec status moved past raw', () => {
    // Un-approval lands `pending` with no path — the status half of the criterion alone.
    expectLocked((id) => setSpecApproved(id, false, null))
    expectLocked((id) => setSpecApproved(id, true, 'alice'))
  })

  it('refuses once a spec-authoring session was started', () => {
    expectLocked((id) => setSpecSessionId(id, 'spec-sess'))
  })

  it('refuses once a spec-review session was started', () => {
    expectLocked((id) => setSpecReviewSessionId(id, 'review-sess'))
  })

  it('refuses once development ran — this is what covers merged intents', () => {
    expectLocked((id) => setLastWorkSession(id, 'work-sess'))
  })

  it('refuses a merged intent, whose work session is what trips the lock', () => {
    const id = newIntent()
    seedOverride(id)
    setLastWorkSession(id, 'work-sess')
    upsertIntentPr({
      intentId: id,
      number: '42',
      url: 'https://example.test/pull/42',
      status: 'merged',
      forge: 'github',
      repo: 'acme/app',
    })
    const { ctx, broadcastIntents } = fakeCtx()
    const { conn, sent } = fakeConn()
    setIntentSpecMode(ctx, conn, { type: 'set_intent_spec_mode', intentId: id, mode: 'fast' })
    expect(sent).toEqual(LOCKED)
    expect(getIntent(id)!.specMode).toBe('sdd')
    expect(broadcastIntents).not.toHaveBeenCalled()
  })

  it('clearing the override back to inheritance is refused too — refusal is total', () => {
    expectLocked((id) => setLastWorkSession(id, 'work-sess'))
    const id = newIntent()
    seedOverride(id)
    setLastWorkSession(id, 'work-sess')
    const { ctx, broadcastIntents } = fakeCtx()
    const { conn, sent } = fakeConn()
    setIntentSpecMode(ctx, conn, { type: 'set_intent_spec_mode', intentId: id, mode: null })
    expect(sent).toEqual(LOCKED)
    expect(getIntent(id)!.specMode).toBe('sdd')
    expect(broadcastIntents).not.toHaveBeenCalled()
  })

  it('leaves the spec checkpoint untouched when refusing (no revocation as a side effect)', () => {
    const id = newIntent()
    setSpecPath(id, 'doc/spec.md')
    setSpecApproved(id, true, 'alice')
    const { ctx } = fakeCtx()
    const { conn } = fakeConn()
    setIntentSpecMode(ctx, conn, { type: 'set_intent_spec_mode', intentId: id, mode: 'fast' })
    const after = getIntent(id)!
    expect(after.specStatus).toBe('approved')
    expect(after.specApproved).toBe(true)
    expect(after.specApproveUser).toBe('alice')
  })

  it('an intent with a blank spec path stays editable — empty strings are not spec content', () => {
    const id = newIntent()
    setSpecPath(id, '   ')
    const { ctx, broadcastIntents } = fakeCtx()
    const { conn, sent } = fakeConn()
    setIntentSpecMode(ctx, conn, { type: 'set_intent_spec_mode', intentId: id, mode: 'fast' })
    expect(sent).toEqual([])
    expect(getIntent(id)!.specMode).toBe('fast')
    expect(broadcastIntents).toHaveBeenCalledWith(proj)
  })
})
