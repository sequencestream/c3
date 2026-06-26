/**
 * Event-triggered schedules (2026-06-08): store CRUD + query, and the scheduler's
 * `dispatchEventSchedules` filtering / debounce. The dispatcher is mocked so no
 * real command/LLM runs — we assert only that a matching event dispatches (an
 * execution log is appended) via the same path a cron run takes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
// The store maps `workspace_path` <-> opaque `workspaceId` through the registry;
// in isolation these synthetic paths are unregistered, so stub resolve/pathToId
// as identity — fixtures use the path itself as the id and round-trip cleanly.
vi.mock('../../state.js', () => ({
  resolveWorkspaceRoot: (id: string) => id,
  pathToId: (p: string) => p,
}))
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Schedule } from '@ccc/shared/protocol'
import { resetDbForTests } from '../../kernel/infra/db.js'
import {
  createSchedule,
  getDueSchedules,
  getEventSchedules,
  getSchedule,
  resetStoreForTests,
  updateSchedule,
} from './store.js'

// Mock the dispatcher so dispatchAndTrack never spawns / queries an LLM.
vi.mock('./dispatcher.js', () => ({
  execute: vi.fn(async () => {}),
}))
import { execute } from './dispatcher.js'
import {
  cancelInFlight,
  dispatchEventSchedules,
  hasInFlight,
  setExecutionStore,
  startScheduler,
  stopScheduler,
  triggerRunNow,
  type ExecutionStore,
} from './scheduler.js'

// ---------------------------------------------------------------------------
// store: event-schedule CRUD + queries
// ---------------------------------------------------------------------------
describe('store — event-trigger schedule CRUD', () => {
  let dir: string
  const proj = '/abs/workspace-evt'

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'c3-sch-evt-'))
    process.env.C3_DB_PATH = join(dir, 'c3.db')
    resetDbForTests()
    resetStoreForTests()
  })
  afterEach(() => {
    resetDbForTests()
    delete process.env.C3_DB_PATH
    rmSync(dir, { recursive: true, force: true })
  })

  it('creates an event schedule with empty cron, null nextRunAt, and a topic', () => {
    const s = createSchedule({
      type: 'command',
      config: { command: 'echo hi' },
      workspaceId: proj,
      triggerType: 'event',
      cronExpression: '',
      eventTopic: 'run:settled',
      eventReasonFilter: ['error', 'aborted'],
      mode: 'sandboxed',
      vendor: 'claude',
    })
    expect(s.triggerType).toBe('event')
    expect(s.cronExpression).toBe('')
    expect(s.nextRunAt).toBeNull()
    expect(s.eventTopic).toBe('run:settled')
    expect(s.eventReasonFilter).toEqual(['error', 'aborted'])
  })

  it('getEventSchedules returns only matching active event schedules', () => {
    const settled = createSchedule({
      type: 'command',
      config: { command: 'a' },
      workspaceId: proj,
      triggerType: 'event',
      cronExpression: '',
      eventTopic: 'run:settled',
      mode: 'sandboxed',
      vendor: 'claude',
    })
    createSchedule({
      type: 'command',
      config: { command: 'b' },
      workspaceId: proj,
      triggerType: 'event',
      cronExpression: '',
      eventTopic: 'run:started',
      mode: 'sandboxed',
      vendor: 'claude',
    })
    // A cron schedule must never surface in the event query.
    const cron = createSchedule({
      type: 'command',
      config: { command: 'c' },
      workspaceId: proj,
      cronExpression: '0 8 * * *',
      mode: 'sandboxed',
      vendor: 'claude',
    })

    const settledList = getEventSchedules('run:settled')
    expect(settledList.map((s) => s.id)).toEqual([settled.id])
    expect(getEventSchedules('run:started')).toHaveLength(1)

    // Event schedules are never due via the cron tick (no nextRunAt). Use a 2-day
    // window so the daily cron row (0 8 * * *) is guaranteed to be due by then.
    const due = getDueSchedules(Date.now() + 2 * 24 * 60 * 60 * 1000)
    expect(due.map((s) => s.id)).toContain(cron.id)
    expect(due.map((s) => s.id)).not.toContain(settled.id)
  })

  it('paused event schedules are excluded from getEventSchedules', () => {
    const s = createSchedule({
      type: 'command',
      config: { command: 'a' },
      workspaceId: proj,
      triggerType: 'event',
      cronExpression: '',
      eventTopic: 'run:settled',
      mode: 'sandboxed',
      vendor: 'claude',
    })
    updateSchedule(s.id, { status: 'paused' })
    expect(getEventSchedules('run:settled')).toHaveLength(0)
  })

  it('switching cron → event clears cron/nextRunAt and sets the topic', () => {
    const s = createSchedule({
      type: 'command',
      config: { command: 'a' },
      workspaceId: proj,
      cronExpression: '0 8 * * *',
      mode: 'sandboxed',
      vendor: 'claude',
    })
    expect(s.triggerType).toBe('cron')
    expect(s.nextRunAt).not.toBeNull()

    updateSchedule(s.id, { triggerType: 'event', eventTopic: 'run:started' })
    const after = getSchedule(s.id)!
    expect(after.triggerType).toBe('event')
    expect(after.cronExpression).toBe('')
    expect(after.nextRunAt).toBeNull()
    expect(after.eventTopic).toBe('run:started')
  })

  it('creates a pr:operation schedule with a PR filter that round-trips', () => {
    const s = createSchedule({
      type: 'command',
      config: { command: 'echo pr' },
      workspaceId: proj,
      triggerType: 'event',
      cronExpression: '',
      eventTopic: 'pr:operation',
      eventPrFilter: { operations: ['merge', 'close'], results: ['success'] },
      mode: 'sandboxed',
      vendor: 'claude',
    })
    expect(s.eventTopic).toBe('pr:operation')
    expect(s.eventPrFilter).toEqual({ operations: ['merge', 'close'], results: ['success'] })
    expect(getEventSchedules('pr:operation').map((x) => x.id)).toEqual([s.id])
    // A pr:operation schedule never surfaces under a run-lifecycle topic.
    expect(getEventSchedules('run:settled')).toHaveLength(0)
  })

  it('drops empty PR filter dimensions to null (= any)', () => {
    const s = createSchedule({
      type: 'command',
      config: { command: 'a' },
      workspaceId: proj,
      triggerType: 'event',
      cronExpression: '',
      eventTopic: 'pr:operation',
      eventPrFilter: { operations: [], results: [] },
      mode: 'sandboxed',
      vendor: 'claude',
    })
    expect(s.eventPrFilter).toBeNull()
  })

  it('switching a pr:operation schedule → cron clears the PR filter', () => {
    const s = createSchedule({
      type: 'command',
      config: { command: 'a' },
      workspaceId: proj,
      triggerType: 'event',
      cronExpression: '',
      eventTopic: 'pr:operation',
      eventPrFilter: { operations: ['create'] },
      mode: 'sandboxed',
      vendor: 'claude',
    })
    updateSchedule(s.id, { triggerType: 'cron', cronExpression: '0 9 * * *' })
    const after = getSchedule(s.id)!
    expect(after.eventTopic).toBeNull()
    expect(after.eventPrFilter).toBeNull()
  })

  it('switching event → cron clears the event fields and re-arms nextRunAt', () => {
    const s = createSchedule({
      type: 'command',
      config: { command: 'a' },
      workspaceId: proj,
      triggerType: 'event',
      cronExpression: '',
      eventTopic: 'run:settled',
      eventReasonFilter: ['error'],
      mode: 'sandboxed',
      vendor: 'claude',
    })
    updateSchedule(s.id, { triggerType: 'cron', cronExpression: '0 9 * * *' })
    const after = getSchedule(s.id)!
    expect(after.triggerType).toBe('cron')
    expect(after.eventTopic).toBeNull()
    expect(after.eventReasonFilter).toBeNull()
    expect(after.nextRunAt).not.toBeNull()
  })
})

// ---------------------------------------------------------------------------
// scheduler: dispatchEventSchedules filtering + debounce
// ---------------------------------------------------------------------------
describe('scheduler — dispatchEventSchedules', () => {
  let appendLog: ReturnType<typeof vi.fn>

  function evSched(over: Partial<Schedule> = {}): Schedule {
    return {
      id: 'e1',
      type: 'command',
      config: { command: 'echo hi', name: 'x' },
      maxWallClockMs: null,
      workspaceId: '/abs/ws-a',
      triggerType: 'event',
      cronExpression: '',
      nextRunAt: null,
      eventTopic: 'run:settled',
      eventReasonFilter: null,
      eventPrFilter: null,
      status: 'active',
      mode: 'sandboxed',
      toolAllowlist: [],
      toolDenylist: [],
      vendor: 'claude',
      createdAt: 1,
      updatedAt: 1,
      ...over,
    }
  }

  function install(schedules: Schedule[]): void {
    const store: ExecutionStore = {
      getDueSchedules: () => [],
      getEventSchedules: (topic) =>
        schedules.filter(
          (s) => s.status === 'active' && s.triggerType === 'event' && s.eventTopic === topic,
        ),
      getSchedule: (id) => schedules.find((s) => s.id === id) ?? null,
      updateNextRunAt: vi.fn(),
      updateSchedule: vi.fn(),
      deleteSchedule: vi.fn(),
      appendExecutionLog: appendLog as unknown as ExecutionStore['appendExecutionLog'],
      updateExecutionLog: vi.fn(),
      broadcast: vi.fn(),
    }
    setExecutionStore(store)
  }

  beforeEach(() => {
    vi.mocked(execute).mockReset()
    vi.mocked(execute).mockResolvedValue(undefined)
    appendLog = vi.fn(() => ({ id: 'log1' }))
  })

  it('fires a matching run:settled schedule in the same workspace', () => {
    install([evSched({ id: 'm1' })])
    dispatchEventSchedules('run:settled', {
      sessionId: 's',
      workspacePath: '/abs/ws-a',
      reason: 'complete',
      sessionKind: 'work',
    })
    expect(appendLog).toHaveBeenCalledTimes(1)
  })

  it('skips a schedule in a different workspace', () => {
    install([evSched({ id: 'm2' })])
    dispatchEventSchedules('run:settled', {
      sessionId: 's',
      workspacePath: '/abs/other',
      reason: 'complete',
      sessionKind: 'work',
    })
    expect(appendLog).not.toHaveBeenCalled()
  })

  it('never fires for intent (non-work) runs', () => {
    install([evSched({ id: 'm3' })])
    dispatchEventSchedules('run:settled', {
      sessionId: 's',
      workspacePath: '/abs/ws-a',
      reason: 'complete',
      sessionKind: 'intent',
    })
    expect(appendLog).not.toHaveBeenCalled()
  })

  it('honours the reason filter (fires only on listed reasons)', () => {
    install([evSched({ id: 'm4', eventReasonFilter: ['error'] })])
    dispatchEventSchedules('run:settled', {
      sessionId: 's',
      workspacePath: '/abs/ws-a',
      reason: 'complete',
      sessionKind: 'work',
    })
    expect(appendLog).not.toHaveBeenCalled()
    dispatchEventSchedules('run:settled', {
      sessionId: 's',
      workspacePath: '/abs/ws-a',
      reason: 'error',
      sessionKind: 'work',
    })
    expect(appendLog).toHaveBeenCalledTimes(1)
  })

  it('does not fire a run:settled schedule on a run:started event', () => {
    install([evSched({ id: 'm5' })]) // eventTopic = run:settled
    dispatchEventSchedules('run:started', {
      sessionId: 's',
      workspacePath: '/abs/ws-a',
      sessionKind: 'work',
    })
    expect(appendLog).not.toHaveBeenCalled()
  })

  it('debounces: a second event does not double-fire while in flight', () => {
    // Keep the execution in flight so the second dispatch sees it and skips.
    vi.mocked(execute).mockImplementation(() => new Promise<void>(() => {}))
    install([evSched({ id: 'dbnc' })])
    const payload = {
      sessionId: 's',
      workspacePath: '/abs/ws-a',
      reason: 'complete' as const,
      sessionKind: 'work' as const,
    }
    dispatchEventSchedules('run:settled', payload)
    dispatchEventSchedules('run:settled', payload)
    expect(appendLog).toHaveBeenCalledTimes(1)
    cancelInFlight('dbnc') // clean up the never-resolving in-flight entry
  })
})

describe('scheduler — triggerRunNow', () => {
  let appendLog: ReturnType<typeof vi.fn>
  let updateNextRunAt: ReturnType<typeof vi.fn>

  function schedule(over: Partial<Schedule> = {}): Schedule {
    return {
      id: 'manual-1',
      type: 'command',
      config: { command: 'echo hi', name: 'manual' },
      maxWallClockMs: null,
      workspaceId: '/abs/ws-a',
      triggerType: 'cron',
      cronExpression: '0 8 * * *',
      nextRunAt: 1_800_000_000_000,
      eventTopic: null,
      eventReasonFilter: null,
      eventPrFilter: null,
      status: 'paused',
      mode: 'sandboxed',
      toolAllowlist: [],
      toolDenylist: [],
      vendor: 'claude',
      createdAt: 1,
      updatedAt: 1,
      ...over,
    }
  }

  function install(schedules: Schedule[]): void {
    setExecutionStore({
      getDueSchedules: () => [],
      getEventSchedules: () => [],
      getSchedule: (id) => schedules.find((item) => item.id === id) ?? null,
      updateNextRunAt,
      updateSchedule: vi.fn(),
      deleteSchedule: vi.fn(),
      appendExecutionLog: appendLog as unknown as ExecutionStore['appendExecutionLog'],
      updateExecutionLog: vi.fn(),
    })
  }

  beforeEach(() => {
    vi.mocked(execute).mockReset()
    vi.mocked(execute).mockResolvedValue(undefined)
    appendLog = vi.fn(() => ({ id: 'manual-log' }))
    updateNextRunAt = vi.fn()
  })

  afterEach(() => {
    cancelInFlight('manual-1')
  })

  it('dispatches a paused schedule once without changing its status or nextRunAt', async () => {
    const paused = schedule()
    install([paused])

    await triggerRunNow(paused.id)

    expect(appendLog).toHaveBeenCalledOnce()
    expect(execute).toHaveBeenCalledWith(paused, 'manual-log', expect.any(Function))
    await vi.waitFor(() => expect(hasInFlight(paused.id)).toBe(false))
    expect(paused.status).toBe('paused')
    expect(paused.nextRunAt).toBe(1_800_000_000_000)
    expect(updateNextRunAt).not.toHaveBeenCalled()
  })

  it('rejects archived and missing schedules without dispatching', async () => {
    install([schedule({ status: 'archived' })])

    await triggerRunNow('manual-1')
    await triggerRunNow('missing')

    expect(appendLog).not.toHaveBeenCalled()
    expect(execute).not.toHaveBeenCalled()
  })

  it('rejects a second manual trigger while the first is in flight', async () => {
    vi.mocked(execute).mockImplementation(() => new Promise<void>(() => {}))
    const paused = schedule()
    install([paused])

    await triggerRunNow(paused.id)
    await triggerRunNow(paused.id)

    expect(appendLog).toHaveBeenCalledOnce()
    expect(hasInFlight(paused.id)).toBe(true)
  })
})

describe('scheduler — stale cron trigger', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-21T00:00:00.000Z'))
  })

  afterEach(async () => {
    await stopScheduler()
    vi.useRealTimers()
  })

  it('records a missed occurrence and keeps the schedule active for its next cron run', async () => {
    const schedule: Schedule = {
      id: 'stale-cron',
      type: 'command',
      config: { command: 'echo hi', name: 'x' },
      maxWallClockMs: null,
      workspaceId: '/abs/ws-a',
      triggerType: 'cron',
      cronExpression: '0 * * * *',
      nextRunAt: Date.now() - 5 * 60 * 1000 - 1,
      eventTopic: null,
      eventReasonFilter: null,
      eventPrFilter: null,
      status: 'active',
      mode: 'sandboxed',
      toolAllowlist: [],
      toolDenylist: [],
      vendor: 'claude',
      createdAt: 1,
      updatedAt: 1,
    }
    const appendExecutionLog = vi.fn(() => ({ id: 'stale-log' }))
    const updateNextRunAt = vi.fn()
    const updateSchedule = vi.fn()
    const store: ExecutionStore = {
      getDueSchedules: () => [schedule],
      getEventSchedules: () => [],
      getSchedule: () => schedule,
      updateNextRunAt,
      updateSchedule,
      deleteSchedule: vi.fn(),
      appendExecutionLog: appendExecutionLog as unknown as ExecutionStore['appendExecutionLog'],
      updateExecutionLog: vi.fn(),
    }
    setExecutionStore(store)

    startScheduler(1)
    await vi.advanceTimersByTimeAsync(1)

    expect(updateSchedule).not.toHaveBeenCalled()
    expect(appendExecutionLog).toHaveBeenCalledWith(
      expect.objectContaining({ scheduleId: schedule.id, error: 'missed_trigger_window' }),
    )
    expect(updateNextRunAt).toHaveBeenCalledWith(schedule.id, expect.any(Number))
    expect(updateNextRunAt.mock.calls[0]![1]).toBeGreaterThan(Date.now())
  })
})

// ---------------------------------------------------------------------------
// scheduler: dispatchEventSchedules — pr:operation (2026-06-20)
// ---------------------------------------------------------------------------
describe('scheduler — dispatchEventSchedules (pr:operation)', () => {
  let appendLog: ReturnType<typeof vi.fn>

  function prSched(over: Partial<Schedule> = {}): Schedule {
    return {
      id: 'p1',
      type: 'command',
      config: { command: 'echo hi', name: 'x' },
      maxWallClockMs: null,
      workspaceId: '/abs/ws-a',
      triggerType: 'event',
      cronExpression: '',
      nextRunAt: null,
      eventTopic: 'pr:operation',
      eventReasonFilter: null,
      eventPrFilter: null,
      status: 'active',
      mode: 'sandboxed',
      toolAllowlist: [],
      toolDenylist: [],
      vendor: 'claude',
      createdAt: 1,
      updatedAt: 1,
      ...over,
    }
  }

  function install(schedules: Schedule[]): void {
    const store: ExecutionStore = {
      getDueSchedules: () => [],
      getEventSchedules: (topic) =>
        schedules.filter(
          (s) => s.status === 'active' && s.triggerType === 'event' && s.eventTopic === topic,
        ),
      getSchedule: (id) => schedules.find((s) => s.id === id) ?? null,
      updateNextRunAt: vi.fn(),
      updateSchedule: vi.fn(),
      deleteSchedule: vi.fn(),
      appendExecutionLog: appendLog as unknown as ExecutionStore['appendExecutionLog'],
      updateExecutionLog: vi.fn(),
      broadcast: vi.fn(),
    }
    setExecutionStore(store)
  }

  beforeEach(() => {
    vi.mocked(execute).mockReset()
    vi.mocked(execute).mockResolvedValue(undefined)
    appendLog = vi.fn(() => ({ id: 'log1' }))
  })

  const prEvent = (over: Record<string, unknown> = {}) => ({
    sessionId: 's',
    workspacePath: '/abs/ws-a',
    operation: 'merge' as const,
    result: 'success' as const,
    ...over,
  })

  it('fires a matching pr:operation schedule (no filter = any) in the same workspace', () => {
    install([prSched({ id: 'm1' })])
    dispatchEventSchedules('pr:operation', prEvent())
    expect(appendLog).toHaveBeenCalledTimes(1)
  })

  it('skips a pr:operation schedule in a different workspace', () => {
    install([prSched({ id: 'm2' })])
    dispatchEventSchedules('pr:operation', prEvent({ workspacePath: '/abs/other' }))
    expect(appendLog).not.toHaveBeenCalled()
  })

  it('honours the operation filter', () => {
    install([prSched({ id: 'm3', eventPrFilter: { operations: ['close'] } })])
    dispatchEventSchedules('pr:operation', prEvent({ operation: 'merge' }))
    expect(appendLog).not.toHaveBeenCalled()
    dispatchEventSchedules('pr:operation', prEvent({ operation: 'close' }))
    expect(appendLog).toHaveBeenCalledTimes(1)
  })

  it('honours the result filter', () => {
    install([prSched({ id: 'm4', eventPrFilter: { results: ['failure'] } })])
    dispatchEventSchedules('pr:operation', prEvent({ result: 'success' }))
    expect(appendLog).not.toHaveBeenCalled()
    dispatchEventSchedules('pr:operation', prEvent({ result: 'failure' }))
    expect(appendLog).toHaveBeenCalledTimes(1)
  })

  it('requires BOTH operation and result to match when both are filtered', () => {
    install([prSched({ id: 'm5', eventPrFilter: { operations: ['merge'], results: ['success'] } })])
    dispatchEventSchedules('pr:operation', prEvent({ operation: 'merge', result: 'failure' }))
    expect(appendLog).not.toHaveBeenCalled()
    dispatchEventSchedules('pr:operation', prEvent({ operation: 'merge', result: 'success' }))
    expect(appendLog).toHaveBeenCalledTimes(1)
  })

  it('does not fire a run:settled schedule on a pr:operation event (topic isolation)', () => {
    install([
      {
        ...prSched({ id: 'm6' }),
        eventTopic: 'run:settled',
        eventPrFilter: null,
      },
    ])
    dispatchEventSchedules('pr:operation', prEvent())
    expect(appendLog).not.toHaveBeenCalled()
  })

  it('debounces: a second pr:operation event does not double-fire while in flight', () => {
    vi.mocked(execute).mockImplementation(() => new Promise<void>(() => {}))
    install([prSched({ id: 'dbnc-pr' })])
    dispatchEventSchedules('pr:operation', prEvent())
    dispatchEventSchedules('pr:operation', prEvent())
    expect(appendLog).toHaveBeenCalledTimes(1)
    cancelInFlight('dbnc-pr')
  })
})
