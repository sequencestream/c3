/**
 * `update_intent_content` handler — the human inline body-edit entry.
 *  - draft / todo: content + updated_at update, one `intent_updated` log
 *    (actor = login subject, or 'system' when absent), and an `intent_logs_list`
 *    refresh frame is sent back for an already-open changelog tab.
 *  - any other status (in_progress / done / cancelled): rejected with
 *    `intent.contentEditForbidden` and the content is left untouched.
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
  listIntentLogs,
  resetStoreForTests,
  updateStatus,
} from './store.js'
import { updateIntentContent } from './index.js'
import { resetStoreForTests as resetSessionMetadataStoreForTests } from '../sessions/session-metadata-store.js'

let dir: string
let prevC3Dir: string | undefined
let workspaceId: string
let proj: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'c3-intent-content-'))
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
  workspaceId = pathToId(dir)!
  proj = resolveWorkspaceRoot(workspaceId)!
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

function fakeCtx(): { ctx: KernelContext; broadcastIntents: ReturnType<typeof vi.fn> } {
  const broadcastIntents = vi.fn()
  return { ctx: { broadcastIntents } as unknown as KernelContext, broadcastIntents }
}

function logsOf(intentId: string, op?: string) {
  const logs = listIntentLogs(intentId)
  return op ? logs.filter((l) => l.operationType === op) : logs
}

describe('update_intent_content — status gate + logging', () => {
  it('todo: updates content, bumps updated_at, logs intent_updated with the subject', async () => {
    const [r] = insertIntents(proj, [
      { title: 'T', shortEnTitle: 't', content: 'old', priority: 'P1' },
    ])
    const before = getIntent(r.id)!
    await new Promise((res) => setTimeout(res, 2))
    const { ctx, broadcastIntents } = fakeCtx()
    const { conn } = fakeConn({ subject: 'bob' })
    updateIntentContent(ctx, conn, {
      type: 'update_intent_content',
      intentId: r.id,
      content: 'new body',
    })
    const after = getIntent(r.id)!
    expect(after.content).toBe('new body')
    expect(after.updatedAt).toBeGreaterThan(before.updatedAt)
    expect(broadcastIntents).toHaveBeenCalledWith(proj)
    expect(logsOf(r.id, 'intent_updated')).toMatchObject([
      { summary: '更新意图正文', actor: 'bob' },
    ])
  })

  it('draft is editable too', () => {
    const [r] = insertIntents(
      proj,
      [{ title: 'D', shortEnTitle: 'd', content: 'x', priority: 'P1' }],
      'draft',
    )
    const { ctx } = fakeCtx()
    const { conn } = fakeConn()
    updateIntentContent(ctx, conn, {
      type: 'update_intent_content',
      intentId: r.id,
      content: 'draft edited',
    })
    expect(getIntent(r.id)!.content).toBe('draft edited')
    expect(logsOf(r.id, 'intent_updated')).toHaveLength(1)
  })

  it("defaults the actor to 'system' when the connection has no subject", () => {
    const [r] = insertIntents(proj, [
      { title: 'S', shortEnTitle: 's', content: 'x', priority: 'P1' },
    ])
    const { ctx } = fakeCtx()
    const { conn } = fakeConn({ subject: null })
    updateIntentContent(ctx, conn, {
      type: 'update_intent_content',
      intentId: r.id,
      content: 'y',
    })
    expect(logsOf(r.id, 'intent_updated')[0].actor).toBe('system')
  })

  it('sends an intent_logs_list refresh frame on success', () => {
    const [r] = insertIntents(proj, [
      { title: 'L', shortEnTitle: 'l', content: 'x', priority: 'P1' },
    ])
    const { ctx } = fakeCtx()
    const { conn, sent } = fakeConn()
    updateIntentContent(ctx, conn, {
      type: 'update_intent_content',
      intentId: r.id,
      content: 'z',
    })
    const frame = sent.find((m) => m.type === 'intent_logs_list')
    expect(frame).toBeTruthy()
    expect(frame).toMatchObject({ intentId: r.id })
  })

  it('rejects non-draft/todo statuses and leaves the content untouched', () => {
    for (const status of ['in_progress', 'done', 'cancelled'] as const) {
      const [r] = insertIntents(proj, [
        { title: status, shortEnTitle: 'x', content: 'keep', priority: 'P1' },
      ])
      updateStatus(r.id, status)
      const { ctx, broadcastIntents } = fakeCtx()
      const { conn, sent } = fakeConn()
      updateIntentContent(ctx, conn, {
        type: 'update_intent_content',
        intentId: r.id,
        content: 'should not land',
      })
      expect(getIntent(r.id)!.content).toBe('keep')
      expect(logsOf(r.id, 'intent_updated')).toHaveLength(0)
      expect(broadcastIntents).not.toHaveBeenCalled()
      expect(sent).toMatchObject([
        { type: 'error', error: { code: 'intent.contentEditForbidden', params: { status } } },
      ])
    }
  })

  it('rejects a missing intent', () => {
    const { ctx } = fakeCtx()
    const { conn, sent } = fakeConn()
    updateIntentContent(ctx, conn, {
      type: 'update_intent_content',
      intentId: 'nope',
      content: 'x',
    })
    expect(sent).toMatchObject([{ type: 'error', error: { code: 'intent.notFound' } }])
  })
})
