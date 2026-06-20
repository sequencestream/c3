// @vitest-environment happy-dom
/**
 * Live-refresh wiring for the selected, running schedule execution: the control
 * layer starts a 5s poll (detail + transcript) while a running llm execution is
 * selected on the active, visible page, and stops it after one final transcript
 * fetch on completion. The decision logic itself is unit-tested in
 * `lib/schedule-refresh.test.ts`; this verifies the timer/visibility wiring.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { nextTick, ref } from 'vue'
import type { ClientToServer, Schedule, ScheduleExecutionLog } from '@ccc/shared/protocol'
import { installScheduleActions } from './schedule-actions'
import type { AppCtx } from './types'

const TICK = 5_000

function runningLog(): ScheduleExecutionLog {
  return {
    id: 'e1',
    scheduleId: 's1',
    startedAt: 0,
    finishedAt: null,
    exitCode: null,
    output: '',
    error: null,
    status: 'running',
    sessionId: 'sess1',
  }
}

function doneLog(): ScheduleExecutionLog {
  return { ...runningLog(), finishedAt: 1000, exitCode: 0, status: 'success' }
}

const llmSchedule = { id: 's1', type: 'llm' } as unknown as Schedule
const commandSchedule = { id: 's1', type: 'command' } as unknown as Schedule

let visibility = 'visible'

function setVisible(state: 'visible' | 'hidden'): void {
  visibility = state
}

function makeCtx() {
  const send = vi.fn<(msg: ClientToServer) => void>()
  const activeTab = ref<string>('console')
  const selectedScheduleId = ref<string | null>(null)
  const selectedExecutionId = ref<string | null>(null)
  const selectedSchedule = ref<Schedule | null>(null)
  const selectedExecution = ref<ScheduleExecutionLog | null>(null)
  const ctx = {
    send,
    activeTab,
    schedulesProject: ref(null),
    selectedScheduleId,
    selectedExecutionId,
    selectedSchedule,
    selectedExecution,
    scheduleFormOpen: ref(false),
    scheduleFormTarget: ref(null),
    scheduleToolManifest: ref({}),
    scheduleToolManifestLoading: ref(false),
    scheduleToolManifestError: ref(null),
  } as unknown as AppCtx
  installScheduleActions(ctx)
  return {
    send,
    activeTab,
    selectedScheduleId,
    selectedExecutionId,
    selectedSchedule,
    selectedExecution,
  }
}

// Select a running llm execution on the active schedules page.
async function selectRunning(c: ReturnType<typeof makeCtx>): Promise<void> {
  c.selectedScheduleId.value = 's1'
  c.selectedExecutionId.value = 'e1'
  c.selectedSchedule.value = llmSchedule
  c.activeTab.value = 'schedules'
  c.selectedExecution.value = runningLog()
  await nextTick()
}

function transcriptCalls(send: ReturnType<typeof vi.fn>): unknown[] {
  return send.mock.calls.filter((c) => (c[0] as ClientToServer).type === 'get_execution_transcript')
}
function detailCalls(send: ReturnType<typeof vi.fn>): unknown[] {
  return send.mock.calls.filter((c) => (c[0] as ClientToServer).type === 'get_schedule_detail')
}

beforeEach(() => {
  vi.useFakeTimers()
  visibility = 'visible'
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => visibility,
  })
})
afterEach(() => {
  vi.useRealTimers()
})

describe('running execution live refresh', () => {
  it('polls detail + transcript every tick while running and visible (AC#1)', async () => {
    const c = makeCtx()
    await selectRunning(c)
    c.send.mockClear()

    vi.advanceTimersByTime(TICK)
    expect(detailCalls(c.send)).toHaveLength(1)
    expect(transcriptCalls(c.send)).toHaveLength(1)

    vi.advanceTimersByTime(TICK)
    expect(detailCalls(c.send)).toHaveLength(2)
    expect(transcriptCalls(c.send)).toHaveLength(2)
  })

  it('stops polling and fetches the transcript once on completion (AC#2)', async () => {
    const c = makeCtx()
    await selectRunning(c)
    vi.advanceTimersByTime(TICK)
    c.send.mockClear()

    // Execution reaches a terminal state (schedule_detail refresh would do this).
    c.selectedExecution.value = doneLog()
    await nextTick()

    // Exactly one final transcript fetch, no further detail poll.
    expect(transcriptCalls(c.send)).toHaveLength(1)
    expect(detailCalls(c.send)).toHaveLength(0)

    // No more periodic sends after completion.
    c.send.mockClear()
    vi.advanceTimersByTime(TICK * 3)
    expect(c.send).not.toHaveBeenCalled()
  })

  it('never polls when the selected execution is already terminal (AC#3)', async () => {
    const c = makeCtx()
    c.selectedScheduleId.value = 's1'
    c.selectedExecutionId.value = 'e1'
    c.selectedSchedule.value = llmSchedule
    c.activeTab.value = 'schedules'
    c.selectedExecution.value = doneLog()
    await nextTick()
    c.send.mockClear()

    vi.advanceTimersByTime(TICK * 3)
    expect(c.send).not.toHaveBeenCalled()
  })

  it('never polls a non-llm (command) running execution (AC#5)', async () => {
    const c = makeCtx()
    c.selectedScheduleId.value = 's1'
    c.selectedExecutionId.value = 'e1'
    c.selectedSchedule.value = commandSchedule
    c.activeTab.value = 'schedules'
    c.selectedExecution.value = runningLog()
    await nextTick()
    c.send.mockClear()

    vi.advanceTimersByTime(TICK * 3)
    expect(c.send).not.toHaveBeenCalled()
  })

  it('skips the tick while hidden and resumes when visible again (AC#4)', async () => {
    const c = makeCtx()
    await selectRunning(c)
    c.send.mockClear()

    setVisible('hidden')
    vi.advanceTimersByTime(TICK * 2)
    expect(c.send).not.toHaveBeenCalled()

    setVisible('visible')
    vi.advanceTimersByTime(TICK)
    expect(detailCalls(c.send)).toHaveLength(1)
    expect(transcriptCalls(c.send)).toHaveLength(1)
  })

  it('stops polling when leaving the schedules tab', async () => {
    const c = makeCtx()
    await selectRunning(c)
    c.activeTab.value = 'console'
    await nextTick()
    c.send.mockClear()

    vi.advanceTimersByTime(TICK * 3)
    expect(c.send).not.toHaveBeenCalled()
  })
})
