/**
 * Lifecycle-log instrumentation — every acceptance operation point appends its
 * `intent_logs` row and a failed log write never breaks the business path:
 *  - `upsertIntents` INSERT → `intent_created`, UPDATE → `intent_updated` (explicit actor kept)
 *  - `updateStatus` change → `status_changed` (same-status writes log nothing;
 *    handler passes the login subject, bare store calls land as `'automation'`)
 *  - `writeSpecHandler` → `spec_created`, `approveSpecHandler` → `spec_approved`
 *  - `createPrHandler` → `pr_created`; `syncIntentPrStatus` merged/closed → one row,
 *    unchanged / failed sync → none
 *  - a dropped `intent_logs` table only warns; the decorated operation still succeeds
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
  return { ...actual, createGhPr: vi.fn(), getForgePrStatus: vi.fn() }
})

import { createGhPr, getForgePrStatus } from '../../git.js'
import { getDb, resetDbForTests } from '../../kernel/infra/db.js'
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
  setSpecPath,
  updateStatus,
  upsertIntents,
} from './store.js'
import { createPrHandler, updateIntentStatus } from './index.js'
import { approveSpecHandler, writeSpecHandler } from './spec.js'
import { syncIntentPrStatus } from './pr-status-sync.js'
import { resetStoreForTests as resetSessionMetadataStoreForTests } from '../sessions/session-metadata-store.js'

let dir: string
let prevC3Dir: string | undefined
let workspaceId: string
let proj: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'c3-intent-log-instr-'))
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
  vi.mocked(createGhPr).mockReset()
  vi.mocked(getForgePrStatus).mockReset()
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

function fakeCtx(): KernelContext {
  return {
    broadcastIntents: vi.fn(),
    eventBus: { publish: vi.fn() },
  } as unknown as KernelContext
}

function logsOf(intentId: string, op?: string) {
  const logs = listIntentLogs(intentId)
  return op ? logs.filter((l) => l.operationType === op) : logs
}

describe('upsertIntents instrumentation', () => {
  it('INSERT logs intent_created, UPDATE logs intent_updated, explicit actor kept', () => {
    const [created] = upsertIntents(
      proj,
      [{ title: 'A', shortEnTitle: 'a', content: 'c', priority: 'P1' }],
      'tester',
    )
    expect(logsOf(created.id, 'intent_created')).toMatchObject([
      { summary: '创建意图: A', actor: 'tester' },
    ])

    upsertIntents(
      proj,
      [{ id: created.id, title: 'A2', shortEnTitle: 'a', content: 'c2', priority: 'P1' }],
      'tester',
    )
    expect(logsOf(created.id, 'intent_updated')).toMatchObject([
      { summary: '更新意图: A2', actor: 'tester' },
    ])
  })

  it("defaults the actor to 'system' when omitted", () => {
    const [created] = upsertIntents(proj, [
      { title: 'B', shortEnTitle: 'b', content: 'c', priority: 'P2' },
    ])
    expect(logsOf(created.id, 'intent_created')[0].actor).toBe('system')
  })
})

describe('updateStatus instrumentation', () => {
  it('logs status_changed on a real transition; same-status writes log nothing', () => {
    const [r] = insertIntents(proj, [
      { title: 'S', shortEnTitle: 's', content: '', priority: 'P1' },
    ])
    updateStatus(r.id, 'in_progress')
    expect(logsOf(r.id, 'status_changed')).toMatchObject([
      { summary: '状态变更: todo → in_progress', actor: 'automation' },
    ])
    updateStatus(r.id, 'in_progress')
    expect(logsOf(r.id, 'status_changed')).toHaveLength(1)
  })

  it('the update_intent_status handler stamps the login subject as actor', () => {
    const [r] = insertIntents(proj, [
      { title: 'H', shortEnTitle: 'h', content: '', priority: 'P1' },
    ])
    const { conn } = fakeConn({ subject: 'bob' })
    updateIntentStatus(fakeCtx(), conn, {
      type: 'update_intent_status',
      intentId: r.id,
      status: 'in_progress',
    })
    expect(logsOf(r.id, 'status_changed')).toMatchObject([
      { summary: '状态变更: todo → in_progress', actor: 'bob' },
    ])
  })
})

describe('spec instrumentation', () => {
  it('writeSpecHandler logs spec_created with the login subject', () => {
    const [r] = insertIntents(proj, [
      { title: 'Spec me', shortEnTitle: 'spec-me', content: '', priority: 'P1' },
    ])
    const launchRun = vi.fn().mockResolvedValue(undefined)
    const { conn } = fakeConn({ subject: 'carol' })
    writeSpecHandler({ launchRun, broadcastIntents: vi.fn() } as unknown as KernelContext, conn, {
      type: 'write_spec',
      workspaceId,
      intentId: r.id,
    })
    expect(logsOf(r.id, 'spec_created')).toMatchObject([{ summary: '编写 spec', actor: 'carol' }])
  })

  it('approveSpecHandler logs spec_approved with the approving subject', () => {
    const [r] = insertIntents(proj, [
      { title: 'Approve me', shortEnTitle: 'approve-me', content: '', priority: 'P1' },
    ])
    setSpecPath(r.id, join(dir, 'c3home', 'spec.md'))
    const { conn } = fakeConn({ subject: 'dave' })
    approveSpecHandler(fakeCtx(), conn, { type: 'approve_spec', workspaceId, intentId: r.id })
    expect(logsOf(r.id, 'spec_approved')).toMatchObject([{ summary: '批准 spec', actor: 'dave' }])
  })
})

describe('PR instrumentation', () => {
  it('createPrHandler logs pr_created on success', async () => {
    const [r] = insertIntents(proj, [
      { title: 'PR me', shortEnTitle: 'pr-me', content: '', priority: 'P1' },
    ])
    updateStatus(r.id, 'done')
    vi.mocked(createGhPr).mockResolvedValue({ ok: true, prId: '42', prUrl: 'https://x/pr/42' })
    const { conn } = fakeConn({ subject: 'erin' })
    await createPrHandler(fakeCtx(), conn, { type: 'create_pr', workspaceId, intentId: r.id })
    expect(logsOf(r.id, 'pr_created')).toMatchObject([{ summary: '创建 PR #42', actor: 'erin' }])
  })

  it("syncIntentPrStatus logs pr_merged / pr_closed as 'automation'", async () => {
    const [merged, closed] = insertIntents(proj, [
      { title: 'M', shortEnTitle: 'm', content: '', priority: 'P1' },
      { title: 'C', shortEnTitle: 'c', content: '', priority: 'P1' },
    ])
    for (const r of [merged, closed]) updateStatus(r.id, 'done')
    setPrInfo(merged.id, '7', 'reviewing')
    setPrInfo(closed.id, '8', 'reviewing')

    vi.mocked(getForgePrStatus).mockResolvedValueOnce({ ok: true, status: 'merged' })
    await syncIntentPrStatus({ workspacePath: proj, intentId: merged.id })
    expect(logsOf(merged.id, 'pr_merged')).toMatchObject([
      { summary: 'PR #7 已合并', actor: 'automation' },
    ])

    vi.mocked(getForgePrStatus).mockResolvedValueOnce({ ok: true, status: 'closed' })
    await syncIntentPrStatus({ workspacePath: proj, intentId: closed.id })
    expect(logsOf(closed.id, 'pr_closed')).toMatchObject([
      { summary: 'PR #8 已关闭', actor: 'automation' },
    ])
  })

  it('an unchanged or failed sync logs nothing', async () => {
    const [r] = insertIntents(proj, [
      { title: 'U', shortEnTitle: 'u', content: '', priority: 'P1' },
    ])
    updateStatus(r.id, 'done')
    setPrInfo(r.id, '9', 'reviewing')

    vi.mocked(getForgePrStatus).mockResolvedValueOnce({ ok: true, status: 'reviewing' })
    await syncIntentPrStatus({ workspacePath: proj, intentId: r.id })
    vi.mocked(getForgePrStatus).mockResolvedValueOnce({ ok: false, error: 'boom' })
    await syncIntentPrStatus({ workspacePath: proj, intentId: r.id })

    expect(logsOf(r.id, 'pr_merged')).toHaveLength(0)
    expect(logsOf(r.id, 'pr_closed')).toHaveLength(0)
  })
})

describe('failure isolation', () => {
  it('a broken intent_logs table only warns; the business write still lands', () => {
    const [r] = insertIntents(proj, [
      { title: 'Iso', shortEnTitle: 'iso', content: '', priority: 'P1' },
    ])
    getDb()!.exec('DROP TABLE intent_logs')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(() => updateStatus(r.id, 'in_progress')).not.toThrow()
    expect(getIntent(r.id)?.status).toBe('in_progress')
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})
