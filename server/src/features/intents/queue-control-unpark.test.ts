/**
 * `queueControlHandler` — the manual unpark.
 *
 * The handler is the only door a human's "解除 park" goes through, so it owns the
 * checks the button cannot make: the workspace must resolve, the intent must
 * exist AND belong to that workspace, and it must actually be parked right now.
 * Every refusal is REPORTED — a control that silently did nothing would read as
 * success on the queue page. The success path answers with the fresh projection
 * so the page shows the pass that really ran instead of a local guess.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { GenericEvent } from '@ccc/shared'
import type { QueueDetail, ServerToClient } from '@ccc/shared/protocol'
import type { Conn } from '../../transport/handler-registry.js'
import type { KernelContext } from '../../kernel/types.js'
import { getDb, resetDbForTests } from '../../kernel/infra/db.js'
import { resetSettingsCacheForTests } from '../../kernel/config/index.js'
import {
  addWorkspace,
  pathToName,
  resetStateCacheForTests,
  resolveWorkspaceRoot,
} from '../../state.js'
import { getIntent, insertIntents, resetStoreForTests, setAutomate } from './store.js'
import {
  getQueueIntentMetaById,
  putQueueIntentMeta,
  resetQueueStoreForTests,
} from './queue-store.js'
import { isFunnelStoreAvailable, resetFunnelStoreForTests } from './funnel-store.js'
import {
  resetWorkflowForTests,
  setWorkflowHooks,
  settleQueueForTests,
  type WorkflowHooks,
} from './workflow.js'
import { queueControlHandler } from './index.js'
import { resetStoreForTests as resetSessionMetadataStoreForTests } from '../sessions/session-metadata-store.js'

let dir: string
let otherDir: string
let prevC3Dir: string | undefined
let workspaceName: string
let otherWorkspaceId: string
let proj: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'c3-unpark-'))
  otherDir = mkdtempSync(join(tmpdir(), 'c3-unpark-other-'))
  process.env.CLAUDE_CONFIG_DIR = dir
  process.env.C3_DB_PATH = join(dir, 'c3.db')
  prevC3Dir = process.env.C3_DIR
  process.env.C3_DIR = join(dir, 'c3home')
  resetDbForTests()
  resetStoreForTests()
  resetQueueStoreForTests()
  resetFunnelStoreForTests()
  isFunnelStoreAvailable()
  resetSessionMetadataStoreForTests()
  resetStateCacheForTests()
  resetSettingsCacheForTests()
  addWorkspace(dir, 1)
  addWorkspace(otherDir, 2)
  workspaceName = pathToName(dir)!
  otherWorkspaceId = pathToName(otherDir)!
  proj = resolveWorkspaceRoot(workspaceName)!
  resetWorkflowForTests()
  // The unpark asks the kernel for a fresh pass; the queue here is never started,
  // so the pass is a no-op — the hooks only have to exist, not to do anything.
  setWorkflowHooks(stubHooks())
})

afterEach(async () => {
  // Drain the pass the unpark requested before the temp database goes away.
  await settleQueueForTests(proj)
  resetWorkflowForTests()
  resetDbForTests()
  resetFunnelStoreForTests()
  resetSessionMetadataStoreForTests()
  resetStateCacheForTests()
  resetSettingsCacheForTests()
  delete process.env.CLAUDE_CONFIG_DIR
  delete process.env.C3_DB_PATH
  if (prevC3Dir === undefined) delete process.env.C3_DIR
  else process.env.C3_DIR = prevC3Dir
  rmSync(dir, { recursive: true, force: true })
  rmSync(otherDir, { recursive: true, force: true })
})

function stubHooks(): WorkflowHooks {
  return {
    runDevTurn: () => Promise.resolve({ outcome: 'complete', sessionId: 's', lastMessage: '' }),
    launchSpecRun: () => Promise.resolve(),
    broadcastIntents: () => {},
    emitStatus: () => {},
    sessionExists: () => Promise.resolve(false),
    isRunning: () => false,
    sessionStatus: () => null,
    normalizeEvent: (core: GenericEvent) => ({ ok: true, event: core }) as never,
    publishEvent: () => {},
    createUserTodo: () => {},
    broadcastQueueDetail: () => {},
  } as unknown as WorkflowHooks
}

function fakeCtx(): KernelContext {
  return { broadcastWorkflow: () => {} } as unknown as KernelContext
}

function fakeConn(): { conn: Conn; sent: ServerToClient[] } {
  const sent: ServerToClient[] = []
  const conn = { send: (m: ServerToClient) => sent.push(m), subject: 'erin' } as unknown as Conn
  return { conn, sent }
}

/** Run one unpark and return the single frame it answered with. */
function unpark(opts: { workspaceName?: string; intentId?: string } = {}): ServerToClient {
  const { conn, sent } = fakeConn()
  queueControlHandler(fakeCtx(), conn, {
    type: 'queue_control',
    workspaceName: opts.workspaceName ?? workspaceName,
    action: 'unpark',
    ...(opts.intentId === undefined ? {} : { intentId: opts.intentId }),
  })
  expect(sent).toHaveLength(1)
  return sent[0]
}

function errorCodeOf(msg: ServerToClient): string | null {
  return msg.type === 'error' ? (msg as { error: { code: string } }).error.code : null
}

/** The park→recovery observation rows this intent produced, in insertion order. */
function funnelStages(intentId: string): string[] {
  return getDb()!
    .all<{
      stage: string
    }>('SELECT stage FROM funnel_event WHERE intent_id=? ORDER BY rowid ASC', intentId)
    .map((r) => r.stage)
}

function detailOf(msg: ServerToClient): QueueDetail {
  expect(msg.type).toBe('queue_detail')
  return (msg as { detail: QueueDetail }).detail
}

/** Seed one automation candidate, parked with a structured reason. */
function seedParked(workspacePath = proj, park = true) {
  const [r] = insertIntents(workspacePath, [
    { title: '被 park 的意图', shortEnTitle: 'parked-one', content: 'body', priority: 'P1' },
  ])
  setAutomate(r.id, true)
  if (park) {
    putQueueIntentMeta(workspacePath, {
      ...getQueueIntentMetaById(r.id),
      intentId: r.id,
      parked: true,
      parkReason: 'max_attempts_reached',
      parkDetail: '连续 3 次失败',
      failureCount: 3,
      backoffUntil: Date.now() + 60_000,
      updatedAt: Date.now(),
    })
  }
  return r
}

describe('queueControlHandler — unpark 成功路径', () => {
  it('清除 park 标记/原因/详情/失败计数/退避,并回最新队列投影', () => {
    const r = seedParked()

    const msg = unpark({ intentId: r.id })

    const detail = detailOf(msg)
    expect(detail.workspaceName).toBe(workspaceName)
    const item = detail.items.find((i) => i.intentId === r.id)
    expect(item).toBeDefined()
    expect(item).toMatchObject({
      parked: false,
      parkReason: null,
      parkDetail: null,
      attemptCount: 0,
    })
    expect(item!.backoffUntil).toBe(null)
    expect(getQueueIntentMetaById(r.id)).toMatchObject({
      parked: false,
      parkReason: null,
      parkDetail: null,
      failureCount: 0,
      backoffUntil: null,
    })
  })

  it('只记录一次人工恢复观测,且只在真实跃迁时记录', () => {
    const r = seedParked()

    unpark({ intentId: r.id })
    // 第二次已经不是 park,被拒绝——不能再记一笔恢复。
    unpark({ intentId: r.id })

    const stages = funnelStages(r.id)
    expect(stages.filter((s) => s === 'unparked')).toHaveLength(1)
  })

  it('解除 park 不等于完成:意图状态与 automate 标记原样不动', () => {
    const r = seedParked()

    unpark({ intentId: r.id })

    const after = getIntent(r.id)
    expect(after?.status).toBe('todo')
    expect(after?.automate).toBe(true)
  })
})

describe('queueControlHandler — unpark 拒绝路径', () => {
  it('目标当前不是 park:回 queue.notParked,不是静默成功', () => {
    const r = seedParked(proj, false)

    const msg = unpark({ intentId: r.id })

    expect(errorCodeOf(msg)).toBe('queue.notParked')
    expect(getQueueIntentMetaById(r.id).parked).toBe(false)
  })

  it('重复点击:第二次被明确拒绝', () => {
    const r = seedParked()

    expect(detailOf(unpark({ intentId: r.id }))).toBeDefined()
    expect(errorCodeOf(unpark({ intentId: r.id }))).toBe('queue.notParked')
  })

  it('意图不存在:回 intent.notFound', () => {
    expect(errorCodeOf(unpark({ intentId: 'no-such-intent' }))).toBe('intent.notFound')
  })

  it('跨工作区目标:按不存在处理,park 保持原样', () => {
    const other = seedParked(resolveWorkspaceRoot(otherWorkspaceId)!)

    const msg = unpark({ workspaceName, intentId: other.id })

    expect(errorCodeOf(msg)).toBe('intent.notFound')
    expect(getQueueIntentMetaById(other.id)).toMatchObject({ parked: true })
  })

  it('缺少 intentId:回 queue.intentRequired', () => {
    expect(errorCodeOf(unpark({}))).toBe('queue.intentRequired')
  })

  it('工作区无法解析:回 workspace.unknown', () => {
    expect(errorCodeOf(unpark({ workspaceName: 'ws-does-not-exist', intentId: 'x' }))).toBe(
      'workspace.unknown',
    )
  })
})
