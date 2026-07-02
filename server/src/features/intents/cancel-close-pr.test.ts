/**
 * Cancelling an intent that owns a PR closes the remote PR first (`closeForgePr`),
 * and the close result gates the status flip:
 *  - close ok → status becomes `cancelled`, `pr_status` becomes `closed` (pr_url
 *    preserved), one `status_changed` + one `pr_closed` log, intents broadcast once
 *  - close fails → status/pr_status unchanged, no logs, `intent.prCloseFailed` error
 *  - no PR → the close gate is never invoked; original path runs unchanged
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ServerToClient } from '@ccc/shared/protocol'
import type { Conn } from '../../transport/handler-registry.js'
import type { KernelContext } from '../../kernel/types.js'

vi.mock('../../git.js', async () => {
  const actual = await vi.importActual<typeof import('../../git.js')>('../../git.js')
  return { ...actual, closeForgePr: vi.fn() }
})

import { closeForgePr } from '../../git.js'
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
  setPrInfo,
  updateStatus,
} from './store.js'
import { updateIntentStatus } from './index.js'
import { resetStoreForTests as resetSessionMetadataStoreForTests } from '../sessions/session-metadata-store.js'

let dir: string
let prevC3Dir: string | undefined
let workspaceId: string
let proj: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'c3-cancel-close-pr-'))
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
  vi.mocked(closeForgePr).mockReset()
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
  const ctx = {
    broadcastIntents,
    eventBus: { publish: vi.fn() },
  } as unknown as KernelContext
  return { ctx, broadcastIntents }
}

function logsOf(intentId: string, op?: string) {
  const logs = listIntentLogs(intentId)
  return op ? logs.filter((l) => l.operationType === op) : logs
}

describe('updateIntentStatus — cancel closes the associated PR', () => {
  it('close ok → cancelled + pr_status closed + pr_closed log (pr_url kept)', async () => {
    const [r] = insertIntents(proj, [
      { title: 'Has PR', shortEnTitle: 'has-pr', content: '', priority: 'P1' },
    ])
    updateStatus(r.id, 'in_progress')
    setPrInfo(r.id, '77', 'reviewing', 'https://github.com/o/r/pull/77')
    vi.mocked(closeForgePr).mockResolvedValue({ ok: true })

    const { conn, sent } = fakeConn({ subject: 'bob' })
    const { ctx, broadcastIntents } = fakeCtx()
    await updateIntentStatus(ctx, conn, {
      type: 'update_intent_status',
      intentId: r.id,
      status: 'cancelled',
    })

    expect(vi.mocked(closeForgePr)).toHaveBeenCalledWith(proj, '77')
    const after = getIntent(r.id)
    expect(after?.status).toBe('cancelled')
    expect(after?.prStatus).toBe('closed')
    expect(after?.prUrl).toBe('https://github.com/o/r/pull/77')
    // Two status_changed rows: the setup todo→in_progress and this cancel.
    expect(logsOf(r.id, 'status_changed')).toMatchObject([
      { summary: '状态变更: in_progress → cancelled', actor: 'bob' },
      { summary: '状态变更: todo → in_progress' },
    ])
    expect(logsOf(r.id, 'pr_closed')).toMatchObject([
      { summary: 'PR #77 已随意图取消', actor: 'bob' },
    ])
    expect(broadcastIntents).toHaveBeenCalledTimes(1)
    expect(sent.some((m) => m.type === 'error')).toBe(false)
  })

  it('close fails → status/pr_status unchanged, no logs, prCloseFailed error', async () => {
    const [r] = insertIntents(proj, [
      { title: 'PR wont close', shortEnTitle: 'pr-stuck', content: '', priority: 'P1' },
    ])
    updateStatus(r.id, 'in_progress')
    setPrInfo(r.id, '88', 'reviewing', 'https://github.com/o/r/pull/88')
    vi.mocked(closeForgePr).mockResolvedValue({ ok: false, error: 'pull request is not open' })

    const { conn, sent } = fakeConn()
    const { ctx, broadcastIntents } = fakeCtx()
    await updateIntentStatus(ctx, conn, {
      type: 'update_intent_status',
      intentId: r.id,
      status: 'cancelled',
    })

    const after = getIntent(r.id)
    expect(after?.status).toBe('in_progress')
    expect(after?.prStatus).toBe('reviewing')
    expect(logsOf(r.id, 'status_changed')).toHaveLength(1) // only the in_progress transition
    expect(logsOf(r.id, 'pr_closed')).toHaveLength(0)
    expect(broadcastIntents).not.toHaveBeenCalled()
    expect(sent).toMatchObject([
      {
        type: 'error',
        error: { code: 'intent.prCloseFailed', params: { detail: 'pull request is not open' } },
      },
    ])
  })

  it('no PR → close gate never runs, original cancel path unchanged', async () => {
    const [r] = insertIntents(proj, [
      { title: 'No PR', shortEnTitle: 'no-pr', content: '', priority: 'P1' },
    ])
    updateStatus(r.id, 'in_progress')

    const { conn, sent } = fakeConn()
    const { ctx, broadcastIntents } = fakeCtx()
    await updateIntentStatus(ctx, conn, {
      type: 'update_intent_status',
      intentId: r.id,
      status: 'cancelled',
    })

    expect(vi.mocked(closeForgePr)).not.toHaveBeenCalled()
    expect(getIntent(r.id)?.status).toBe('cancelled')
    expect(logsOf(r.id, 'pr_closed')).toHaveLength(0)
    expect(broadcastIntents).toHaveBeenCalledTimes(1)
    expect(sent.some((m) => m.type === 'error')).toBe(false)
  })
})
