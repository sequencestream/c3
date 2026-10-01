/**
 * Activity-badge口径契约:冻结每个数字的当前含义,并用预期失败用例表达已知缺陷。
 *
 * 三个互不替代的数:`counts`(会话页分类)、`ownerCounts`(条目去重)、
 * `runningSessionCount`(工作区竖条)。后者与 Dashboard `sessions.running` 共用
 * 同一活动集合。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ServerToClient, SessionKind } from '@ccc/shared/protocol'
import { resetDbForTests } from '../../kernel/infra/db.js'
import { addWorkspace, pathToName, resetStateCacheForTests } from '../../state.js'
import { ensureRuntime, removeRuntime, setStatus } from '../../runs.js'
import type { Conn } from '../../transport/handler-registry.js'
import type { KernelContext } from '../../kernel/types.js'
import { countRunningOwners, getSessionCounts } from './index.js'
import { resetStoreForTests, upsertBoundRow } from './work-session-store.js'
import {
  appendExecutionLog,
  countAutomationsInRange,
  createAutomation,
  resetStoreForTests as resetAutomationStoreForTests,
} from '../automations/store.js'
import {
  countByStatusInRange as countIntentsByStatus,
  resetStoreForTests as resetIntents,
} from '../intents/store.js'
import {
  countByStatusInRange as countDiscussionsByStatus,
  resetStoreForTests as resetDiscussions,
} from '../discussions/store.js'
import { resetSettingsCacheForTests, saveSettings } from '../../kernel/config/index.js'
import { getWorkspaceDashboardHandler } from '../workcenter/index.js'

let dir: string
let proj: string
let workspaceName: string
let prevClaudeConfigDir: string | undefined
let prevHome: string | undefined

const startedRuntimes: string[] = []

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'c3-badge-contract-'))
  prevClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR
  prevHome = process.env.HOME
  process.env.HOME = dir
  process.env.CLAUDE_CONFIG_DIR = dir
  process.env.C3_DB_PATH = join(dir, 'c3.db')
  resetDbForTests()
  resetStoreForTests()
  resetAutomationStoreForTests()
  resetIntents()
  resetDiscussions()
  resetSettingsCacheForTests()
  resetStateCacheForTests()
  proj = join(dir, 'proj')
  mkdirSync(proj)
  addWorkspace(proj, 1)
  workspaceName = pathToName(proj)!
  countIntentsByStatus(proj)
  countDiscussionsByStatus(proj)
  countAutomationsInRange(proj)
})

afterEach(() => {
  for (const id of startedRuntimes) removeRuntime(id)
  startedRuntimes.length = 0
  resetDbForTests()
  resetStoreForTests()
  resetAutomationStoreForTests()
  resetIntents()
  resetDiscussions()
  resetStateCacheForTests()
  resetSettingsCacheForTests()
  if (prevClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = prevClaudeConfigDir
  if (prevHome === undefined) delete process.env.HOME
  else process.env.HOME = prevHome
  delete process.env.C3_DB_PATH
  rmSync(dir, { recursive: true, force: true })
})

function startRun(sessionId: string, workspacePath: string, kind: SessionKind): void {
  const rt = ensureRuntime(sessionId, workspacePath, 'default', [], kind)
  rt.run = { abort: new AbortController(), handle: null }
  setStatus(sessionId, 'running')
  startedRuntimes.push(sessionId)
}

function fakeConn(): { conn: Conn; sent: ServerToClient[] } {
  const sent: ServerToClient[] = []
  return {
    sent,
    conn: {
      send: (m: ServerToClient) => sent.push(m),
      viewing: null,
      deliver: () => {},
      sendWorkspaces: () => {},
      sendSessions: async () => {},
      subject: null,
      authed: true,
      authToken: null,
    } as Conn,
  }
}

function row(
  sessionId: string,
  kind: SessionKind,
  extra: {
    ownerKind?: 'intent' | 'discussion' | 'automation'
    ownerId?: string
    workspacePath?: string
  } = {},
): void {
  upsertBoundRow({
    sessionId,
    workspacePath: extra.workspacePath ?? proj,
    vendor: 'claude',
    agentId: 'agent',
    title: sessionId,
    sessionKind: kind,
    ownerKind: extra.ownerKind,
    ownerId: extra.ownerId,
  })
}

function sessionCountsMsg(
  name = workspaceName,
): Extract<ServerToClient, { type: 'session_counts' }> {
  const { conn, sent } = fakeConn()
  getSessionCounts({} as KernelContext, conn, { type: 'get_session_counts', workspaceName: name })
  const msg = sent[0]
  if (!msg || msg.type !== 'session_counts') throw new Error('expected session_counts')
  return msg
}

function dashboardRunning(name = workspaceName): number {
  const { conn, sent } = fakeConn()
  getWorkspaceDashboardHandler({} as KernelContext, conn, { type: 'get_workspace_dashboard' })
  const msg = sent[0]
  if (!msg || msg.type !== 'workspace_dashboard') throw new Error('expected workspace_dashboard')
  const found = msg.rows.find((r) => r.workspaceName === name)
  if (!found) throw new Error(`dashboard row missing for ${name}`)
  return found.sessions.running
}

function seedLlmAutomation(sessionId: string): string {
  const automation = createAutomation({
    type: 'llm',
    config: { prompt: 'run' },
    workspaceName,
    vendor: 'claude',
    agentId: 'agent',
    triggerType: 'cron',
    cronExpression: '0 1 * * *',
    mode: 'default',
  })
  row(sessionId, 'automation', { ownerKind: 'automation', ownerId: automation.id })
  return automation.id
}

function seedRunningLog(automationId: string, sessionId: string): void {
  appendExecutionLog({
    automationId,
    startedAt: Date.now(),
    finishedAt: null,
    exitCode: null,
    output: '',
    error: null,
    status: 'running',
    sessionId,
  })
}

describe('种类计入矩阵 — 会话页分类 vs 工作区总数', () => {
  it('work/intent/discussion 同时计入分类角标与工作区总数', () => {
    row('w', 'work')
    row('i', 'intent', { ownerKind: 'intent', ownerId: 'intent-1' })
    row('d', 'discussion', { ownerKind: 'discussion', ownerId: 'd1' })
    startRun('w', proj, 'work')
    startRun('i', proj, 'intent')
    startRun('d', proj, 'discussion')
    const msg = sessionCountsMsg()
    expect(msg.counts.work).toBe(1)
    expect(msg.counts.intent).toBe(1)
    expect(msg.counts.discussion).toBe(1)
    expect(msg.runningSessionCount).toBe(3)
  })

  it('spec_review 并入 spec 分类,线字段恒为 0,但仍计入工作区总数', () => {
    row('spec-a', 'spec', { ownerKind: 'intent', ownerId: 'i1' })
    row('review-a', 'spec_review', { ownerKind: 'intent', ownerId: 'i1' })
    startRun('spec-a', proj, 'spec')
    startRun('review-a', proj, 'spec_review')
    const msg = sessionCountsMsg()
    expect(msg.counts.spec).toBe(2)
    expect(msg.counts.spec_review).toBe(0)
    expect(msg.runningSessionCount).toBe(2)
  })

  it('consensus 不进会话页分类,有活跃 run 时计入工作区总数', () => {
    row('c-run', 'consensus')
    startRun('c-run', proj, 'consensus')
    const msg = sessionCountsMsg()
    expect(msg.counts).not.toHaveProperty('consensus')
    expect(msg.counts.work).toBe(0)
    expect(msg.runningSessionCount).toBe(1)
  })

  it('robot 不进会话页分类,有活跃 run 时计入工作区总数', () => {
    row('r-run', 'robot')
    startRun('r-run', proj, 'robot')
    const msg = sessionCountsMsg()
    expect(msg.counts).not.toHaveProperty('robot')
    expect(msg.runningSessionCount).toBe(1)
  })

  it('showToolSessions 关闭时 tool 不进分类角标,仍计入工作区总数', () => {
    row('t-run', 'tool', { ownerKind: 'intent', ownerId: 'i-tool' })
    startRun('t-run', proj, 'tool')
    const msg = sessionCountsMsg()
    expect(msg.counts.tool).toBe(0)
    expect(msg.runningSessionCount).toBe(1)
    expect(countRunningOwners(proj).intent).toBe(1)
  })

  it('showToolSessions 打开时 tool 同时计入分类角标与工作区总数', () => {
    saveSettings({
      agents: [],
      defaultAgentId: 'system',
      toolAgentId: '',
      intentAgentId: '',
      specAgentId: '',
      specReviewAgentId: '',
      automationAgentId: '',
      reviewAgentId: '',
      fixAgentId: '',
      workAgentId: '',
      showToolSessions: true,
    })
    row('t-run', 'tool')
    startRun('t-run', proj, 'tool')
    const msg = sessionCountsMsg()
    expect(msg.counts.tool).toBe(1)
    expect(msg.runningSessionCount).toBe(1)
  })

  it('自动化分类走执行日志;仅有活跃 run、没有 running 日志时分类为 0', () => {
    seedLlmAutomation('auto-rt')
    startRun('auto-rt', proj, 'automation')
    const msg = sessionCountsMsg()
    expect(msg.counts.automation).toBe(0)
    expect(msg.runningSessionCount).toBe(1)
  })

  it('仅有执行日志的自动化同时计入分类角标与工作区总数', () => {
    const id = seedLlmAutomation('auto-log')
    seedRunningLog(id, 'auto-log')
    const msg = sessionCountsMsg()
    expect(msg.counts.automation).toBe(1)
    expect(msg.runningSessionCount).toBe(1)
  })
})

describe('owner 去重', () => {
  it('一个意图两个运行中 Session 仍只计一个意图', () => {
    row('i-a', 'intent', { ownerKind: 'intent', ownerId: 'intent-1' })
    row('i-b', 'spec', { ownerKind: 'intent', ownerId: 'intent-1' })
    startRun('i-a', proj, 'intent')
    startRun('i-b', proj, 'spec')
    expect(sessionCountsMsg().ownerCounts.intent).toBe(1)
    expect(sessionCountsMsg().runningSessionCount).toBe(2)
  })
})

describe('多 Workspace 后台运行 — 服务端可按工作区独立读取', () => {
  it('A 与 B 同时运行时,各自请求只看到本工作区的权威数', () => {
    const other = join(dir, 'other-ws')
    mkdirSync(other)
    addWorkspace(other, 2)
    const otherName = pathToName(other)!
    row('a-run', 'work')
    row('b-run', 'work', { workspacePath: other })
    startRun('a-run', proj, 'work')
    startRun('b-run', other, 'work')
    expect(sessionCountsMsg(workspaceName).runningSessionCount).toBe(1)
    expect(sessionCountsMsg(otherName).runningSessionCount).toBe(1)
  })
})

describe('自动化 Runtime 与执行日志并集', () => {
  it('同时出现在 Runtime 和执行日志时,runningSessionCount 与 Dashboard 都只计一次', () => {
    const id = seedLlmAutomation('auto-both')
    seedRunningLog(id, 'auto-both')
    startRun('auto-both', proj, 'automation')
    expect(sessionCountsMsg().runningSessionCount).toBe(1)
    expect(dashboardRunning()).toBe(1)
  })

  it('仅执行日志的自动化,runningSessionCount 与 Dashboard 都计 1', () => {
    const id = seedLlmAutomation('auto-log-only')
    seedRunningLog(id, 'auto-log-only')
    expect(sessionCountsMsg().runningSessionCount).toBe(1)
    expect(dashboardRunning()).toBe(1)
  })

  it('同一工作区 runningSessionCount 与 Dashboard.sessions.running 一致', () => {
    row('w-run', 'work')
    startRun('w-run', proj, 'work')
    const id = seedLlmAutomation('auto-log-only')
    seedRunningLog(id, 'auto-log-only')
    expect(sessionCountsMsg().runningSessionCount).toBe(2)
    expect(sessionCountsMsg().runningSessionCount).toBe(dashboardRunning())
  })
})
