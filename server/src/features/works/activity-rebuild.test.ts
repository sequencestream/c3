/**
 * Activity registry rebuild matches the workspace activity union
 * (non-idle runtimes ∪ running automation-log sessions).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionKind } from '@ccc/shared/protocol'
import { resetDbForTests } from '../../kernel/infra/db.js'
import {
  activityRegistry,
  badgeProjection,
  resetActivityRegistryForTests,
  RUNNING_LEASE_MS,
  setActivityOwnerResolver,
  setActivityWorkspaceNameResolver,
} from '../../kernel/activity/index.js'
import { addWorkspace, pathToName, resetStateCacheForTests } from '../../state.js'
import { ensureRuntime, getRuntime, removeRuntime, setStatus } from '../../runs.js'
import { resetStoreForTests, upsertBoundRow } from './work-session-store.js'
import {
  appendExecutionLog,
  createAutomation,
  reconcileStuckRunningExecutions,
  resetStoreForTests as resetAutomationStoreForTests,
} from '../automations/store.js'
import { listActiveSessionsForWorkspace } from './active-workspace-sessions.js'
import {
  lookupActivityOwner,
  rebuildActivityRegistry,
  reconcileActivityProjection,
} from './activity-rebuild.js'

let dir: string
let proj: string
let workspaceName: string
let prevClaudeConfigDir: string | undefined
let prevHome: string | undefined
const startedRuntimes: string[] = []

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'c3-activity-rebuild-'))
  prevClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR
  prevHome = process.env.HOME
  process.env.HOME = dir
  process.env.CLAUDE_CONFIG_DIR = dir
  process.env.C3_DB_PATH = join(dir, 'c3.db')
  resetDbForTests()
  resetStoreForTests()
  resetAutomationStoreForTests()
  resetStateCacheForTests()
  resetActivityRegistryForTests()
  setActivityWorkspaceNameResolver((p) => pathToName(p) ?? p)
  setActivityOwnerResolver(lookupActivityOwner)
  proj = join(dir, 'proj')
  mkdirSync(proj)
  addWorkspace(proj, 1)
  workspaceName = pathToName(proj)!
})

afterEach(() => {
  for (const id of startedRuntimes) removeRuntime(id)
  startedRuntimes.length = 0
  resetActivityRegistryForTests()
  setActivityWorkspaceNameResolver(null)
  resetDbForTests()
  resetStoreForTests()
  resetAutomationStoreForTests()
  resetStateCacheForTests()
  vi.restoreAllMocks()
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

function runningIdsFromRegistry(): string[] {
  return activityRegistry
    .snapshotRunning()
    .map((f) => f.sessionId)
    .sort()
}

function runningIdsFromFacts(workspacePath: string): string[] {
  return listActiveSessionsForWorkspace(workspacePath)
    .map((s) => s.sessionId)
    .sort()
}

describe('rebuildActivityRegistry', () => {
  it('matches the workspace activity union after a full rebuild', () => {
    row('w-run', 'work')
    startRun('w-run', proj, 'work')
    const logOnly = seedLlmAutomation('auto-log')
    seedRunningLog(logOnly, 'auto-log')
    const both = seedLlmAutomation('auto-both')
    seedRunningLog(both, 'auto-both')
    startRun('auto-both', proj, 'automation')

    const incremental = runningIdsFromRegistry()
    expect(incremental).toEqual(runningIdsFromFacts(proj))

    rebuildActivityRegistry()
    expect(runningIdsFromRegistry()).toEqual(['auto-both', 'auto-log', 'w-run'])
    expect(runningIdsFromRegistry()).toEqual(runningIdsFromFacts(proj))
  })

  it('keeps awaiting_user and parked in the running snapshot', () => {
    row('perm', 'work')
    startRun('perm', proj, 'work')
    setStatus('perm', 'awaiting_permission')
    row('team', 'work')
    startRun('team', proj, 'work')
    setStatus('team', 'team')
    rebuildActivityRegistry()
    const byId = new Map(activityRegistry.snapshotRunning().map((f) => [f.sessionId, f]))
    expect(byId.get('perm')?.state).toBe('awaiting_user')
    expect(byId.get('team')?.state).toBe('parked')
    expect(runningIdsFromRegistry()).toEqual(runningIdsFromFacts(proj))
  })

  it('restores owner from session metadata', () => {
    row('i-run', 'intent', { ownerKind: 'intent', ownerId: 'intent-1' })
    startRun('i-run', proj, 'intent')
    rebuildActivityRegistry()
    expect(activityRegistry.getBySessionId('i-run')?.owner).toEqual({
      kind: 'intent',
      id: 'intent-1',
    })
  })

  it('omits idle runtimes and isolates workspaces', () => {
    const other = join(dir, 'other-ws')
    mkdirSync(other)
    addWorkspace(other, 2)
    row('idle', 'work')
    ensureRuntime('idle', proj, 'default', [], 'work')
    startedRuntimes.push('idle')
    row('a-run', 'work')
    row('b-run', 'work', { workspacePath: other })
    startRun('a-run', proj, 'work')
    startRun('b-run', other, 'work')
    rebuildActivityRegistry()
    expect(runningIdsFromRegistry()).toEqual(['a-run', 'b-run'])
    expect(runningIdsFromFacts(proj)).toEqual(['a-run'])
    expect(runningIdsFromFacts(other)).toEqual(['b-run'])
  })
})

describe('badge projection rebuild matches incremental writes', () => {
  it('full rebuild and incremental facts produce the same workspace summary', () => {
    row('w-run', 'work')
    startRun('w-run', proj, 'work')
    row('i-run', 'intent', { ownerKind: 'intent', ownerId: 'intent-1' })
    startRun('i-run', proj, 'intent')
    const logOnly = seedLlmAutomation('auto-log')
    seedRunningLog(logOnly, 'auto-log')
    const both = seedLlmAutomation('auto-both')
    seedRunningLog(both, 'auto-both')
    startRun('auto-both', proj, 'automation')

    const incremental = badgeProjection.summaryFor(workspaceName)
    expect(incremental.runningSessions).toBe(runningIdsFromFacts(proj).length)

    rebuildActivityRegistry()
    expect(badgeProjection.summaryFor(workspaceName)).toEqual(incremental)
    expect(badgeProjection.summaryFor(workspaceName).runningSessions).toBe(4)
    expect(badgeProjection.summaryFor(workspaceName).activeOwners).toEqual({
      intents: 1,
      discussions: 0,
      automations: 2,
    })
  })
})

describe('rebuild preserves fencing and skips unchanged projection', () => {
  it('keeps generation/sequence and does not bump revision when members match', () => {
    row('w-run', 'work')
    startRun('w-run', proj, 'work')
    rebuildActivityRegistry()
    const prior = activityRegistry.getBySessionId('w-run')!
    const revision = badgeProjection.getRevision()
    rebuildActivityRegistry()
    const again = activityRegistry.getBySessionId('w-run')!
    expect(again.generation).toBe(prior.generation)
    expect(again.sequence).toBe(prior.sequence)
    expect(badgeProjection.getRevision()).toBe(revision)
  })

  it('drops a registry-only member and bumps revision', () => {
    row('w-run', 'work')
    startRun('w-run', proj, 'work')
    rebuildActivityRegistry()
    activityRegistry.start({
      activityId: 'ghost',
      sessionId: 'ghost',
      workspaceName,
      sessionKind: 'work',
    })
    const revision = badgeProjection.getRevision()
    rebuildActivityRegistry()
    expect(activityRegistry.getBySessionId('ghost')).toBeUndefined()
    expect(activityRegistry.getBySessionId('w-run')).toBeDefined()
    expect(badgeProjection.getRevision()).toBe(revision + 1)
  })
})

describe('reconcileActivityProjection', () => {
  it('does not change projection when facts already match', () => {
    row('w-run', 'work')
    startRun('w-run', proj, 'work')
    rebuildActivityRegistry()
    const revision = badgeProjection.getRevision()
    const result = reconcileActivityProjection(Date.now())
    expect(result.reapedSessionIds).toEqual([])
    expect(result.expiredSessionIds).toEqual([])
    expect(result.projectionChanged).toBe(false)
    expect(badgeProjection.getRevision()).toBe(revision)
  })

  it('keeps a silent long tool running and does not abort it', () => {
    row('quiet', 'work')
    startRun('quiet', proj, 'work')
    const rt = getRuntime('quiet')!
    rt.lastActivityAt = 0
    const now = Date.now() + RUNNING_LEASE_MS + 1
    const result = reconcileActivityProjection(now)
    expect(result.reapedSessionIds).toEqual([])
    expect(result.expiredSessionIds).toEqual([])
    expect(rt.status).toBe('running')
    expect(isRunningPointer('quiet')).toBe(true)
    expect(activityRegistry.getBySessionId('quiet')?.state).toBe('running')
    expect(badgeProjection.summaryFor(workspaceName).runningSessions).toBe(1)
    const fact = activityRegistry.getBySessionId('quiet')!
    expect(fact.lastRenewedAt).toBe(now)
    expect(fact.leaseUntil).toBe(now + RUNNING_LEASE_MS)
  })

  it('expires an unpaid lease to stale without aborting the run', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    row('lost', 'work')
    startRun('lost', proj, 'work')
    const rt = getRuntime('lost')!
    rt.run = null
    const now = Date.now() + RUNNING_LEASE_MS + 1
    const result = reconcileActivityProjection(now)
    expect(result.reapedSessionIds).toEqual([])
    expect(result.expiredSessionIds).toEqual(['lost'])
    expect(rt.status).toBe('running')
    expect(activityRegistry.getBySessionId('lost')?.state).toBe('stale')
    expect(badgeProjection.summaryFor(workspaceName).runningSessions).toBe(0)
  })

  it('does not expire awaiting_user or parked by the running lease', () => {
    row('perm', 'work')
    startRun('perm', proj, 'work')
    setStatus('perm', 'awaiting_permission')
    row('team', 'work')
    startRun('team', proj, 'work')
    setStatus('team', 'team')
    const now = Date.now() + RUNNING_LEASE_MS * 4
    const result = reconcileActivityProjection(now)
    expect(result.expiredSessionIds).toEqual([])
    expect(activityRegistry.getBySessionId('perm')?.state).toBe('awaiting_user')
    expect(activityRegistry.getBySessionId('team')?.state).toBe('parked')
    expect(badgeProjection.summaryFor(workspaceName).runningSessions).toBe(2)
  })

  it('rejects a late renew from an old generation after a new run starts', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    row('w-run', 'work')
    startRun('w-run', proj, 'work')
    const old = activityRegistry.getBySessionId('w-run')!
    activityRegistry.expire('w-run')
    activityRegistry.start({
      activityId: 'w-run',
      sessionId: 'w-run',
      workspaceName,
      sessionKind: 'work',
      generation: 'gen-next',
      leaseUntil: Date.now() + RUNNING_LEASE_MS,
    })
    expect(activityRegistry.renew('w-run', Date.now() + 1, { generation: old.generation })).toEqual(
      {
        accepted: false,
        reason: 'stale_generation',
      },
    )
    expect(activityRegistry.getBySessionId('w-run')?.generation).toBe('gen-next')
  })

  it('rebuild after a process restart does not resurrect leftover running facts', () => {
    row('w-run', 'work')
    startRun('w-run', proj, 'work')
    const logOnly = seedLlmAutomation('auto-log')
    seedRunningLog(logOnly, 'auto-log')
    rebuildActivityRegistry()
    expect(
      activityRegistry
        .snapshotRunning()
        .map((f) => f.sessionId)
        .sort(),
    ).toEqual(['auto-log', 'w-run'])

    removeRuntime('w-run')
    startedRuntimes.length = 0
    expect(reconcileStuckRunningExecutions(Date.now())).toBe(1)
    activityRegistry.replaceAll([])
    rebuildActivityRegistry()
    expect(activityRegistry.snapshot()).toEqual([])
    expect(badgeProjection.summaryFor(workspaceName).runningSessions).toBe(0)
  })
})

function isRunningPointer(sessionId: string): boolean {
  return getRuntime(sessionId)?.run != null
}
