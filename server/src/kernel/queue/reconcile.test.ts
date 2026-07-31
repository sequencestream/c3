/**
 * Queue scheduling kernel — pure reconcile tests.
 *
 * Every case is a fixed snapshot plus a fixed clock asserted against the exact
 * actions and decisions the pass must produce. No timers, no I/O, no mocks: if
 * one of these fails, the scheduling RULE changed, not the plumbing around it.
 */
import { describe, expect, it } from 'vitest'
import { reconcileQueue } from './reconcile.js'
import {
  QUEUE_BACKOFF_BASE_MS,
  QUEUE_COOLDOWN_MS,
  QUEUE_MAX_ATTEMPTS,
  QUEUE_PERMISSION_WAIT_MS,
  backoffDelayMs,
  emptyQueueIntentMeta,
  type QueueIntentFact,
  type QueueIntentMeta,
  type QueueReconcileInput,
} from './types.js'

const NOW = 1_700_000_000_000

function intent(over: Partial<QueueIntentFact> & { id: string }): QueueIntentFact {
  return {
    title: `intent-${over.id}`,
    status: 'todo',
    priority: 'P2',
    automate: true,
    dependsOn: [],
    specApproved: false,
    prStatus: null,
    lastWorkSessionId: null,
    createdAt: 1,
    ...over,
  }
}

function meta(intentId: string, over: Partial<QueueIntentMeta> = {}): QueueIntentMeta {
  return { ...emptyQueueIntentMeta(intentId), ...over }
}

function input(over: Partial<QueueReconcileInput> = {}): QueueReconcileInput {
  return {
    now: NOW,
    tickId: 'tick-1',
    workspacePath: '/w',
    control: { state: 'running', startedAt: NOW - 1000, forceSkipped: [] },
    snapshotOk: true,
    intents: [],
    runs: [],
    meta: {},
    inFlight: [],
    gitBranchMode: 'current-branch',
    sddEnabled: false,
    ...over,
  }
}

/** The single intent the pass decided to start, or null. */
function launched(out: ReturnType<typeof reconcileQueue>): string | null {
  const a = out.actions.find((x) => x.kind === 'launch' || x.kind === 'resume')
  return a && 'intentId' in a ? a.intentId : null
}

function decisionFor(out: ReturnType<typeof reconcileQueue>, id: string) {
  return out.decisions.find((d) => d.intentId === id)
}

describe('reconcileQueue — selection', () => {
  it('picks by priority then oldest, one intent at a time', () => {
    const out = reconcileQueue(
      input({
        intents: [
          intent({ id: 'late-p0', priority: 'P0', createdAt: 20 }),
          intent({ id: 'early-p0', priority: 'P0', createdAt: 10 }),
          intent({ id: 'p1', priority: 'P1', createdAt: 1 }),
        ],
      }),
    )
    expect(launched(out)).toBe('early-p0')
    expect(out.actions.filter((a) => a.kind === 'launch')).toHaveLength(1)
    expect(out.state).toBe('developing')
  })

  it('is idempotent: the same input twice yields the same actions and decisions', () => {
    const snapshot = input({ intents: [intent({ id: 'A' }), intent({ id: 'B' })] })
    const first = reconcileQueue(snapshot)
    const second = reconcileQueue(snapshot)
    expect(second.actions).toEqual(first.actions)
    expect(second.decisions).toEqual(first.decisions)
  })

  it('ignores non-automate and terminal intents entirely', () => {
    const out = reconcileQueue(
      input({
        intents: [
          intent({ id: 'manual', automate: false }),
          intent({ id: 'finished', status: 'done' }),
          intent({ id: 'dropped', status: 'cancelled' }),
        ],
      }),
    )
    expect(out.actions).toHaveLength(0)
    expect(out.decisions).toHaveLength(0)
    expect(out.state).toBe('done')
  })

  it('an idle queue schedules nothing and records nothing', () => {
    const out = reconcileQueue(
      input({
        control: { state: 'idle', startedAt: null, forceSkipped: [] },
        intents: [intent({ id: 'A' })],
      }),
    )
    expect(out.state).toBe('idle')
    expect(out.actions).toHaveLength(0)
    expect(out.decisions).toHaveLength(0)
  })
})

describe('reconcileQueue — gates', () => {
  it('SDD on without approval yields blocked_spec_not_approved, never a silent skip', () => {
    const out = reconcileQueue(
      input({ sddEnabled: true, intents: [intent({ id: 'A', specApproved: false })] }),
    )
    expect(launched(out)).toBeNull()
    expect(decisionFor(out, 'A')).toMatchObject({
      action: 'block',
      reason: 'blocked_spec_not_approved',
    })
    // A blocked candidate is NOT a finished queue.
    expect(out.state).toBe('running')
  })

  it('an unfinished dependency blocks; an unknown dependency does not', () => {
    const out = reconcileQueue(
      input({
        intents: [
          intent({ id: 'dep', status: 'in_progress' }),
          intent({ id: 'child', dependsOn: ['dep'] }),
          intent({ id: 'ghost', dependsOn: ['deleted-elsewhere'], createdAt: 99 }),
        ],
      }),
    )
    expect(decisionFor(out, 'child')).toMatchObject({ reason: 'blocked_dependency' })
    // `dep` itself is a candidate and gets selected; `ghost` is eligible but waits.
    expect(launched(out)).toBe('dep')
    expect(decisionFor(out, 'ghost')).toMatchObject({ reason: 'blocked_concurrency_gate' })
  })

  it('worktree mode also requires the dependency PR to be merged', () => {
    const base = {
      intents: [
        intent({ id: 'dep', status: 'done', prStatus: 'reviewing' as const }),
        intent({ id: 'child', dependsOn: ['dep'] }),
      ],
    }
    const worktree = reconcileQueue(input({ ...base, gitBranchMode: 'worktree' }))
    expect(launched(worktree)).toBeNull()
    expect(decisionFor(worktree, 'child')).toMatchObject({
      reason: 'blocked_dependency_pr_unmerged',
    })
    // …and asks for a PR-status refresh rather than sitting on stale facts.
    expect(worktree.actions).toContainEqual({ kind: 'sync_dependency_prs', intentIds: ['dep'] })

    const inPlace = reconcileQueue(input({ ...base, gitBranchMode: 'current-branch' }))
    expect(launched(inPlace)).toBe('child')
  })

  it('backoff and cooldown block only until their deadline, and set the wake-up', () => {
    const backingOff = reconcileQueue(
      input({
        intents: [intent({ id: 'A' })],
        meta: { A: meta('A', { failureCount: 1, backoffUntil: NOW + 5_000 }) },
      }),
    )
    expect(launched(backingOff)).toBeNull()
    expect(decisionFor(backingOff, 'A')).toMatchObject({ reason: 'blocked_backoff' })
    expect(backingOff.nextWakeupAt).toBe(NOW + 5_000)

    const expired = reconcileQueue(
      input({
        intents: [intent({ id: 'A' })],
        meta: { A: meta('A', { failureCount: 1, backoffUntil: NOW - 1 }) },
      }),
    )
    expect(launched(expired)).toBe('A')

    const cooling = reconcileQueue(
      input({
        intents: [intent({ id: 'A' })],
        meta: { A: meta('A', { cooldownUntil: NOW + QUEUE_COOLDOWN_MS }) },
      }),
    )
    expect(decisionFor(cooling, 'A')).toMatchObject({ reason: 'blocked_cooldown' })
  })

  it('force-skip changes only this queue’s selection — it never satisfies a dependency', () => {
    const out = reconcileQueue(
      input({
        control: { state: 'running', startedAt: NOW, forceSkipped: ['dep'] },
        intents: [intent({ id: 'dep' }), intent({ id: 'child', dependsOn: ['dep'], createdAt: 5 })],
      }),
    )
    expect(decisionFor(out, 'dep')).toMatchObject({ reason: 'blocked_force_skipped' })
    // The downstream is still blocked: skipping is not completing.
    expect(decisionFor(out, 'child')).toMatchObject({ reason: 'blocked_dependency' })
    expect(launched(out)).toBeNull()
  })
})

describe('reconcileQueue — failure isolation', () => {
  it('parks after the attempt cap, keeps unrelated work flowing', () => {
    const out = reconcileQueue(
      input({
        intents: [
          intent({ id: 'broken', priority: 'P0' }),
          intent({ id: 'healthy', priority: 'P1' }),
        ],
        meta: {
          broken: meta('broken', {
            failureCount: QUEUE_MAX_ATTEMPTS,
            parked: true,
            parkReason: 'launch_failed',
            parkDetail: '连续失败',
          }),
        },
      }),
    )
    expect(decisionFor(out, 'broken')).toMatchObject({ reason: 'blocked_parked' })
    // The queue does NOT stop: the unrelated intent is selected.
    expect(launched(out)).toBe('healthy')
  })

  it('a parked intent keeps its downstream blocked — parking never opens a path around', () => {
    const out = reconcileQueue(
      input({
        intents: [
          intent({ id: 'broken' }),
          intent({ id: 'downstream', dependsOn: ['broken'], createdAt: 5 }),
          intent({ id: 'unrelated', createdAt: 9 }),
        ],
        meta: { broken: meta('broken', { parked: true, parkReason: 'judge_stuck' }) },
      }),
    )
    expect(decisionFor(out, 'downstream')).toMatchObject({ reason: 'blocked_dependency' })
    expect(launched(out)).toBe('unrelated')
  })

  it('backoff grows exponentially and is capped', () => {
    expect(backoffDelayMs(1)).toBe(QUEUE_BACKOFF_BASE_MS)
    expect(backoffDelayMs(2)).toBe(QUEUE_BACKOFF_BASE_MS * 2)
    expect(backoffDelayMs(99)).toBeLessThanOrEqual(15 * 60_000)
  })
})

describe('reconcileQueue — run liveness', () => {
  it('attaches to an eligible intent whose own session is still running', () => {
    const out = reconcileQueue(
      input({
        intents: [intent({ id: 'A', status: 'in_progress', lastWorkSessionId: 's1' })],
        runs: [{ sessionId: 's1', alive: true, awaitingPermissionSince: null }],
      }),
    )
    expect(out.actions).toContainEqual({
      kind: 'attach',
      intentId: 'A',
      sessionId: 's1',
      origin: 'queue-kernel',
    })
    // Never a second launch for a run that outlives its turn.
    expect(out.actions.some((a) => a.kind === 'launch')).toBe(false)
  })

  it('a live MANUAL session holds the global concurrency gate shut', () => {
    const out = reconcileQueue(
      input({
        intents: [
          intent({ id: 'manual', automate: false, status: 'in_progress', lastWorkSessionId: 'm1' }),
          intent({ id: 'queued' }),
        ],
        runs: [{ sessionId: 'm1', alive: true, awaitingPermissionSince: null }],
      }),
    )
    expect(out.state).toBe('awaiting_gate')
    expect(launched(out)).toBeNull()
    expect(decisionFor(out, 'queued')).toMatchObject({ reason: 'blocked_concurrency_gate' })
  })

  it('a DEAD blocking session releases the gate and the intent resumes', () => {
    const out = reconcileQueue(
      input({
        intents: [intent({ id: 'A', status: 'in_progress', lastWorkSessionId: 's1' })],
        runs: [{ sessionId: 's1', alive: false, awaitingPermissionSince: null }],
      }),
    )
    expect(out.state).toBe('developing')
    expect(out.actions).toContainEqual({
      kind: 'resume',
      intentId: 'A',
      sessionId: 's1',
      origin: 'queue-kernel',
    })
  })

  it('an intent the kernel already drives is observed, never launched again', () => {
    const out = reconcileQueue(
      input({
        intents: [intent({ id: 'A', status: 'in_progress' }), intent({ id: 'B', createdAt: 5 })],
        inFlight: ['A'],
      }),
    )
    expect(out.actions).toHaveLength(0)
    expect(decisionFor(out, 'A')).toMatchObject({ action: 'wait', reason: 'running' })
    expect(decisionFor(out, 'B')).toMatchObject({ reason: 'blocked_concurrency_gate' })
    expect(out.state).toBe('developing')
  })
})

describe('reconcileQueue — human decisions', () => {
  it('a permission wait past the window parks and raises ONE todo, never an answer', () => {
    const out = reconcileQueue(
      input({
        intents: [intent({ id: 'A', status: 'in_progress', lastWorkSessionId: 's1' })],
        runs: [
          {
            sessionId: 's1',
            alive: true,
            awaitingPermissionSince: NOW - QUEUE_PERMISSION_WAIT_MS - 1,
          },
        ],
      }),
    )
    expect(out.actions).toContainEqual({
      kind: 'park',
      intentId: 'A',
      reason: 'permission_wait_timeout',
      detail: '权限提示长时间无人应答,已交回人工',
    })
    expect(out.actions.filter((a) => a.kind === 'wait_user_involve')).toHaveLength(1)
    // The queue answers nothing and aborts nothing — no run-touching action at all.
    expect(out.actions.some((a) => a.kind === 'launch' || a.kind === 'resume')).toBe(false)
    expect(out.awaitingPermission).toBe(true)
  })

  it('a permission wait inside the window is left alone', () => {
    const out = reconcileQueue(
      input({
        intents: [intent({ id: 'A', status: 'in_progress', lastWorkSessionId: 's1' })],
        runs: [{ sessionId: 's1', alive: true, awaitingPermissionSince: NOW - 1_000 }],
      }),
    )
    expect(out.actions.some((a) => a.kind === 'park')).toBe(false)
  })

  it('an already-parked intent is not parked (or re-todo’d) a second time', () => {
    const out = reconcileQueue(
      input({
        intents: [intent({ id: 'A', status: 'in_progress', lastWorkSessionId: 's1' })],
        runs: [
          {
            sessionId: 's1',
            alive: true,
            awaitingPermissionSince: NOW - QUEUE_PERMISSION_WAIT_MS - 1,
          },
        ],
        meta: { A: meta('A', { parked: true, parkReason: 'permission_wait_timeout' }) },
      }),
    )
    expect(out.actions.some((a) => a.kind === 'park')).toBe(false)
    expect(out.actions.some((a) => a.kind === 'wait_user_involve')).toBe(false)
  })
})

describe('reconcileQueue — queue-level states', () => {
  it('paused launches nothing and preserves the candidate set', () => {
    const out = reconcileQueue(
      input({
        control: { state: 'paused', startedAt: NOW, forceSkipped: [] },
        intents: [intent({ id: 'A' }), intent({ id: 'B' })],
      }),
    )
    expect(out.state).toBe('paused')
    expect(out.actions).toHaveLength(0)
    expect(out.decisions.map((d) => d.reason)).toEqual(['queue_paused', 'queue_paused'])
  })

  it('an unreadable snapshot fails closed — no launch, one workspace-level record', () => {
    const out = reconcileQueue(input({ snapshotOk: false, intents: [intent({ id: 'A' })] }))
    expect(out.actions).toHaveLength(0)
    expect(out.decisions).toEqual([
      expect.objectContaining({ intentId: '', reason: 'snapshot_unavailable' }),
    ])
    expect(out.state).toBe('running')
  })

  it('`done` requires an empty candidate set, not merely an empty eligible set', () => {
    const blocked = reconcileQueue(
      input({
        intents: [intent({ id: 'A' })],
        meta: { A: meta('A', { parked: true, parkReason: 'judge_stuck' }) },
      }),
    )
    expect(blocked.state).toBe('running')

    const empty = reconcileQueue(input({ intents: [intent({ id: 'A', status: 'done' })] }))
    expect(empty.state).toBe('done')
  })

  it('the next wake-up is the earliest pending deadline, else one tick out', () => {
    const out = reconcileQueue(
      input({
        intents: [intent({ id: 'A' }), intent({ id: 'B', createdAt: 5 })],
        meta: {
          A: meta('A', { backoffUntil: NOW + 90_000 }),
          B: meta('B', { backoffUntil: NOW + 12_000 }),
        },
      }),
    )
    expect(out.nextWakeupAt).toBe(NOW + 12_000)

    const plain = reconcileQueue(input({ intents: [intent({ id: 'A' })] }))
    expect(plain.nextWakeupAt).toBe(NOW + 10_000)
  })
})

describe('reconcileQueue — restart recovery', () => {
  it('rebuilds everything from persisted facts alone', () => {
    // A fresh process: no in-flight runs, no memory of what was happening.
    const out = reconcileQueue(
      input({
        intents: [
          intent({ id: 'was-running', status: 'in_progress', lastWorkSessionId: 'dead' }),
          intent({ id: 'was-parked', createdAt: 5 }),
          intent({ id: 'fresh', createdAt: 9 }),
        ],
        runs: [{ sessionId: 'dead', alive: false, awaitingPermissionSince: null }],
        meta: {
          'was-parked': meta('was-parked', { parked: true, parkReason: 'commit_failed' }),
        },
        inFlight: [],
      }),
    )
    // The half-finished intent is resumed, the parked one stays parked, and the
    // queue is running again — no invented state, no cleared state.
    expect(out.actions).toContainEqual({
      kind: 'resume',
      intentId: 'was-running',
      sessionId: 'dead',
      origin: 'queue-kernel',
    })
    expect(decisionFor(out, 'was-parked')).toMatchObject({ reason: 'blocked_parked' })
  })

  it('intents with no scheduling metadata read as zero failures, unparked, no backoff', () => {
    const out = reconcileQueue(input({ intents: [intent({ id: 'historic' })], meta: {} }))
    expect(launched(out)).toBe('historic')
    expect(decisionFor(out, 'historic')).toMatchObject({ attemptCount: 0, backoffCount: 0 })
  })
})
