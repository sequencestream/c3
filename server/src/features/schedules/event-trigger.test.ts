/**
 * Event-triggered schedules (2026-06-08): store CRUD + query, and the scheduler's
 * `dispatchEventSchedules` filtering / debounce. The dispatcher is mocked so no
 * real command/LLM runs — we assert only that a matching event dispatches (an
 * execution log is appended) via the same path a cron run takes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
  setExecutionStore,
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
      workspacePath: proj,
      triggerType: 'event',
      cronExpression: '',
      eventTopic: 'run:settled',
      eventReasonFilter: ['error', 'aborted'],
      mcpMode: 'sandboxed',
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
      workspacePath: proj,
      triggerType: 'event',
      cronExpression: '',
      eventTopic: 'run:settled',
      mcpMode: 'sandboxed',
    })
    createSchedule({
      type: 'command',
      config: { command: 'b' },
      workspacePath: proj,
      triggerType: 'event',
      cronExpression: '',
      eventTopic: 'run:started',
      mcpMode: 'sandboxed',
    })
    // A cron schedule must never surface in the event query.
    const cron = createSchedule({
      type: 'command',
      config: { command: 'c' },
      workspacePath: proj,
      cronExpression: '0 8 * * *',
      mcpMode: 'sandboxed',
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
      workspacePath: proj,
      triggerType: 'event',
      cronExpression: '',
      eventTopic: 'run:settled',
      mcpMode: 'sandboxed',
    })
    updateSchedule(s.id, { status: 'paused' })
    expect(getEventSchedules('run:settled')).toHaveLength(0)
  })

  it('switching cron → event clears cron/nextRunAt and sets the topic', () => {
    const s = createSchedule({
      type: 'command',
      config: { command: 'a' },
      workspacePath: proj,
      cronExpression: '0 8 * * *',
      mcpMode: 'sandboxed',
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

  it('switching event → cron clears the event fields and re-arms nextRunAt', () => {
    const s = createSchedule({
      type: 'command',
      config: { command: 'a' },
      workspacePath: proj,
      triggerType: 'event',
      cronExpression: '',
      eventTopic: 'run:settled',
      eventReasonFilter: ['error'],
      mcpMode: 'sandboxed',
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
      workspacePath: '/abs/ws-a',
      triggerType: 'event',
      cronExpression: '',
      nextRunAt: null,
      eventTopic: 'run:settled',
      eventReasonFilter: null,
      status: 'active',
      mcpMode: 'sandboxed',
      toolAllowlist: [],
      toolDenylist: [],
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
      kind: 'normal',
    })
    expect(appendLog).toHaveBeenCalledTimes(1)
  })

  it('skips a schedule in a different workspace', () => {
    install([evSched({ id: 'm2' })])
    dispatchEventSchedules('run:settled', {
      sessionId: 's',
      workspacePath: '/abs/other',
      reason: 'complete',
      kind: 'normal',
    })
    expect(appendLog).not.toHaveBeenCalled()
  })

  it('never fires for intent (non-normal) runs', () => {
    install([evSched({ id: 'm3' })])
    dispatchEventSchedules('run:settled', {
      sessionId: 's',
      workspacePath: '/abs/ws-a',
      reason: 'complete',
      kind: 'intent',
    })
    expect(appendLog).not.toHaveBeenCalled()
  })

  it('honours the reason filter (fires only on listed reasons)', () => {
    install([evSched({ id: 'm4', eventReasonFilter: ['error'] })])
    dispatchEventSchedules('run:settled', {
      sessionId: 's',
      workspacePath: '/abs/ws-a',
      reason: 'complete',
      kind: 'normal',
    })
    expect(appendLog).not.toHaveBeenCalled()
    dispatchEventSchedules('run:settled', {
      sessionId: 's',
      workspacePath: '/abs/ws-a',
      reason: 'error',
      kind: 'normal',
    })
    expect(appendLog).toHaveBeenCalledTimes(1)
  })

  it('does not fire a run:settled schedule on a run:started event', () => {
    install([evSched({ id: 'm5' })]) // eventTopic = run:settled
    dispatchEventSchedules('run:started', {
      sessionId: 's',
      workspacePath: '/abs/ws-a',
      kind: 'normal',
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
      kind: 'normal' as const,
    }
    dispatchEventSchedules('run:settled', payload)
    dispatchEventSchedules('run:settled', payload)
    expect(appendLog).toHaveBeenCalledTimes(1)
    cancelInFlight('dbnc') // clean up the never-resolving in-flight entry
  })
})
