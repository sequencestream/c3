import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ServerToClient } from '@ccc/shared/protocol'
import { resetDbForTests } from '../../kernel/infra/db.js'
import { addWorkspace, pathToId, resetStateCacheForTests } from '../../state.js'
import { ensureRuntime, removeRuntime } from '../../runs.js'
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
let workspaceId: string
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
  workspaceId = pathToId(proj)!
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

/** Mark a session as running the way `isRunning` observes it (a live run handle). */
function startRun(sessionId: string, workspacePath: string, kind: SessionKind): void {
  ensureRuntime(sessionId, workspacePath, 'default', [], kind).run = {
    abort: new AbortController(),
    handle: null,
  }
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
      workspaceId,
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

    ensureRuntime('work-running', proj, 'default', [], 'work').run = {
      abort: new AbortController(),
      handle: null,
    }
    ensureRuntime('spec-running', proj, 'default', [], 'spec').run = {
      abort: new AbortController(),
      handle: null,
    }
    ensureRuntime('intent-running', proj, 'default', [], 'intent').run = {
      abort: new AbortController(),
      handle: null,
    }
    ensureRuntime('discussion-running', proj, 'default', [], 'discussion').run = {
      abort: new AbortController(),
      handle: null,
    }
    ensureRuntime('tool-running', proj, 'default', [], 'tool').run = {
      abort: new AbortController(),
      handle: null,
    }

    const { conn, sent } = fakeConn()
    getSessionCounts({} as KernelContext, conn, { type: 'get_session_counts', workspaceId })

    expect(sent).toEqual([
      {
        type: 'session_counts',
        workspaceId,
        counts: {
          work: 1,
          intent: 1,
          spec: 1,
          discussion: 1,
          automation: 1,
          tool: 0,
        },
        // 条目口径:intent-1(spec 会话)、intent-3(意图会话)、intent-4(隐藏的 tool
        // 会话仍驱动其 owner)= 3;discussion-1 的两个会话去重后 = 1;automation = 1。
        ownerCounts: { intent: 3, discussion: 1, automation: 1 },
      },
    ])

    saveSettings({
      agents: [],
      defaultAgentId: 'system',
      toolAgentId: '',
      intentAgentId: '',
      specAgentId: '',
      automationAgentId: '',
      sandboxDefaultAgentId: '',
      sandboxToolAgentId: '',
      sandboxIntentAgentId: '',
      sandboxSpecAgentId: '',
      sandboxAutomationAgentId: '',
      showToolSessions: true,
    })
    const again = fakeConn()
    getSessionCounts({} as KernelContext, again.conn, { type: 'get_session_counts', workspaceId })
    expect(again.sent[0]).toMatchObject({
      type: 'session_counts',
      counts: { tool: 1 },
    })
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
    ownedRow({ sessionId: 'x4', sessionKind: 'automation', ownerKind: 'automation', ownerId: 'a1' })
    startRun('x1', proj, 'intent')
    startRun('x2', proj, 'intent')
    startRun('x3', proj, 'discussion')
    startRun('x4', proj, 'automation')
    expect(countRunningOwners(proj)).toEqual({ intent: 2, discussion: 1, automation: 1 })
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
      workspaceId,
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
