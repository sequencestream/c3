/**
 * `open_spec_review_session` handler — 评审会话的唯一恢复入口(意图详情的「评审」tab
 * 与会话页「规范」列表的评审行都走它)。
 *
 * 关键契约:目标会话只由意图保存的 `spec_review_session_id` 解析(调用方给的是意图 id,
 * 不是会话 id);冷会话恢复后 runtime 的 kind 仍是 `spec_review` 并带着所属意图与评审
 * 指纹;回包显式声明真实 kind 与 owner,供客户端的只读门与溯源使用;意图不存在或没有
 * 评审会话一律拒绝,不降级成普通选择。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ServerToClient } from '@ccc/shared/protocol'
import type { Conn } from '../../transport/handler-registry.js'
import type { KernelContext } from '../../kernel/types.js'
import { resetDbForTests } from '../../kernel/infra/db.js'
import {
  addWorkspace,
  pathToName,
  resetStateCacheForTests,
  resolveWorkspaceRoot,
} from '../../state.js'
import { getRuntime, removeRuntime } from '../../runs.js'
import { insertIntents, resetStoreForTests, setSpecReviewSessionId } from './store.js'
import { openSpecReviewSession } from './index.js'
import { resetSettingsCacheForTests } from '../../kernel/config/index.js'

let dir: string
let prevC3Dir: string | undefined
let workspaceName: string
let proj: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'c3-open-spec-review-'))
  process.env.CLAUDE_CONFIG_DIR = dir
  prevC3Dir = process.env.C3_DIR
  process.env.C3_DIR = dir
  process.env.C3_DB_PATH = join(dir, 'c3.db')
  resetDbForTests()
  resetStoreForTests()
  resetStateCacheForTests()
  resetSettingsCacheForTests()
  addWorkspace(dir, 1)
  workspaceName = pathToName(dir)!
  proj = resolveWorkspaceRoot(workspaceName)!
})

afterEach(() => {
  resetDbForTests()
  resetStateCacheForTests()
  resetSettingsCacheForTests()
  delete process.env.CLAUDE_CONFIG_DIR
  if (prevC3Dir === undefined) delete process.env.C3_DIR
  else process.env.C3_DIR = prevC3Dir
  delete process.env.C3_DB_PATH
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
  } as Conn
  return { conn, sent }
}

const ctx = {} as unknown as KernelContext

describe('openSpecReviewSession', () => {
  it('冷会话恢复为只读 spec_review runtime,并带上所属意图与评审指纹', async () => {
    const [r] = insertIntents(proj, [
      { title: 'Reviewed', shortEnTitle: 'rev', content: '', priority: 'P1' },
    ])
    const reviewId = 'review-session-1'
    setSpecReviewSessionId(r.id, reviewId)

    const { conn, sent } = fakeConn()
    await openSpecReviewSession(ctx, conn, {
      type: 'open_spec_review_session',
      workspaceName,
      intentId: r.id,
    })

    const rt = getRuntime(reviewId)!
    expect(rt.sessionKind).toBe('spec_review')
    expect(rt.specReviewIntentId).toBe(r.id)
    // 撰写侧的目录写授权绝不能被评审会话继承。
    expect(rt.specDir).toBeFalsy()

    const selected = sent.find((m) => m.type === 'session_selected')
    expect(selected).toMatchObject({
      sessionId: reviewId,
      sessionKind: 'spec_review',
      ownerKind: 'intent',
      ownerId: r.id,
    })
    expect(conn.viewing).toBe(reviewId)

    removeRuntime(reviewId)
  })

  it('按意图解析目标:调用方给的是意图 id,恢复的是该意图当前的评审会话', async () => {
    const [a, b] = insertIntents(proj, [
      { title: 'A', shortEnTitle: 'a', content: '', priority: 'P1' },
      { title: 'B', shortEnTitle: 'b', content: '', priority: 'P1' },
    ])
    setSpecReviewSessionId(a.id, 'review-a')
    setSpecReviewSessionId(b.id, 'review-b')

    const { conn, sent } = fakeConn()
    await openSpecReviewSession(ctx, conn, {
      type: 'open_spec_review_session',
      workspaceName,
      intentId: b.id,
    })

    const selected = sent.find((m) => m.type === 'session_selected')
    expect(selected && selected.type === 'session_selected' && selected.sessionId).toBe('review-b')
    expect(getRuntime('review-a')).toBeUndefined()

    removeRuntime('review-b')
  })

  it('意图没有评审会话时拒绝打开,不建立任何 runtime', async () => {
    const [r] = insertIntents(proj, [
      { title: 'No review', shortEnTitle: 'norev', content: '', priority: 'P2' },
    ])

    const { conn, sent } = fakeConn()
    await openSpecReviewSession(ctx, conn, {
      type: 'open_spec_review_session',
      workspaceName,
      intentId: r.id,
    })

    expect(sent.some((m) => m.type === 'session_selected')).toBe(false)
    expect(sent.find((m) => m.type === 'error')).toMatchObject({
      error: { code: 'intent.chatSessionNotFound' },
    })
    expect(conn.viewing).toBeNull()
  })

  it('意图不存在时拒绝打开', async () => {
    const { conn, sent } = fakeConn()
    await openSpecReviewSession(ctx, conn, {
      type: 'open_spec_review_session',
      workspaceName,
      intentId: 'nope',
    })

    expect(sent).toEqual([{ type: 'error', error: { code: 'intent.notFound' } }])
    expect(conn.viewing).toBeNull()
  })
})
