/**
 * Workspace activity set: non-idle runtimes ∪ running automation-log sessions,
 * de-duplicated by session id, with SessionKind preserved for classification.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionKind } from '@ccc/shared/protocol'
import { resetDbForTests } from '../../kernel/infra/db.js'
import { addWorkspace, pathToName, resetStateCacheForTests } from '../../state.js'
import { ensureRuntime, removeRuntime, setStatus } from '../../runs.js'
import { resetStoreForTests, upsertBoundRow } from './work-session-store.js'
import {
  appendExecutionLog,
  createAutomation,
  resetStoreForTests as resetAutomationStoreForTests,
} from '../automations/store.js'
import {
  countActiveSessionsForWorkspace,
  listActiveSessionsForWorkspace,
} from './active-workspace-sessions.js'

let dir: string
let proj: string
let workspaceName: string
let prevClaudeConfigDir: string | undefined
let prevHome: string | undefined
const startedRuntimes: string[] = []

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'c3-active-sessions-'))
  prevClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR
  prevHome = process.env.HOME
  process.env.HOME = dir
  process.env.CLAUDE_CONFIG_DIR = dir
  process.env.C3_DB_PATH = join(dir, 'c3.db')
  resetDbForTests()
  resetStoreForTests()
  resetAutomationStoreForTests()
  resetStateCacheForTests()
  proj = join(dir, 'proj')
  mkdirSync(proj)
  addWorkspace(proj, 1)
  workspaceName = pathToName(proj)!
})

afterEach(() => {
  for (const id of startedRuntimes) removeRuntime(id)
  startedRuntimes.length = 0
  resetDbForTests()
  resetStoreForTests()
  resetAutomationStoreForTests()
  resetStateCacheForTests()
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

function byId(sessionId: string) {
  return listActiveSessionsForWorkspace(proj).find((s) => s.sessionId === sessionId)
}

describe('listActiveSessionsForWorkspace', () => {
  it('includes a non-idle runtime and keeps its SessionKind', () => {
    row('w-run', 'work')
    startRun('w-run', proj, 'work')
    expect(byId('w-run')).toEqual({
      sessionId: 'w-run',
      sessionKind: 'work',
      source: 'runtime',
    })
    expect(countActiveSessionsForWorkspace(proj)).toBe(1)
  })

  it('omits idle runtimes', () => {
    row('w-idle', 'work')
    ensureRuntime('w-idle', proj, 'default', [], 'work')
    startedRuntimes.push('w-idle')
    expect(countActiveSessionsForWorkspace(proj)).toBe(0)
  })

  it('includes a log-only automation session as kind automation', () => {
    const id = seedLlmAutomation('auto-log')
    seedRunningLog(id, 'auto-log')
    expect(byId('auto-log')).toEqual({
      sessionId: 'auto-log',
      sessionKind: 'automation',
      source: 'automation_log',
    })
    expect(countActiveSessionsForWorkspace(proj)).toBe(1)
  })

  it('unions runtime and log-only members; a session on both surfaces counts once', () => {
    row('w-run', 'work')
    startRun('w-run', proj, 'work')
    const logOnly = seedLlmAutomation('auto-log')
    seedRunningLog(logOnly, 'auto-log')
    const both = seedLlmAutomation('auto-both')
    seedRunningLog(both, 'auto-both')
    startRun('auto-both', proj, 'automation')
    const listed = listActiveSessionsForWorkspace(proj)
    expect(listed).toHaveLength(3)
    expect(byId('w-run')?.source).toBe('runtime')
    expect(byId('auto-log')?.source).toBe('automation_log')
    expect(byId('auto-both')).toEqual({
      sessionId: 'auto-both',
      sessionKind: 'automation',
      source: 'runtime',
    })
    expect(countActiveSessionsForWorkspace(proj)).toBe(3)
  })

  it('keeps consensus / robot / tool kinds on the runtime members', () => {
    row('c-run', 'consensus')
    row('r-run', 'robot')
    row('t-run', 'tool')
    startRun('c-run', proj, 'consensus')
    startRun('r-run', proj, 'robot')
    startRun('t-run', proj, 'tool')
    expect(byId('c-run')?.sessionKind).toBe('consensus')
    expect(byId('r-run')?.sessionKind).toBe('robot')
    expect(byId('t-run')?.sessionKind).toBe('tool')
    expect(countActiveSessionsForWorkspace(proj)).toBe(3)
  })

  it('isolates workspaces', () => {
    const other = join(dir, 'other-ws')
    mkdirSync(other)
    addWorkspace(other, 2)
    row('a-run', 'work')
    row('b-run', 'work', { workspacePath: other })
    startRun('a-run', proj, 'work')
    startRun('b-run', other, 'work')
    expect(countActiveSessionsForWorkspace(proj)).toBe(1)
    expect(countActiveSessionsForWorkspace(other)).toBe(1)
  })
})
