import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ServerToClient } from '@ccc/shared/protocol'
import { resetDbForTests } from '../../kernel/infra/db.js'
import { addWorkspace, pathToName, resetStateCacheForTests } from '../../state.js'
import { ensureRuntime, removeRuntime, setStatus } from '../../runs.js'
import type { Conn } from '../../transport/handler-registry.js'
import type { KernelContext } from '../../kernel/types.js'
import type { SessionKind } from '@ccc/shared/protocol'
import { countRunningOwners, getSessionCounts } from './index.js'
import { resetStoreForTests, upsertBoundRow } from './work-session-store.js'
import {
  appendExecutionLog,
  createAutomation,
  resetStoreForTests as resetAutomationStoreForTests,
} from '../automations/store.js'
import { resetSettingsCacheForTests, saveSettings } from '../../kernel/config/index.js'

let dir: string
let proj: string
let workspaceName: string
let prevClaudeConfigDir: string | undefined
let prevHome: string | undefined

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'c3-session-counts-'))
  prevClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR
  prevHome = process.env.HOME
  process.env.HOME = dir
  process.env.CLAUDE_CONFIG_DIR = dir
  process.env.C3_DB_PATH = join(dir, 'c3.db')
  resetDbForTests()
  resetStoreForTests()
  resetAutomationStoreForTests()
  resetSettingsCacheForTests()
  resetStateCacheForTests()
  proj = join(dir, 'proj')
  mkdirSync(proj)
  addWorkspace(proj, 1)
  workspaceName = pathToName(proj)!
})

afterEach(() => {
  removeRuntime('work-running')
  removeRuntime('spec-running')
  removeRuntime('intent-running')
  removeRuntime('discussion-running')
  removeRuntime('tool-running')
  for (const id of startedRuntimes) removeRuntime(id)
  startedRuntimes.length = 0
  resetDbForTests()
  resetStoreForTests()
  resetAutomationStoreForTests()
  resetStateCacheForTests()
  resetSettingsCacheForTests()
  if (prevClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = prevClaudeConfigDir
  if (prevHome === undefined) delete process.env.HOME
  else process.env.HOME = prevHome
  delete process.env.C3_DB_PATH
  rmSync(dir, { recursive: true, force: true })
})

/** Runtime ids started by the owner-count tests, torn down in `afterEach`. */
const startedRuntimes: string[] = []

/** Mark a session as running the way activity queries observe it (live handle + status). */
function startRun(sessionId: string, workspacePath: string, kind: SessionKind): void {
  const rt = ensureRuntime(sessionId, workspacePath, 'default', [], kind)
  rt.run = {
    abort: new AbortController(),
    handle: null,
  }
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

describe('getSessionCounts', () => {
  it('counts only running rows inside each session_kind bucket', () => {
    upsertBoundRow({
      sessionId: 'work-running',
      workspacePath: proj,
      vendor: 'claude',
      agentId: 'agent-work',
      title: 'Work',
      sessionKind: 'work',
    })
    upsertBoundRow({
      sessionId: 'spec-running',
      workspacePath: proj,
      vendor: 'claude',
      agentId: 'agent-spec',
      title: 'Spec',
      sessionKind: 'spec',
      ownerKind: 'intent',
      ownerId: 'intent-1',
    })
    upsertBoundRow({
      sessionId: 'spec-idle',
      workspacePath: proj,
      vendor: 'claude',
      agentId: 'agent-spec',
      title: 'Spec idle',
      sessionKind: 'spec',
      ownerKind: 'intent',
      ownerId: 'intent-2',
    })
    upsertBoundRow({
      sessionId: 'intent-running',
      workspacePath: proj,
      vendor: 'claude',
      agentId: 'agent-intent',
      title: 'Intent',
      sessionKind: 'intent',
      ownerKind: 'intent',
      ownerId: 'intent-3',
    })
    const automation = createAutomation({
      type: 'llm',
      config: { prompt: 'run' },
      workspaceName,
      vendor: 'claude',
      agentId: 'agent-automation',
      triggerType: 'cron',
      cronExpression: '0 1 * * *',
      mode: 'default',
    })
    upsertBoundRow({
      sessionId: 'automation-running',
      workspacePath: proj,
      vendor: 'claude',
      agentId: 'agent-automation',
      title: 'Automation run',
      sessionKind: 'automation',
      ownerKind: 'automation',
      ownerId: automation.id,
    })
    appendExecutionLog({
      automationId: automation.id,
      startedAt: Date.now(),
      finishedAt: null,
      exitCode: null,
      output: '',
      error: null,
      status: 'running',
      sessionId: 'automation-running',
    })
    upsertBoundRow({
      sessionId: 'discussion-running',
      workspacePath: proj,
      vendor: 'claude',
      agentId: 'agent-discussion',
      title: 'Discussion',
      sessionKind: 'discussion',
      ownerKind: 'discussion',
      ownerId: 'discussion-1',
    })
    upsertBoundRow({
      sessionId: 'discussion-idle',
      workspacePath: proj,
      vendor: 'codex',
      agentId: 'agent-discussion',
      title: 'Discussion idle',
      sessionKind: 'discussion',
      ownerKind: 'discussion',
      ownerId: 'discussion-1',
    })
    upsertBoundRow({
      sessionId: 'tool-running',
      workspacePath: proj,
      vendor: 'claude',
      agentId: 'tool-agent',
      title: 'Tool',
      sessionKind: 'tool',
      ownerKind: 'intent',
      ownerId: 'intent-4',
    })

    startRun('work-running', proj, 'work')
    startRun('spec-running', proj, 'spec')
    startRun('intent-running', proj, 'intent')
    startRun('discussion-running', proj, 'discussion')
    startRun('tool-running', proj, 'tool')

    const { conn, sent } = fakeConn()
    getSessionCounts({} as KernelContext, conn, { type: 'get_session_counts', workspaceName })

    expect(sent).toEqual([
      {
        type: 'session_counts',
        workspaceName,
        counts: {
          work: 1,
          intent: 1,
          spec: 1,
          spec_review: 0,
          discussion: 1,
          automation: 1,
          tool: 0,
        },
        // 条目口径:intent-1(spec 会话)、intent-3(意图会话)、intent-4(隐藏的 tool
        // 会话仍驱动其 owner)= 3;discussion-1 的两个会话去重后 = 1;automation = 1。
        ownerCounts: { intent: 3, discussion: 1, automation: 1 },
        // workspace 级口径:与 Dashboard 同一活动集合。work/spec/intent/discussion/tool
        // 五个非空闲 runtime,加上仅有执行日志的 automation,去重后 = 6。
        // spec-idle、discussion-idle 不计。与 ownerCounts 的 5 是两个不同的数。
        runningSessionCount: 6,
      },
    ])

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
    const again = fakeConn()
    getSessionCounts({} as KernelContext, again.conn, { type: 'get_session_counts', workspaceName })
    expect(again.sent[0]).toMatchObject({
      type: 'session_counts',
      counts: { tool: 1 },
    })
  })
})

// 「规范」是聚合分类:spec 撰写 + spec_review 评审共用一个角标,兼容字段 spec_review
// 保持 0,以免旧/新客户端把同一批会话在顶栏总数里算两次。
describe('getSessionCounts — 规范聚合', () => {
  function specRow(sessionId: string, kind: SessionKind, ownerId: string): void {
    upsertBoundRow({
      sessionId,
      workspacePath: proj,
      vendor: 'claude',
      agentId: 'agent-spec',
      title: sessionId,
      sessionKind: kind,
      ownerKind: 'intent',
      ownerId,
    })
  }

  it('把运行中的 spec 与 spec_review 会话计入同一个 spec 角标,idle 不计', () => {
    specRow('spec-a', 'spec', 'intent-1')
    specRow('spec-idle', 'spec', 'intent-2')
    specRow('review-a', 'spec_review', 'intent-1')
    specRow('review-b', 'spec_review', 'intent-3')
    specRow('review-idle', 'spec_review', 'intent-4')

    startRun('spec-a', proj, 'spec')
    startRun('review-a', proj, 'spec_review')
    startRun('review-b', proj, 'spec_review')

    const { conn, sent } = fakeConn()
    getSessionCounts({} as KernelContext, conn, { type: 'get_session_counts', workspaceName })

    const counts = (sent[0] as Extract<ServerToClient, { type: 'session_counts' }>).counts
    // 1 个 spec + 2 个 spec_review,每个会话只算一次。
    expect(counts.spec).toBe(3)
    // 兼容字段不形成第二个可见口径,故顶栏总数不重复计算。
    expect(counts.spec_review).toBe(0)
    expect(counts.work).toBe(0)
  })
})

// Workspace 级「运行中会话数」:与 Dashboard 共用同一活动集合(非空闲 runtime ∪
// 在途自动化执行会话),不分桶、不受 showToolSessions 影响,与 counts(按 kind
// 分桶)、ownerCounts(按 owner 去重)是三个互不替代的数。
describe('getSessionCounts — 每 workspace 运行中会话数', () => {
  function countOf(sent: ServerToClient[]): number | undefined {
    const msg = sent[0] as Extract<ServerToClient, { type: 'session_counts' }>
    return msg.runningSessionCount
  }

  function row(sessionId: string, kind: SessionKind, workspacePath = proj): void {
    upsertBoundRow({
      sessionId,
      workspacePath,
      vendor: 'claude',
      agentId: 'agent',
      title: sessionId,
      sessionKind: kind,
    })
  }

  it('跨 kind 求和,idle 会话不计入;无运行会话时为 0', () => {
    row('w-run', 'work')
    row('i-run', 'intent')
    row('s-run', 'spec')
    row('d-run', 'discussion')
    row('r-run', 'robot')
    row('w-idle', 'work')
    startRun('w-run', proj, 'work')
    startRun('i-run', proj, 'intent')
    startRun('s-run', proj, 'spec')
    startRun('d-run', proj, 'discussion')
    startRun('r-run', proj, 'robot')

    const { conn, sent } = fakeConn()
    getSessionCounts({} as KernelContext, conn, { type: 'get_session_counts', workspaceName })
    // 5 个运行会话(w/i/s/d/robot),w-idle 不计。robot 计入:这类会话同样持有落在
    // 该 workspace 上的活跃 run,漏掉它会显示「有活儿在跑却是 0」。
    expect(countOf(sent)).toBe(5)

    // 全部结束后归零。
    for (const id of ['w-run', 'i-run', 's-run', 'd-run', 'r-run']) removeRuntime(id)
    const empty = fakeConn()
    getSessionCounts({} as KernelContext, empty.conn, { type: 'get_session_counts', workspaceName })
    expect(countOf(empty.sent)).toBe(0)
  })

  it('其他 workspace 的运行会话不计入(跨 workspace 隔离)', () => {
    const other = join(dir, 'other-ws')
    mkdirSync(other)
    addWorkspace(other, 2)
    row('mine', 'work')
    row('theirs', 'work', other)
    startRun('mine', proj, 'work')
    startRun('theirs', other, 'work')

    const own = fakeConn()
    getSessionCounts({} as KernelContext, own.conn, { type: 'get_session_counts', workspaceName })
    expect(countOf(own.sent)).toBe(1)

    const theirName = pathToName(other)!
    const theirs = fakeConn()
    getSessionCounts({} as KernelContext, theirs.conn, {
      type: 'get_session_counts',
      workspaceName: theirName,
    })
    expect(countOf(theirs.sent)).toBe(1)
  })

  it('showToolSessions 关闭时 running 的 tool 会话仍计入', () => {
    row('t-run', 'tool')
    startRun('t-run', proj, 'tool')
    // 该设置默认关闭,故 counts.tool 为 0,而 workspace 级计数仍为 1 —— 两者互不干扰。
    const { conn, sent } = fakeConn()
    getSessionCounts({} as KernelContext, conn, { type: 'get_session_counts', workspaceName })
    const msg = sent[0] as Extract<ServerToClient, { type: 'session_counts' }>
    expect(msg.counts.tool).toBe(0)
    expect(msg.runningSessionCount).toBe(1)
  })
})

// 顶部「意图/讨论/自动化」角标的权威口径:按 (ownerKind, ownerId) 去重的进行中条目数。
describe('countRunningOwners', () => {
  function ownedRow(input: {
    sessionId: string
    sessionKind: SessionKind
    ownerKind?: 'intent' | 'discussion' | 'automation'
    ownerId?: string
    workspacePath?: string
  }): void {
    upsertBoundRow({
      sessionId: input.sessionId,
      workspacePath: input.workspacePath ?? proj,
      vendor: 'claude',
      agentId: 'agent',
      title: input.sessionId,
      sessionKind: input.sessionKind,
      ownerKind: input.ownerKind,
      ownerId: input.ownerId,
    })
  }

  it('同一 owner 的多个运行会话只计 1', () => {
    ownedRow({ sessionId: 'i-a', sessionKind: 'intent', ownerKind: 'intent', ownerId: 'intent-1' })
    ownedRow({ sessionId: 'i-b', sessionKind: 'spec', ownerKind: 'intent', ownerId: 'intent-1' })
    ownedRow({ sessionId: 'i-c', sessionKind: 'work', ownerKind: 'intent', ownerId: 'intent-1' })
    startRun('i-a', proj, 'intent')
    startRun('i-b', proj, 'spec')
    startRun('i-c', proj, 'work')
    expect(countRunningOwners(proj)).toEqual({ intent: 1, discussion: 0, automation: 0 })
  })

  it('运行与 idle 混合仍计 1;全部 idle 计 0', () => {
    ownedRow({
      sessionId: 'd-a',
      sessionKind: 'discussion',
      ownerKind: 'discussion',
      ownerId: 'd1',
    })
    ownedRow({
      sessionId: 'd-b',
      sessionKind: 'discussion',
      ownerKind: 'discussion',
      ownerId: 'd1',
    })
    expect(countRunningOwners(proj).discussion).toBe(0)
    startRun('d-a', proj, 'discussion')
    expect(countRunningOwners(proj).discussion).toBe(1)
  })

  it('三种 owner 各自分桶,互不串位', () => {
    ownedRow({ sessionId: 'x1', sessionKind: 'intent', ownerKind: 'intent', ownerId: 'i1' })
    ownedRow({ sessionId: 'x2', sessionKind: 'intent', ownerKind: 'intent', ownerId: 'i2' })
    ownedRow({ sessionId: 'x3', sessionKind: 'discussion', ownerKind: 'discussion', ownerId: 'd1' })
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
    startRun('x1', proj, 'intent')
    startRun('x2', proj, 'intent')
    startRun('x3', proj, 'discussion')
    // Automation "in progress" is the execution log's job, not a running runtime.
    appendExecutionLog({
      automationId: automation.id,
      startedAt: Date.now(),
      finishedAt: null,
      exitCode: null,
      output: '',
      error: null,
      status: 'running',
      sessionId: 'x4',
    })
    expect(countRunningOwners(proj)).toEqual({ intent: 2, discussion: 1, automation: 1 })
  })

  it('仅有 automation 会话在运行(无 running 执行日志)不计入角标', () => {
    ownedRow({
      sessionId: 'auto-sess',
      sessionKind: 'automation',
      ownerKind: 'automation',
      ownerId: 'a-no-log',
    })
    startRun('auto-sess', proj, 'automation')
    expect(countRunningOwners(proj).automation).toBe(0)
  })

  it('command 类型自动化执行中不计入角标(与列表绿点一致)', () => {
    const automation = createAutomation({
      type: 'command',
      config: { command: 'echo hi' },
      workspaceName,
      vendor: 'claude',
      triggerType: 'cron',
      cronExpression: '0 1 * * *',
      mode: 'default',
    })
    appendExecutionLog({
      automationId: automation.id,
      startedAt: Date.now(),
      finishedAt: null,
      exitCode: null,
      output: '',
      error: null,
      status: 'running',
      sessionId: 'cmd-sess',
    })
    expect(countRunningOwners(proj).automation).toBe(0)
  })

  it('无 owner 的运行会话不计入任何条目桶', () => {
    ownedRow({ sessionId: 'plain', sessionKind: 'work' })
    startRun('plain', proj, 'work')
    expect(countRunningOwners(proj)).toEqual({ intent: 0, discussion: 0, automation: 0 })
  })

  it('其他 workspace 的运行条目不计入', () => {
    const other = join(dir, 'other')
    mkdirSync(other)
    addWorkspace(other, 2)
    ownedRow({
      sessionId: 'o1',
      sessionKind: 'intent',
      ownerKind: 'intent',
      ownerId: 'i-other',
      workspacePath: other,
    })
    startRun('o1', other, 'intent')
    expect(countRunningOwners(proj).intent).toBe(0)
    expect(countRunningOwners(other).intent).toBe(1)
  })

  it('自动化执行日志为 running 时,即使没有活跃 runtime 也计入', () => {
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
    ownedRow({
      sessionId: 'auto-1',
      sessionKind: 'automation',
      ownerKind: 'automation',
      ownerId: automation.id,
    })
    expect(countRunningOwners(proj).automation).toBe(0)
    appendExecutionLog({
      automationId: automation.id,
      startedAt: Date.now(),
      finishedAt: null,
      exitCode: null,
      output: '',
      error: null,
      status: 'running',
      sessionId: 'auto-1',
    })
    expect(countRunningOwners(proj).automation).toBe(1)
  })
})
