/**
 * Queue persistence tests over a real (temp-file) sqlite database.
 *
 * These protect the durability contract the kernel leans on: a queue that was
 * running before a restart is found again, per-intent scheduling metadata
 * survives, historic intents with no row read as zero-valued rather than
 * blowing up, and the decision log answers "why is this intent not moving".
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resetDbForTests } from '../../kernel/infra/db.js'
import { emptyQueueIntentMeta } from '../../kernel/queue/index.js'
import {
  appendQueueDecisions,
  deleteQueueIntentMeta,
  getQueueControl,
  getQueueIntentMeta,
  getQueueIntentMetaById,
  isQueueStoreAvailable,
  latestQueueDecisionByIntent,
  listActiveQueueWorkspaces,
  listQueueDecisions,
  listQueueDecisionsForIntent,
  putQueueIntentMeta,
  resetQueueStoreForTests,
  setQueueControl,
} from './queue-store.js'

let dir: string
const proj = '/abs/queue-project'

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'c3-queue-db-'))
  process.env.C3_DB_PATH = join(dir, 'c3.db')
  resetDbForTests()
  resetQueueStoreForTests()
})

afterEach(() => {
  resetDbForTests()
  resetQueueStoreForTests()
  delete process.env.C3_DB_PATH
  rmSync(dir, { recursive: true, force: true })
})

describe('queue control state', () => {
  it('defaults to idle and round-trips a running queue', () => {
    expect(isQueueStoreAvailable()).toBe(true)
    expect(getQueueControl(proj)).toEqual({ state: 'idle', startedAt: null, forceSkipped: [] })

    setQueueControl(proj, { state: 'running', startedAt: 42, forceSkipped: ['a', 'b'] })
    expect(getQueueControl(proj)).toEqual({
      state: 'running',
      startedAt: 42,
      forceSkipped: ['a', 'b'],
    })
  })

  it('lists exactly the workspaces a restart must reconcile', () => {
    setQueueControl('/w/running', { state: 'running', startedAt: 1, forceSkipped: [] })
    setQueueControl('/w/paused', { state: 'paused', startedAt: 1, forceSkipped: [] })
    setQueueControl('/w/stopped', { state: 'idle', startedAt: null, forceSkipped: [] })
    resetQueueStoreForTests() // drop the in-memory mirror: read from disk only

    const active = listActiveQueueWorkspaces()
    expect(active).toContain('running')
    expect(active).toContain('paused')
    expect(active).not.toContain('stopped')
  })

  it('upserts rather than duplicating a workspace row', () => {
    setQueueControl(proj, { state: 'running', startedAt: 1, forceSkipped: [] })
    setQueueControl(proj, { state: 'paused', startedAt: 1, forceSkipped: ['x'] })
    resetQueueStoreForTests()
    expect(getQueueControl(proj).state).toBe('paused')
    expect(getQueueControl(proj).forceSkipped).toEqual(['x'])
  })
})

describe('per-intent scheduling metadata', () => {
  it('reads a never-scheduled intent as zero failures, unparked, no backoff', () => {
    expect(getQueueIntentMetaById('historic')).toEqual(emptyQueueIntentMeta('historic'))
    expect(getQueueIntentMeta(proj)).toEqual({})
  })

  it('round-trips every persisted field', () => {
    putQueueIntentMeta(proj, {
      intentId: 'A',
      failureCount: 2,
      backoffCount: 2,
      backoffUntil: 555,
      parked: true,
      parkReason: 'judge_stuck',
      parkDetail: '未真实完成',
      cooldownUntil: 777,
      updatedAt: 999,
    })
    resetQueueStoreForTests()

    expect(getQueueIntentMetaById('A')).toEqual({
      intentId: 'A',
      failureCount: 2,
      backoffCount: 2,
      backoffUntil: 555,
      parked: true,
      parkReason: 'judge_stuck',
      parkDetail: '未真实完成',
      cooldownUntil: 777,
      updatedAt: 999,
    })
  })

  it('scopes metadata to its workspace', () => {
    putQueueIntentMeta(proj, { ...emptyQueueIntentMeta('mine'), failureCount: 1 })
    putQueueIntentMeta('/other', { ...emptyQueueIntentMeta('theirs'), failureCount: 5 })
    resetQueueStoreForTests()

    expect(Object.keys(getQueueIntentMeta(proj))).toEqual(['mine'])
    expect(Object.keys(getQueueIntentMeta('/other'))).toEqual(['theirs'])
  })

  it('deleting an intent drops its metadata and its decisions together', () => {
    putQueueIntentMeta(proj, { ...emptyQueueIntentMeta('gone'), failureCount: 3 })
    appendQueueDecisions([
      {
        tickId: 't1',
        workspacePath: proj,
        intentId: 'gone',
        decidedAt: 1,
        action: 'block',
        blockedGate: 'blocked_backoff',
        rejectReason: null,
        attemptCount: 1,
        backoffCount: 1,
        nextWakeupAt: null,
      },
    ])
    deleteQueueIntentMeta('gone')
    resetQueueStoreForTests()

    expect(getQueueIntentMetaById('gone')).toEqual(emptyQueueIntentMeta('gone'))
    expect(listQueueDecisionsForIntent('gone')).toEqual([])
  })
})

describe('decision log', () => {
  const row = (over: Partial<Parameters<typeof appendQueueDecisions>[0][number]> = {}) => ({
    tickId: 'tick-1',
    workspacePath: proj,
    intentId: 'A',
    decidedAt: 1000,
    action: 'block',
    blockedGate: 'blocked_dependency',
    rejectReason: '依赖未完成',
    attemptCount: 0,
    backoffCount: 0,
    nextWakeupAt: null,
    ...over,
  })

  it('persists every field the queue page reads back', () => {
    appendQueueDecisions([row()])
    const [saved] = listQueueDecisions(proj)
    expect(saved).toMatchObject({
      tickId: 'tick-1',
      intentId: 'A',
      action: 'block',
      blockedGate: 'blocked_dependency',
      rejectReason: '依赖未完成',
    })
  })

  it('returns newest first, per workspace and per intent', () => {
    appendQueueDecisions([
      row({ decidedAt: 1, intentId: 'A' }),
      row({ decidedAt: 2, intentId: 'B' }),
      row({ decidedAt: 3, intentId: 'A', action: 'launch' }),
    ])
    appendQueueDecisions([row({ workspacePath: '/other', intentId: 'C', decidedAt: 9 })])

    expect(listQueueDecisions(proj).map((r) => r.decidedAt)).toEqual([3, 2, 1])
    expect(listQueueDecisions(proj).some((r) => r.intentId === 'C')).toBe(false)
    expect(listQueueDecisionsForIntent('A').map((r) => r.decidedAt)).toEqual([3, 1])
  })

  it('latest-per-intent picks the newest row for each intent', () => {
    appendQueueDecisions([
      row({ decidedAt: 1, intentId: 'A', action: 'block' }),
      row({ decidedAt: 5, intentId: 'A', action: 'park' }),
      row({ decidedAt: 2, intentId: 'B', action: 'launch' }),
    ])
    const latest = latestQueueDecisionByIntent(proj)
    expect(latest.A).toMatchObject({ action: 'park', decidedAt: 5 })
    expect(latest.B).toMatchObject({ action: 'launch', decidedAt: 2 })
  })

  it('an empty batch is a no-op', () => {
    expect(appendQueueDecisions([])).toBe(true)
    expect(listQueueDecisions(proj)).toEqual([])
  })
})

describe('degradation', () => {
  // An unopenable db path, built as "<a regular file>/c3.db" so the parent is a
  // file rather than a directory: the parent-dir mkdir then fails at once on every
  // platform, sqlite cannot open the path, and it all stays inside our temp dir.
  // Do NOT point this at a path under `/proc` — procfs answers mkdir with ENOENT,
  // which Node's recursive mkdir reads as "the parent is missing", so it creates
  // the parent and retries forever. That spins in a synchronous loop no test
  // timeout can interrupt, hanging the whole run on Linux (but not on macOS,
  // where /proc does not exist).
  const unopenableDbPath = () => {
    const notADir = join(dir, 'not-a-dir')
    writeFileSync(notADir, '')
    return join(notADir, 'c3.db')
  }

  it('an unavailable db degrades reads to defaults instead of throwing', () => {
    resetDbForTests()
    process.env.C3_DB_PATH = unopenableDbPath()
    resetQueueStoreForTests()

    expect(getQueueControl(proj)).toEqual({ state: 'idle', startedAt: null, forceSkipped: [] })
    expect(getQueueIntentMetaById('A')).toEqual(emptyQueueIntentMeta('A'))
    expect(listActiveQueueWorkspaces()).toEqual([])
    expect(listQueueDecisions(proj)).toEqual([])
  })

  it('a rejected write still governs THIS process through the in-memory mirror', () => {
    resetDbForTests()
    process.env.C3_DB_PATH = unopenableDbPath()
    resetQueueStoreForTests()

    // The write cannot reach disk…
    expect(putQueueIntentMeta(proj, { ...emptyQueueIntentMeta('A'), failureCount: 2 })).toBe(false)
    // …but the failure count still counts, so a db outage can never reset a
    // counter and hand an intent an unlimited retry budget.
    expect(getQueueIntentMetaById('A').failureCount).toBe(2)
    expect(getQueueControl(proj).state).toBe('idle')
  })
})
