/**
 * 「规范」是显示分类,不是真实 kind:`listSessionsVia('spec')` 必须把 `spec` 撰写会话与
 * `spec_review` 评审会话作为同一个结果集返回,并保持一条全局的更新时间倒序 —— 首屏、
 * 加载更多与窗口刷新分页在这条序列上都不能漏项或重项。行的真实 `sessionKind` / owner
 * 原样保留(后续选择与溯源要用),其他分类不得混入。
 *
 * 与 `spec-sessions-hidden.test.ts` 一样 mock 掉 SDK 列举:投影行由测试直接写入,
 * 断言只覆盖 c3 的合并 / 排序 / 分页层。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionKind } from '@ccc/shared/protocol'

const { listSessionsMock } = vi.hoisted(() => ({ listSessionsMock: vi.fn() }))
vi.mock('@anthropic-ai/claude-agent-sdk', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>
  return { ...actual, listSessions: listSessionsMock }
})

import { resetDbForTests } from './kernel/infra/db.js'
import { resetStoreForTests } from './features/intents/store.js'
import {
  resetStoreForTests as resetSessionsStoreForTests,
  upsertBoundRow,
} from './features/works/work-session-store.js'
import { ClaudeSessionStore } from './kernel/agent/adapters/claude/session-store.js'
import { SessionAccessor } from './kernel/agent/session/accessor.js'
import { listSessionsVia, sessionKindsForCategory } from './kernel/agent/session/list-sessions.js'
import { paginateSessions } from './kernel/agent/session/paginate-sessions.js'

const proj = '/abs/spec-aggregate-proj'
let dir: string

function accessor(): SessionAccessor {
  return new SessionAccessor([{ vendor: 'claude', sessions: new ClaudeSessionStore() }])
}

function row(sessionId: string, kind: SessionKind, lastModified: number, ownerId: string): void {
  upsertBoundRow({
    sessionId,
    workspacePath: proj,
    vendor: 'claude',
    agentId: 'agent-spec',
    title: sessionId,
    lastModified,
    sessionKind: kind,
    ownerKind: 'intent',
    ownerId,
  })
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'c3-spec-aggregate-'))
  process.env.C3_DB_PATH = join(dir, 'c3.db')
  resetDbForTests()
  resetStoreForTests()
  resetSessionsStoreForTests()
  listSessionsMock.mockReset()
  listSessionsMock.mockResolvedValue([])
})

afterEach(() => {
  resetDbForTests()
  delete process.env.C3_DB_PATH
  rmSync(dir, { recursive: true, force: true })
})

describe('sessionKindsForCategory', () => {
  it('只有 spec 是聚合分类,其余分类维持单一 kind', () => {
    expect(sessionKindsForCategory('spec')).toEqual(['spec', 'spec_review'])
    for (const kind of ['work', 'intent', 'discussion', 'automation', 'tool'] as const) {
      expect(sessionKindsForCategory(kind)).toEqual([kind])
    }
  })
})

describe('listSessionsVia — 规范聚合', () => {
  it('把 spec 与 spec_review 混合成一条全局倒序流,保留真实 kind 与 owner', async () => {
    row('spec-old', 'spec', 100, 'intent-1')
    row('review-newest', 'spec_review', 400, 'intent-2')
    row('spec-mid', 'spec', 300, 'intent-2')
    row('review-old', 'spec_review', 200, 'intent-1')
    // 其他分类不得混入。
    row('work-1', 'work', 500, 'intent-1')
    row('intent-1-sess', 'intent', 450, 'intent-1')

    const out = await listSessionsVia(accessor(), proj, 'spec')

    expect(out.map((s) => s.sessionId)).toEqual([
      'review-newest',
      'spec-mid',
      'review-old',
      'spec-old',
    ])
    const review = out.find((s) => s.sessionId === 'review-newest')!
    expect(review.sessionKind).toBe('spec_review')
    expect(review.ownerKind).toBe('intent')
    expect(review.ownerId).toBe('intent-2')
    expect(out.find((s) => s.sessionId === 'spec-mid')!.sessionKind).toBe('spec')
  })

  it('首屏 / 加载更多 / 窗口刷新在合并序列上无遗漏无重复', async () => {
    row('s-500', 'spec', 500, 'intent-1')
    row('r-400', 'spec_review', 400, 'intent-1')
    row('s-300', 'spec', 300, 'intent-2')
    row('r-200', 'spec_review', 200, 'intent-2')
    row('s-100', 'spec', 100, 'intent-3')

    const all = await listSessionsVia(accessor(), proj, 'spec')

    const first = paginateSessions(all, { limit: 2 })
    expect(first.sessions.map((s) => s.sessionId)).toEqual(['s-500', 'r-400'])
    expect(first.kind).toBe('first')
    expect(first.hasMore).toBe(true)

    const oldest = first.sessions[first.sessions.length - 1]
    const more = paginateSessions(all, {
      limit: 2,
      before: { lastModified: oldest.lastModified, sessionId: oldest.sessionId },
    })
    expect(more.sessions.map((s) => s.sessionId)).toEqual(['s-300', 'r-200'])
    expect(more.kind).toBe('older')

    const last = more.sessions[more.sessions.length - 1]
    const tail = paginateSessions(all, {
      limit: 2,
      before: { lastModified: last.lastModified, sessionId: last.sessionId },
    })
    expect(tail.sessions.map((s) => s.sessionId)).toEqual(['s-100'])
    expect(tail.hasMore).toBe(false)

    // 三页拼起来恰好等于合并序列,既不漏也不重。
    expect([...first.sessions, ...more.sessions, ...tail.sessions].map((s) => s.sessionId)).toEqual(
      all.map((s) => s.sessionId),
    )

    // 窗口刷新(since = 已加载最旧)同样两类都在,且不带出更早的行。
    const refreshed = paginateSessions(all, { since: 200 })
    expect(refreshed.kind).toBe('window')
    expect(refreshed.sessions.map((s) => s.sessionId)).toEqual(['s-500', 'r-400', 's-300', 'r-200'])
  })

  it('spec_review 行不出现在工作会话列表里', async () => {
    row('r-1', 'spec_review', 400, 'intent-1')
    row('w-1', 'work', 300, 'intent-1')

    const work = await listSessionsVia(accessor(), proj, 'work')
    expect(work.map((s) => s.sessionId)).toEqual(['w-1'])
  })
})
