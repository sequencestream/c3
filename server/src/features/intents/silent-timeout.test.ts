/**
 * Silent-timeout detection: the threshold boundary, every known wait that must
 * suppress it, and the "repeating yourself is not progress" rule.
 *
 * Split in two: the judgement itself is exercised as a pure function against a
 * fixed clock (no db, no registry), and the gathering half is exercised with the
 * queue store / run registry mocked, so the two failure modes stay separable.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Intent } from '@ccc/shared/protocol'
import type { QueueReasonCode } from '../../kernel/queue/index.js'
import { QUEUE_REASON_CODES } from '../../kernel/queue/index.js'
import type { QueueDecisionRow } from './queue-store.js'

const queueControl = vi.fn()
const queueMeta = vi.fn()
const decisions = vi.fn<(intentId: string, limit?: number) => QueueDecisionRow[]>()
vi.mock('./queue-store.js', () => ({
  getQueueControl: (workspacePath: string) => queueControl(workspacePath),
  getQueueIntentMetaById: (intentId: string) => queueMeta(intentId),
  listQueueDecisionsForIntent: (intentId: string, limit?: number) => decisions(intentId, limit),
}))

const lastActivity = vi.fn<(id: string) => number | null>()
const awaitingPermission = vi.fn<(id: string) => boolean>()
vi.mock('../../runs.js', () => ({
  sessionLastActivityAt: (id: string) => lastActivity(id),
  isAwaitingPermission: (id: string) => awaitingPermission(id),
}))

vi.mock('../../state.js', () => ({
  resolveWorkspaceRoot: (id: string) => (id === 'ws' ? '/proj' : null),
}))

const {
  SILENT_TIMEOUT_MS,
  decisionChangedAt,
  deriveSilentTimeoutActionDescriptor,
  isSilentTimeout,
} = await import('./silent-timeout.js')

const NOW = 1_800_000_000_000

/** A judgeable intent: automated, running queue, driving decision, long silent. */
function facts(overrides: Partial<Parameters<typeof isSilentTimeout>[0]> = {}) {
  return {
    now: NOW,
    automate: true,
    status: 'in_progress' as const,
    queueState: 'running' as const,
    queueStartedAt: NOW - 10 * 60 * 60_000,
    forceSkipped: false,
    parked: false,
    backoffUntil: null,
    cooldownUntil: null,
    awaitingPermission: false,
    latestReason: 'running' as QueueReasonCode | null,
    ledgerUpdatedAt: NOW - SILENT_TIMEOUT_MS,
    runActivityAt: null,
    metaUpdatedAt: null,
    decisionChangedAt: null,
    ...overrides,
  }
}

function decisionRow(overrides: Partial<QueueDecisionRow> = {}): QueueDecisionRow {
  return {
    id: 'd-1',
    tickId: 't-1',
    workspaceName: '/proj',
    intentId: 'i-1',
    decidedAt: NOW,
    action: 'wait',
    blockedGate: 'running',
    rejectReason: '内核 run 进行中',
    attemptCount: 0,
    backoffCount: 0,
    nextWakeupAt: null,
    ...overrides,
  }
}

describe('isSilentTimeout — the threshold', () => {
  it('does not trigger one millisecond short of the window', () => {
    expect(isSilentTimeout(facts({ ledgerUpdatedAt: NOW - SILENT_TIMEOUT_MS + 1 }))).toBe(false)
  })

  it('triggers exactly at the window', () => {
    expect(isSilentTimeout(facts({ ledgerUpdatedAt: NOW - SILENT_TIMEOUT_MS }))).toBe(true)
  })

  it('keeps triggering well beyond the window', () => {
    expect(isSilentTimeout(facts({ ledgerUpdatedAt: NOW - 6 * SILENT_TIMEOUT_MS }))).toBe(true)
  })

  it('clears the moment any real progress lands, and re-times from it', () => {
    // Run activity arrives: silence is over even though the ledger is ancient.
    const progressed = facts({
      ledgerUpdatedAt: NOW - 6 * SILENT_TIMEOUT_MS,
      runActivityAt: NOW - 1,
    })
    expect(isSilentTimeout(progressed)).toBe(false)
    // …and the next window is measured from THAT activity, not from the ledger.
    const later = { ...progressed, now: NOW - 1 + SILENT_TIMEOUT_MS }
    expect(isSilentTimeout({ ...later, now: later.now - 1 })).toBe(false)
    expect(isSilentTimeout(later)).toBe(true)
  })

  it('takes the most recent of every progress fact', () => {
    const stale = NOW - 6 * SILENT_TIMEOUT_MS
    for (const fresh of [
      'ledgerUpdatedAt',
      'runActivityAt',
      'metaUpdatedAt',
      'decisionChangedAt',
    ]) {
      expect(
        isSilentTimeout(
          facts({
            ledgerUpdatedAt: stale,
            runActivityAt: stale,
            metaUpdatedAt: stale,
            decisionChangedAt: stale,
            queueStartedAt: stale,
            [fresh]: NOW - 60_000,
          }),
        ),
      ).toBe(false)
    }
  })

  it('counts the queue start itself as a scheduling change', () => {
    // A todo untouched for days must not be reported the moment its queue starts.
    expect(
      isSilentTimeout(
        facts({
          status: 'todo',
          ledgerUpdatedAt: NOW - 48 * 60 * 60_000,
          queueStartedAt: NOW - 60_000,
        }),
      ),
    ).toBe(false)
  })
})

describe('isSilentTimeout — unreliable time never reports', () => {
  it('stays quiet when every progress fact is missing', () => {
    expect(
      isSilentTimeout(
        facts({
          ledgerUpdatedAt: null,
          runActivityAt: null,
          metaUpdatedAt: null,
          decisionChangedAt: null,
          queueStartedAt: null,
        }),
      ),
    ).toBe(false)
  })

  it('treats zero-valued metadata as never observed, not as epoch zero', () => {
    expect(
      isSilentTimeout(
        facts({
          ledgerUpdatedAt: null,
          metaUpdatedAt: 0,
          queueStartedAt: null,
        }),
      ),
    ).toBe(false)
  })

  it('stays quiet on a future timestamp (clock skew)', () => {
    expect(isSilentTimeout(facts({ ledgerUpdatedAt: NOW + 60 * 60_000 }))).toBe(false)
  })

  it('stays quiet when the clock jumps backwards past every fact', () => {
    // `now` rewound behind the recorded progress: elapsed is negative, not huge.
    expect(isSilentTimeout(facts({ now: NOW - 24 * 60 * 60_000 }))).toBe(false)
  })
})

describe('isSilentTimeout — every known wait suppresses it', () => {
  it('ignores non-automated intents', () => {
    expect(isSilentTimeout(facts({ automate: false }))).toBe(false)
  })

  it('ignores terminal intents', () => {
    for (const status of ['done', 'cancelled'] as const) {
      expect(isSilentTimeout(facts({ status }))).toBe(false)
    }
  })

  it('judges both open statuses', () => {
    for (const status of ['todo', 'in_progress'] as const) {
      expect(isSilentTimeout(facts({ status }))).toBe(true)
    }
  })

  it('does not time an idle or paused queue', () => {
    for (const queueState of ['idle', 'paused'] as const) {
      expect(isSilentTimeout(facts({ queueState }))).toBe(false)
    }
  })

  it('stays quiet for a parked or force-skipped intent', () => {
    expect(isSilentTimeout(facts({ parked: true }))).toBe(false)
    expect(isSilentTimeout(facts({ forceSkipped: true }))).toBe(false)
  })

  it('stays quiet while a backoff or cooldown is still in the future', () => {
    expect(isSilentTimeout(facts({ backoffUntil: NOW + 1 }))).toBe(false)
    expect(isSilentTimeout(facts({ cooldownUntil: NOW + 1 }))).toBe(false)
  })

  it('an elapsed backoff or cooldown no longer explains the silence', () => {
    expect(isSilentTimeout(facts({ backoffUntil: NOW }))).toBe(true)
    expect(isSilentTimeout(facts({ cooldownUntil: NOW - 1 }))).toBe(true)
  })

  it('stays quiet while a permission prompt is unanswered', () => {
    expect(isSilentTimeout(facts({ awaitingPermission: true }))).toBe(false)
  })

  it('reports only the four driving reasons; every other queue reason is explained', () => {
    const driving: QueueReasonCode[] = ['selected', 'attached_running', 'resumed', 'running']
    for (const reason of QUEUE_REASON_CODES) {
      expect([reason, isSilentTimeout(facts({ latestReason: reason }))]).toEqual([
        reason,
        driving.includes(reason),
      ])
    }
  })

  it('stays quiet when the queue has said nothing about this intent', () => {
    expect(isSilentTimeout(facts({ latestReason: null }))).toBe(false)
  })
})

describe('decisionChangedAt — a repeated conclusion is not progress', () => {
  it('dates a run of identical conclusions from its oldest row', () => {
    const rows = [
      decisionRow({ id: 'd3', decidedAt: NOW }),
      decisionRow({ id: 'd2', decidedAt: NOW - 10_000 }),
      decisionRow({ id: 'd1', decidedAt: NOW - 40 * 60_000 }),
    ]
    expect(decisionChangedAt(rows)).toBe(NOW - 40 * 60_000)
  })

  it('stops at the first row that says something different', () => {
    const rows = [
      decisionRow({ id: 'd3', decidedAt: NOW }),
      decisionRow({ id: 'd2', decidedAt: NOW - 10_000 }),
      decisionRow({ id: 'd1', decidedAt: NOW - 40 * 60_000, blockedGate: 'selected' }),
    ]
    expect(decisionChangedAt(rows)).toBe(NOW - 10_000)
  })

  it('treats a changed detail as a changed conclusion', () => {
    const rows = [
      decisionRow({ id: 'd2', decidedAt: NOW }),
      decisionRow({ id: 'd1', decidedAt: NOW - 40 * 60_000, rejectReason: 'other' }),
    ]
    expect(decisionChangedAt(rows)).toBe(NOW)
  })

  it('has no answer for an empty log', () => {
    expect(decisionChangedAt([])).toBeNull()
  })
})

describe('deriveSilentTimeoutActionDescriptor — gathering', () => {
  const intent = (overrides: Partial<Intent> = {}): Intent =>
    ({
      id: 'i-1',
      workspaceName: 'ws',
      title: 'T',
      status: 'in_progress',
      automate: true,
      updatedAt: NOW - 6 * SILENT_TIMEOUT_MS,
      intentSessionId: null,
      responsibleSubject: null,
      specSessionId: null,
      specReviewSessionId: null,
      lastWorkSessionId: 'sess-1',
      ...overrides,
    }) as Intent

  beforeEach(() => {
    queueControl.mockReset()
    queueControl.mockReturnValue({
      state: 'running',
      startedAt: NOW - 10 * 60 * 60_000,
      forceSkipped: [],
    })
    queueMeta.mockReset()
    queueMeta.mockReturnValue({
      intentId: 'i-1',
      failureCount: 0,
      backoffCount: 0,
      backoffUntil: null,
      parked: false,
      parkReason: null,
      parkDetail: null,
      cooldownUntil: null,
      updatedAt: 0,
    })
    decisions.mockReset()
    decisions.mockReturnValue([decisionRow({ decidedAt: NOW - 6 * SILENT_TIMEOUT_MS })])
    lastActivity.mockReset()
    lastActivity.mockReturnValue(null)
    awaitingPermission.mockReset()
    awaitingPermission.mockReturnValue(false)
  })

  it('projects the inspection jump for a silently stuck intent', () => {
    expect(deriveSilentTimeoutActionDescriptor(intent(), NOW)).toEqual({
      labelCode: 'silent_timeout',
      target: { type: 'intent-work-session', intentId: 'i-1' },
    })
  })

  it('a live run that keeps emitting is never called silent', () => {
    lastActivity.mockReturnValue(NOW - 60_000)
    expect(deriveSilentTimeoutActionDescriptor(intent(), NOW)).toBeNull()
  })

  it('a live run that stopped emitting IS called silent', () => {
    // "Still alive" is not "still progressing": only the activity instant counts.
    lastActivity.mockReturnValue(NOW - 6 * SILENT_TIMEOUT_MS)
    expect(deriveSilentTimeoutActionDescriptor(intent(), NOW)).not.toBeNull()
  })

  it('reads activity across every one of the intent’s sessions', () => {
    lastActivity.mockImplementation((id) => (id === 'spec-1' ? NOW - 60_000 : null))
    expect(deriveSilentTimeoutActionDescriptor(intent({ specSessionId: 'spec-1' }), NOW)).toBeNull()
    expect(lastActivity).toHaveBeenCalledWith('spec-1')
    expect(lastActivity).toHaveBeenCalledWith('sess-1')
  })

  it('repeated ticks on the same conclusion do not renew the window', () => {
    // The newest row is one tick old, but the conclusion has stood for hours.
    decisions.mockReturnValue([
      decisionRow({ id: 'd3', decidedAt: NOW - 10_000 }),
      decisionRow({ id: 'd2', decidedAt: NOW - 20_000 }),
      decisionRow({ id: 'd1', decidedAt: NOW - 6 * SILENT_TIMEOUT_MS }),
    ])
    expect(deriveSilentTimeoutActionDescriptor(intent(), NOW)).not.toBeNull()
  })

  it('a genuinely new conclusion renews the window', () => {
    decisions.mockReturnValue([
      decisionRow({ id: 'd2', decidedAt: NOW - 60_000, blockedGate: 'selected' }),
      decisionRow({ id: 'd1', decidedAt: NOW - 6 * SILENT_TIMEOUT_MS }),
    ])
    expect(deriveSilentTimeoutActionDescriptor(intent(), NOW)).toBeNull()
  })

  it('skips the decision query entirely when the in-memory facts are fresh', () => {
    expect(deriveSilentTimeoutActionDescriptor(intent({ updatedAt: NOW - 60_000 }), NOW)).toBeNull()
    expect(decisions).not.toHaveBeenCalled()
  })

  it('never touches the queue store for a non-automated or terminal intent', () => {
    expect(deriveSilentTimeoutActionDescriptor(intent({ automate: false }), NOW)).toBeNull()
    expect(deriveSilentTimeoutActionDescriptor(intent({ status: 'done' }), NOW)).toBeNull()
    expect(queueControl).not.toHaveBeenCalled()
  })

  it('stays quiet for an unresolvable workspace', () => {
    expect(deriveSilentTimeoutActionDescriptor(intent({ workspaceName: 'gone' }), NOW)).toBeNull()
    expect(queueControl).not.toHaveBeenCalled()
  })

  it('honours a force-skip recorded on the workspace control row', () => {
    queueControl.mockReturnValue({
      state: 'running',
      startedAt: NOW - 10 * 60 * 60_000,
      forceSkipped: ['i-1'],
    })
    expect(deriveSilentTimeoutActionDescriptor(intent(), NOW)).toBeNull()
  })

  it('survives a restart: persisted metadata and decisions still date the silence', () => {
    // Nothing in the run registry (a restart forgot every runtime), yet the
    // persisted decision log and ledger still carry a reliable baseline.
    lastActivity.mockReturnValue(null)
    expect(deriveSilentTimeoutActionDescriptor(intent(), NOW)).not.toBeNull()
  })

  it('ignores a decision reason this build no longer knows', () => {
    decisions.mockReturnValue([
      decisionRow({ decidedAt: NOW - 6 * SILENT_TIMEOUT_MS, blockedGate: 'legacy_reason' }),
    ])
    expect(deriveSilentTimeoutActionDescriptor(intent(), NOW)).toBeNull()
  })
})
