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
  QUEUE_MAX_SPEC_REWORK,
  QUEUE_PERMISSION_WAIT_MS,
  QUEUE_TICK_MS,
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
    specStatus: 'raw',
    prStatus: null,
    lastWorkSessionId: null,
    createdAt: 1,
    specPath: null,
    specSessionId: null,
    specReviewSessionId: null,
    specFingerprint: null,
    specReviewVerdict: null,
    specReviewFingerprint: null,
    specReviewReworkRounds: 0,
    specReviewMachineApprovalBlocked: false,
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
    machineApprovalEnabled: false,
    automationConcurrency: 2,
    specRuns: [],
    specInFlight: [],
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
  it('SDD on without approval never DEVELOPS, and never silently skips', () => {
    const out = reconcileQueue(
      input({ sddEnabled: true, intents: [intent({ id: 'A', specStatus: 'raw' })] }),
    )
    // The development gate is what this asserts: an unapproved spec is never
    // developed, whatever the spec phase decides to do about authoring it.
    expect(launched(out)).toBeNull()
    expect(decisionFor(out, 'A')).toBeDefined()
    // A blocked candidate is NOT a finished queue.
    expect(out.state).toBe('running')
  })

  it('leaves the spec gate fully closed when SDD is off — no spec phase at all', () => {
    const out = reconcileQueue(
      input({
        sddEnabled: false,
        machineApprovalEnabled: true,
        intents: [intent({ id: 'A', specStatus: 'raw' })],
      }),
    )
    // Without SDD the spec gate does not apply, so A is developed directly and
    // no spec-phase action is produced even with machine approval switched on.
    expect(launched(out)).toBe('A')
    expect(out.actions.some((a) => a.kind.startsWith('launch_spec'))).toBe(false)
    expect(out.actions.some((a) => a.kind === 'machine_approve_spec')).toBe(false)
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

  // The hard gates are an ordered ladder, not independent checks. One intent
  // that violates several at once must be reported at the TOP gate only; as
  // each gate is released the reason falls through to the next one, exactly in
  // the order the assembly layer relies on.
  it('gate precedence: park → force-skip → spec → dependency → backoff → cooldown → concurrency', () => {
    /** X violates every gate; `relax` peels them off one layer at a time. */
    const pass = (relax: {
      unparked?: boolean
      unskipped?: boolean
      specApproved?: boolean
      depDone?: boolean
      backoffExpired?: boolean
      cooldownExpired?: boolean
    }) =>
      reconcileQueue(
        input({
          sddEnabled: true,
          control: {
            state: 'running',
            startedAt: NOW,
            forceSkipped: relax.unskipped ? [] : ['X'],
          },
          intents: [
            // dep carries its own approval so it never enters the spec phase and
            // steals the single session-starting slot from X.
            intent({
              id: 'dep',
              status: relax.depDone ? 'done' : 'in_progress',
              prStatus: 'merged',
              specStatus: 'approved',
            }),
            intent({
              id: 'X',
              dependsOn: ['dep'],
              specStatus: relax.specApproved ? 'approved' : 'raw',
              createdAt: 5,
            }),
          ],
          meta: {
            X: meta('X', {
              parked: !relax.unparked,
              parkReason: 'judge_stuck',
              failureCount: 2,
              backoffUntil: relax.backoffExpired ? NOW - 1 : NOW + 60_000,
              cooldownUntil: relax.cooldownExpired ? NOW - 1 : NOW + QUEUE_COOLDOWN_MS,
            }),
          },
        }),
      )

    expect(decisionFor(pass({}), 'X')).toMatchObject({ reason: 'blocked_parked' })
    expect(decisionFor(pass({ unparked: true }), 'X')).toMatchObject({
      reason: 'blocked_force_skipped',
    })
    // The spec sub-state replaces the raw gate verdict for an unapproved spec.
    // (The cooldown is released first: the spec phase honours the SAME
    // self-excitation guard as development.)
    const specStep = pass({ unparked: true, unskipped: true, cooldownExpired: true })
    expect(decisionFor(specStep, 'X')).toMatchObject({ reason: 'spec_authoring' })
    expect(specStep.actions).toContainEqual(
      expect.objectContaining({ kind: 'launch_spec', intentId: 'X' }),
    )
    expect(
      decisionFor(pass({ unparked: true, unskipped: true, specApproved: true }), 'X'),
    ).toMatchObject({ reason: 'blocked_dependency' })
    expect(
      decisionFor(
        pass({ unparked: true, unskipped: true, specApproved: true, depDone: true }),
        'X',
      ),
    ).toMatchObject({ reason: 'blocked_backoff' })
    expect(
      decisionFor(
        pass({
          unparked: true,
          unskipped: true,
          specApproved: true,
          depDone: true,
          backoffExpired: true,
        }),
        'X',
      ),
    ).toMatchObject({ reason: 'blocked_cooldown' })

    // Every gate released → X is selected…
    const clear = pass({
      unparked: true,
      unskipped: true,
      specApproved: true,
      depDone: true,
      backoffExpired: true,
      cooldownExpired: true,
    })
    expect(launched(clear)).toBe('X')

    // …unless a foreign live session holds the shared-checkout concurrency gate,
    // which sits at the very bottom of the ladder.
    const concurrent = reconcileQueue(
      input({
        sddEnabled: true,
        intents: [
          intent({
            id: 'other',
            status: 'in_progress',
            specStatus: 'approved',
            lastWorkSessionId: 's-other',
            createdAt: 1,
          }),
          intent({ id: 'X', specStatus: 'approved', createdAt: 5 }),
        ],
        runs: [{ sessionId: 's-other', alive: true, awaitingPermissionSince: null }],
      }),
    )
    expect(decisionFor(concurrent, 'X')).toMatchObject({ reason: 'blocked_concurrency_gate' })
    expect(launched(concurrent)).toBeNull()
  })
})

describe('reconcileQueue — failure isolation', () => {
  it('auto-recovers a failure-ladder park with no blocked dependency, but never launches it this pass', () => {
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
    // `launch_failed` is failure-ladder and `broken` has no unsatisfied dependency:
    // the park is cleared THIS pass — but the intent is not launched, the next pass
    // re-runs every gate and decides where it actually goes.
    expect(decisionFor(out, 'broken')).toMatchObject({ action: 'unpark', reason: 'auto_unpark' })
    expect(out.actions).toContainEqual({ kind: 'unpark', intentId: 'broken' })
    expect(out.actions.some((a) => a.kind === 'launch' && a.intentId === 'broken')).toBe(false)
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

describe('reconcileQueue — auto-unpark of failure-ladder parks', () => {
  it('a failure-ladder park with every dependency satisfied yields exactly one unpark', () => {
    const out = reconcileQueue(
      input({
        intents: [
          intent({ id: 'dep', status: 'done', createdAt: 1 }),
          intent({ id: 'child', dependsOn: ['dep'], createdAt: 2 }),
        ],
        meta: {
          child: meta('child', { parked: true, parkReason: 'launch_failed', parkDetail: 'x' }),
        },
      }),
    )
    // Exactly one action this pass — the unpark — and a decision row proving it.
    expect(out.actions).toHaveLength(1)
    expect(out.actions[0]).toEqual({ kind: 'unpark', intentId: 'child' })
    expect(decisionFor(out, 'child')).toMatchObject({
      intentId: 'child',
      action: 'unpark',
      reason: 'auto_unpark',
    })
    // The intent is NOT evaluated further this pass: no launch/resume/attach.
    expect(out.actions.some((a) => a.kind === 'launch' || a.kind === 'resume')).toBe(false)
    expect(launched(out)).toBeNull()
  })

  it('idempotent: exactly one unpark per parked intent, and nothing parks or launches them', () => {
    const out = reconcileQueue(
      input({
        intents: [intent({ id: 'A', createdAt: 1 }), intent({ id: 'B', createdAt: 2 })],
        meta: {
          A: meta('A', { parked: true, parkReason: 'judge_stuck' }),
          B: meta('B', { parked: true, parkReason: 'turn_error' }),
        },
      }),
    )
    expect(out.actions.filter((a) => a.kind === 'unpark')).toEqual([
      { kind: 'unpark', intentId: 'A' },
      { kind: 'unpark', intentId: 'B' },
    ])
    expect(out.actions.filter((a) => a.kind === 'park' || a.kind === 'launch')).toHaveLength(0)
  })

  it('a recoverable park with a dependency still not done stays blocked_parked', () => {
    const out = reconcileQueue(
      input({
        intents: [
          intent({ id: 'dep', status: 'in_progress', createdAt: 1 }),
          intent({ id: 'child', dependsOn: ['dep'], createdAt: 2 }),
        ],
        meta: {
          child: meta('child', { parked: true, parkReason: 'commit_failed' }),
        },
      }),
    )
    expect(out.actions.some((a) => a.kind === 'unpark')).toBe(false)
    expect(decisionFor(out, 'child')).toMatchObject({ reason: 'blocked_parked' })
  })

  it('worktree mode also requires the dependency PR to be merged before auto-recovery', () => {
    const out = reconcileQueue(
      input({
        gitBranchMode: 'worktree',
        intents: [
          intent({ id: 'dep', status: 'done', prStatus: 'reviewing' as const, createdAt: 1 }),
          intent({ id: 'child', dependsOn: ['dep'], createdAt: 2 }),
        ],
        meta: {
          child: meta('child', { parked: true, parkReason: 'budget_exhausted' }),
        },
      }),
    )
    expect(out.actions.some((a) => a.kind === 'unpark')).toBe(false)
    // The park gate sits ABOVE the dependency gate, so the verdict is
    // blocked_parked (not blocked_dependency_pr_unmerged) — and no PR sync fires.
    expect(decisionFor(out, 'child')).toMatchObject({ reason: 'blocked_parked' })
    expect(out.actions.some((a) => a.kind === 'sync_dependency_prs')).toBe(false)
  })

  it.each(['permission_wait_timeout', 'spec_rework_exhausted', 'needs_human_decision'] as const)(
    'a human-owned park (%s) is never auto-recovered, even with all dependencies satisfied',
    (reason) => {
      const out = reconcileQueue(
        input({
          intents: [intent({ id: 'child', createdAt: 1 })],
          meta: { child: meta('child', { parked: true, parkReason: reason, parkDetail: 'x' }) },
        }),
      )
      expect(out.actions.some((a) => a.kind === 'unpark')).toBe(false)
      expect(decisionFor(out, 'child')).toMatchObject({ reason: 'blocked_parked' })
    },
  )

  it('an unknown or missing parkReason is never auto-recovered', () => {
    const unknown = reconcileQueue(
      input({
        intents: [intent({ id: 'A', createdAt: 1 })],
        meta: { A: meta('A', { parked: true, parkReason: 'max_attempts_reached' }) },
      }),
    )
    expect(unknown.actions.some((a) => a.kind === 'unpark')).toBe(false)
    expect(decisionFor(unknown, 'A')).toMatchObject({ reason: 'blocked_parked' })

    // A parked intent with no recorded reason (defensive path) is not recoverable.
    const bare = reconcileQueue(
      input({
        intents: [intent({ id: 'B', createdAt: 2 })],
        meta: { B: meta('B', { parked: true, parkReason: null }) },
      }),
    )
    expect(bare.actions.some((a) => a.kind === 'unpark')).toBe(false)
    expect(decisionFor(bare, 'B')).toMatchObject({ reason: 'blocked_parked' })
  })

  it('an unparked candidate is untouched by the auto-recovery step', () => {
    const out = reconcileQueue(
      input({
        intents: [intent({ id: 'A', createdAt: 1 })],
        meta: { A: meta('A', { failureCount: 1, backoffUntil: NOW + 5_000 }) },
      }),
    )
    expect(out.actions).toHaveLength(0)
    expect(decisionFor(out, 'A')).toMatchObject({ reason: 'blocked_backoff' })
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

// The concurrency gate is the one rule whose SCOPE depends on the workspace:
// `current-branch` shares one checkout (global mutex), `worktree` gives every
// intent its own directory (no cross-intent block). Each case below asserts the
// SAME facts under both modes, so the two can never drift apart silently.
describe('reconcileQueue — concurrency gate by git branch mode', () => {
  /** One live automated intent + one plain eligible candidate. */
  const twoIntents = {
    intents: [
      intent({ id: 'live', status: 'in_progress', lastWorkSessionId: 's1', createdAt: 1 }),
      intent({ id: 'other', createdAt: 5 }),
    ],
    runs: [{ sessionId: 's1', alive: true, awaitingPermissionSince: null }],
  }

  it('worktree: the live intent is attached to AND another eligible intent starts', () => {
    const out = reconcileQueue(input({ ...twoIntents, gitBranchMode: 'worktree' }))
    expect(out.actions).toContainEqual({
      kind: 'attach',
      intentId: 'live',
      sessionId: 's1',
      origin: 'queue-kernel',
    })
    expect(launched(out)).toBe('other')
    expect(decisionFor(out, 'live')).toMatchObject({ action: 'attach', reason: 'attached_running' })
    expect(decisionFor(out, 'other')).toMatchObject({ action: 'launch', reason: 'selected' })
    expect(out.state).toBe('developing')
    // The attached intent is never driven twice in the same pass.
    expect(out.actions.filter((a) => 'intentId' in a && a.intentId === 'live')).toHaveLength(1)
  })

  it('current-branch: the same facts still hold the gate shut for everyone else', () => {
    const out = reconcileQueue(input({ ...twoIntents, gitBranchMode: 'current-branch' }))
    expect(out.actions).toContainEqual({
      kind: 'attach',
      intentId: 'live',
      sessionId: 's1',
      origin: 'queue-kernel',
    })
    expect(launched(out)).toBeNull()
    expect(decisionFor(out, 'other')).toMatchObject({ reason: 'blocked_concurrency_gate' })
  })

  it('worktree: a live MANUAL session no longer blocks the queue', () => {
    const facts = {
      intents: [
        intent({ id: 'manual', automate: false, status: 'in_progress', lastWorkSessionId: 'm1' }),
        intent({ id: 'queued' }),
      ],
      runs: [{ sessionId: 'm1', alive: true, awaitingPermissionSince: null }],
    }
    const worktree = reconcileQueue(input({ ...facts, gitBranchMode: 'worktree' }))
    expect(launched(worktree)).toBe('queued')
    expect(worktree.state).toBe('developing')

    const inPlace = reconcileQueue(input({ ...facts, gitBranchMode: 'current-branch' }))
    expect(launched(inPlace)).toBeNull()
    expect(inPlace.state).toBe('awaiting_gate')
  })

  it('worktree: an intent the kernel drives is observed while another one starts', () => {
    const facts = {
      intents: [intent({ id: 'A', status: 'in_progress' }), intent({ id: 'B', createdAt: 5 })],
      inFlight: ['A'],
    }
    const worktree = reconcileQueue(input({ ...facts, gitBranchMode: 'worktree' }))
    expect(decisionFor(worktree, 'A')).toMatchObject({ action: 'wait', reason: 'running' })
    expect(launched(worktree)).toBe('B')
    // In-flight de-duplication is untouched: A is never launched a second time.
    expect(worktree.actions.some((a) => 'intentId' in a && a.intentId === 'A')).toBe(false)

    const inPlace = reconcileQueue(input({ ...facts, gitBranchMode: 'current-branch' }))
    expect(inPlace.actions).toHaveLength(0)
    expect(decisionFor(inPlace, 'B')).toMatchObject({ reason: 'blocked_concurrency_gate' })
  })

  it('worktree: an idle session of another intent is resumed, not re-launched', () => {
    const out = reconcileQueue(
      input({
        gitBranchMode: 'worktree',
        intents: [
          intent({ id: 'live', status: 'in_progress', lastWorkSessionId: 's1', createdAt: 1 }),
          intent({ id: 'idle', status: 'in_progress', lastWorkSessionId: 's2', createdAt: 5 }),
        ],
        runs: [
          { sessionId: 's1', alive: true, awaitingPermissionSince: null },
          { sessionId: 's2', alive: false, awaitingPermissionSince: null },
        ],
      }),
    )
    expect(out.actions).toContainEqual({
      kind: 'resume',
      intentId: 'idle',
      sessionId: 's2',
      origin: 'queue-kernel',
    })
    expect(decisionFor(out, 'live')).toMatchObject({ reason: 'attached_running' })
  })

  it('worktree: still at most ONE new work action per pass', () => {
    const out = reconcileQueue(
      input({
        gitBranchMode: 'worktree',
        intents: [
          intent({ id: 'live', status: 'in_progress', lastWorkSessionId: 's1', createdAt: 1 }),
          intent({ id: 'first', createdAt: 5 }),
          intent({ id: 'second', createdAt: 6 }),
        ],
        runs: [{ sessionId: 's1', alive: true, awaitingPermissionSince: null }],
      }),
    )
    expect(out.actions.filter((a) => a.kind === 'launch' || a.kind === 'resume')).toHaveLength(1)
    expect(launched(out)).toBe('first')
    // The runner-up waits for the next tick — parallelism grows one intent at a time.
    expect(decisionFor(out, 'second')).toMatchObject({
      action: 'wait',
      reason: 'blocked_concurrency_gate',
    })
  })

  it('worktree: the other hard gates keep their verdicts while a session is live', () => {
    const out = reconcileQueue(
      input({
        gitBranchMode: 'worktree',
        sddEnabled: true,
        intents: [
          intent({
            id: 'live',
            status: 'in_progress',
            lastWorkSessionId: 's1',
            specStatus: 'approved',
            createdAt: 1,
          }),
          intent({ id: 'unapproved', specStatus: 'raw', specPath: null, createdAt: 5 }),
          intent({ id: 'backing-off', specStatus: 'approved', createdAt: 6 }),
          intent({ id: 'parked-one', specStatus: 'approved', createdAt: 7 }),
        ],
        runs: [{ sessionId: 's1', alive: true, awaitingPermissionSince: null }],
        meta: {
          'backing-off': meta('backing-off', { failureCount: 1, backoffUntil: NOW + 5_000 }),
          'parked-one': meta('parked-one', { parked: true, parkReason: 'judge_stuck' }),
        },
      }),
    )
    expect(launched(out)).toBeNull()
    expect(decisionFor(out, 'unapproved')).toMatchObject({ reason: 'spec_authoring' })
    expect(decisionFor(out, 'backing-off')).toMatchObject({ reason: 'blocked_backoff' })
    // `parked-one` is a failure-ladder park with no dependency — the auto-recover
    // step (which sits ABOVE the ordinary park gate) clears it this pass.
    expect(decisionFor(out, 'parked-one')).toMatchObject({ action: 'unpark' })
  })

  it('worktree: a permission wait still parks and raises exactly one todo', () => {
    const out = reconcileQueue(
      input({
        gitBranchMode: 'worktree',
        intents: [
          intent({ id: 'waiting', status: 'in_progress', lastWorkSessionId: 's1', createdAt: 1 }),
          intent({ id: 'other', createdAt: 5 }),
        ],
        runs: [
          {
            sessionId: 's1',
            alive: true,
            awaitingPermissionSince: NOW - QUEUE_PERMISSION_WAIT_MS - 1,
          },
        ],
      }),
    )
    expect(out.actions.filter((a) => a.kind === 'wait_user_involve')).toHaveLength(1)
    expect(decisionFor(out, 'waiting')).toMatchObject({
      action: 'park',
      reason: 'permission_wait_timeout',
    })
    // The parked intent is not attached to, and its worktree neighbour still runs.
    expect(out.actions.some((a) => a.kind === 'attach')).toBe(false)
    expect(launched(out)).toBe('other')
    expect(out.awaitingPermission).toBe(true)
  })

  it('worktree: cap=2 — two intents in development block a third behind the cap', () => {
    const out = reconcileQueue(
      input({
        gitBranchMode: 'worktree',
        automationConcurrency: 2,
        intents: [
          intent({ id: 'A', status: 'in_progress', lastWorkSessionId: 's1', createdAt: 1 }),
          intent({ id: 'B', status: 'in_progress', lastWorkSessionId: 's2', createdAt: 2 }),
          intent({ id: 'C', createdAt: 3 }),
        ],
        runs: [
          { sessionId: 's1', alive: true, awaitingPermissionSince: null },
          { sessionId: 's2', alive: true, awaitingPermissionSince: null },
        ],
      }),
    )
    // A and B are observed (attached), never driven twice.
    expect(out.actions.filter((a) => a.kind === 'attach')).toHaveLength(2)
    expect(launched(out)).toBeNull()
    // C is eligible but the cap is full — blocked with the ACTUAL effective cap.
    expect(decisionFor(out, 'C')).toMatchObject({
      action: 'wait',
      reason: 'blocked_concurrency_gate',
      detail: '已达并发上限 2',
    })
    expect(out.state).toBe('developing')
  })

  it('worktree: cap=1 serializes even though each intent owns its own directory', () => {
    const out = reconcileQueue(
      input({
        gitBranchMode: 'worktree',
        automationConcurrency: 1,
        intents: [
          intent({ id: 'A', status: 'in_progress', lastWorkSessionId: 's1', createdAt: 1 }),
          intent({ id: 'B', createdAt: 2 }),
        ],
        runs: [{ sessionId: 's1', alive: true, awaitingPermissionSince: null }],
      }),
    )
    expect(launched(out)).toBeNull()
    expect(decisionFor(out, 'B')).toMatchObject({
      reason: 'blocked_concurrency_gate',
      detail: '已达并发上限 1',
    })
  })

  it('current-branch: a config above 1 is ignored — the shared checkout stays serial', () => {
    const out = reconcileQueue(
      input({
        gitBranchMode: 'current-branch',
        automationConcurrency: 5,
        intents: [
          intent({ id: 'A', status: 'in_progress', lastWorkSessionId: 's1', createdAt: 1 }),
          intent({ id: 'B', createdAt: 2 }),
        ],
        runs: [{ sessionId: 's1', alive: true, awaitingPermissionSince: null }],
      }),
    )
    expect(launched(out)).toBeNull()
    expect(decisionFor(out, 'B')).toMatchObject({
      reason: 'blocked_concurrency_gate',
      detail: '全局并发闸门:「intent-A」的工作会话仍在运行',
    })
  })

  it('worktree: the same intent in in-flight AND live facts counts once toward the cap', () => {
    const out = reconcileQueue(
      input({
        gitBranchMode: 'worktree',
        automationConcurrency: 1,
        intents: [
          intent({ id: 'A', status: 'in_progress', lastWorkSessionId: 's1', createdAt: 1 }),
          intent({ id: 'B', createdAt: 2 }),
        ],
        inFlight: ['A'],
        runs: [{ sessionId: 's1', alive: true, awaitingPermissionSince: null }],
      }),
    )
    expect(decisionFor(out, 'A')).toMatchObject({ action: 'wait', reason: 'running' })
    expect(launched(out)).toBeNull()
    expect(decisionFor(out, 'B')).toMatchObject({
      reason: 'blocked_concurrency_gate',
      detail: '已达并发上限 1',
    })
  })

  it('worktree: below the cap still adds exactly ONE new work action', () => {
    const out = reconcileQueue(
      input({
        gitBranchMode: 'worktree',
        automationConcurrency: 3,
        intents: [
          intent({ id: 'A', status: 'in_progress', lastWorkSessionId: 's1', createdAt: 1 }),
          intent({ id: 'first', createdAt: 2 }),
          intent({ id: 'second', createdAt: 3 }),
        ],
        runs: [{ sessionId: 's1', alive: true, awaitingPermissionSince: null }],
      }),
    )
    expect(out.actions.filter((a) => a.kind === 'launch' || a.kind === 'resume')).toHaveLength(1)
    expect(launched(out)).toBe('first')
    // The runner-up waits for the next tick — parallelism grows one intent at a time.
    expect(decisionFor(out, 'second')).toMatchObject({
      action: 'wait',
      reason: 'blocked_concurrency_gate',
    })
  })

  it('worktree: lowering the cap never cancels in-flight runs — it only stops new picks', () => {
    const out = reconcileQueue(
      input({
        gitBranchMode: 'worktree',
        automationConcurrency: 1,
        intents: [
          intent({ id: 'A', status: 'in_progress', lastWorkSessionId: 's1', createdAt: 1 }),
          intent({ id: 'B', status: 'in_progress', lastWorkSessionId: 's2', createdAt: 2 }),
          intent({ id: 'C', createdAt: 3 }),
        ],
        runs: [
          { sessionId: 's1', alive: true, awaitingPermissionSince: null },
          { sessionId: 's2', alive: true, awaitingPermissionSince: null },
        ],
      }),
    )
    // Both existing runs are still observed — no park/abort action touches them.
    expect(out.actions.filter((a) => a.kind === 'attach')).toHaveLength(2)
    expect(out.actions.some((a) => a.kind === 'park')).toBe(false)
    expect(launched(out)).toBeNull()
    expect(decisionFor(out, 'C')).toMatchObject({
      reason: 'blocked_concurrency_gate',
      detail: '已达并发上限 1',
    })
  })
})

// The queue page's "how far away am I" answer. A position is a DERIVED view of
// one pass's ordering: it exists only while the concurrency gate is the single
// remaining obstacle, it reuses the selection order rather than defining a
// second one, and the next pass recomputes it from scratch.
describe('reconcileQueue — queue position', () => {
  const positionOf = (out: ReturnType<typeof reconcileQueue>, id: string) =>
    decisionFor(out, id)?.queuePosition

  it('numbers the gate-blocked candidates 1..N in selection order', () => {
    const out = reconcileQueue(
      input({
        intents: [
          intent({ id: 'manual', automate: false, status: 'in_progress', lastWorkSessionId: 'm1' }),
          // Deliberately out of order in the snapshot: the numbers must come from
          // priority-then-oldest, not from the order the ledger listed them.
          intent({ id: 'p2-late', priority: 'P2', createdAt: 30 }),
          intent({ id: 'p0', priority: 'P0', createdAt: 20 }),
          intent({ id: 'p2-early', priority: 'P2', createdAt: 10 }),
          intent({ id: 'p1', priority: 'P1', createdAt: 40 }),
        ],
        runs: [{ sessionId: 'm1', alive: true, awaitingPermissionSince: null }],
      }),
    )
    expect(out.state).toBe('awaiting_gate')
    expect(positionOf(out, 'p0')).toBe(1)
    expect(positionOf(out, 'p1')).toBe(2)
    expect(positionOf(out, 'p2-early')).toBe(3)
    expect(positionOf(out, 'p2-late')).toBe(4)
    // The blocker is not an automation candidate, so it takes no place in line.
    expect(positionOf(out, 'manual')).toBeNull()
  })

  it('position 1 is the intent the next free slot goes to', () => {
    const gated = reconcileQueue(
      input({
        intents: [
          intent({ id: 'manual', automate: false, status: 'in_progress', lastWorkSessionId: 'm1' }),
          intent({ id: 'A', createdAt: 10 }),
          intent({ id: 'B', createdAt: 20 }),
        ],
        runs: [{ sessionId: 'm1', alive: true, awaitingPermissionSince: null }],
      }),
    )
    expect(positionOf(gated, 'A')).toBe(1)

    // Same facts, gate released → the pass picks exactly that intent, and the
    // runner-up moves up to 1 instead of keeping its old number.
    const released = reconcileQueue(
      input({
        intents: [
          intent({ id: 'manual', automate: false, status: 'in_progress', lastWorkSessionId: 'm1' }),
          intent({ id: 'A', createdAt: 10 }),
          intent({ id: 'B', createdAt: 20 }),
        ],
        runs: [{ sessionId: 'm1', alive: false, awaitingPermissionSince: null }],
      }),
    )
    expect(launched(released)).toBe('A')
    expect(positionOf(released, 'A')).toBeNull()
    expect(positionOf(released, 'B')).toBe(1)
  })

  it('only the concurrency gate is counted — every other verdict stays null', () => {
    const out = reconcileQueue(
      input({
        sddEnabled: true,
        control: { state: 'running', startedAt: NOW - 1000, forceSkipped: ['skipped'] },
        intents: [
          intent({ id: 'manual', automate: false, status: 'in_progress', lastWorkSessionId: 'm1' }),
          intent({ id: 'dep', specStatus: 'approved', createdAt: 1 }),
          intent({
            id: 'blocked-by-dep',
            specStatus: 'approved',
            dependsOn: ['dep'],
            createdAt: 2,
          }),
          intent({ id: 'no-spec', createdAt: 3, specPath: null }),
          intent({ id: 'backing-off', specStatus: 'approved', createdAt: 4 }),
          intent({ id: 'cooling', specStatus: 'approved', createdAt: 5 }),
          intent({ id: 'parked', specStatus: 'approved', createdAt: 6 }),
          intent({ id: 'skipped', specStatus: 'approved', createdAt: 7 }),
        ],
        meta: {
          'backing-off': meta('backing-off', { backoffUntil: NOW + 60_000, failureCount: 1 }),
          cooling: meta('cooling', { cooldownUntil: NOW + 1_000 }),
          parked: meta('parked', { parked: true, parkReason: 'max_attempts_reached' }),
        },
        runs: [{ sessionId: 'm1', alive: true, awaitingPermissionSince: null }],
      }),
    )
    // `dep` is the only fully eligible candidate left, so it alone is numbered.
    expect(positionOf(out, 'dep')).toBe(1)
    for (const id of ['blocked-by-dep', 'no-spec', 'backing-off', 'cooling', 'parked', 'skipped']) {
      expect({ id, position: positionOf(out, id) }).toEqual({ id, position: null })
    }
  })

  it('a spec-phase intent waiting for the serial spec slot is not in the work line', () => {
    const out = reconcileQueue(
      input({
        sddEnabled: true,
        intents: [
          intent({ id: 'manual', automate: false, status: 'in_progress', lastWorkSessionId: 'm1' }),
          intent({ id: 'spec-first', createdAt: 1 }),
          intent({ id: 'spec-second', createdAt: 2 }),
          intent({ id: 'ready', specStatus: 'approved', createdAt: 3 }),
        ],
        runs: [{ sessionId: 'm1', alive: true, awaitingPermissionSince: null }],
      }),
    )
    // `spec-second` reports `blocked_concurrency_gate` for the SPEC slot; that is
    // a different queue from the work line and must not consume a place in it.
    expect(decisionFor(out, 'spec-second')).toMatchObject({ reason: 'blocked_concurrency_gate' })
    expect(positionOf(out, 'spec-second')).toBeNull()
    expect(positionOf(out, 'spec-first')).toBeNull()
    expect(positionOf(out, 'ready')).toBe(1)
  })

  it('worktree: the intents deferred to the next tick are numbered too', () => {
    const out = reconcileQueue(
      input({
        gitBranchMode: 'worktree',
        intents: [
          intent({ id: 'A', createdAt: 10 }),
          intent({ id: 'B', createdAt: 20 }),
          intent({ id: 'C', createdAt: 30 }),
        ],
      }),
    )
    expect(launched(out)).toBe('A')
    expect(positionOf(out, 'A')).toBeNull()
    expect(positionOf(out, 'B')).toBe(1)
    expect(positionOf(out, 'C')).toBe(2)
  })

  it('a changed priority re-sorts the line on the very next pass', () => {
    const intents = (bPriority: QueueIntentFact['priority']) => [
      intent({ id: 'manual', automate: false, status: 'in_progress', lastWorkSessionId: 'm1' }),
      intent({ id: 'A', priority: 'P1', createdAt: 10 }),
      intent({ id: 'B', priority: bPriority, createdAt: 20 }),
    ]
    const runs = [{ sessionId: 'm1', alive: true, awaitingPermissionSince: null }]

    const first = reconcileQueue(input({ intents: intents('P2'), runs }))
    expect(positionOf(first, 'A')).toBe(1)
    expect(positionOf(first, 'B')).toBe(2)

    const second = reconcileQueue(input({ intents: intents('P0'), runs }))
    expect(positionOf(second, 'B')).toBe(1)
    expect(positionOf(second, 'A')).toBe(2)
  })

  it('a paused queue reports no positions at all', () => {
    const out = reconcileQueue(
      input({
        control: { state: 'paused', startedAt: NOW - 1000, forceSkipped: [] },
        intents: [intent({ id: 'A', createdAt: 10 }), intent({ id: 'B', createdAt: 20 })],
      }),
    )
    expect(out.decisions.every((d) => d.queuePosition === null)).toBe(true)
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
    // The half-finished intent is resumed; `was-parked` is a failure-ladder park
    // (`commit_failed`) with no dependency, so the kernel auto-recovers it from
    // persisted facts alone — no invented state beyond the recoverable park.
    expect(out.actions).toContainEqual({
      kind: 'resume',
      intentId: 'was-running',
      sessionId: 'dead',
      origin: 'queue-kernel',
    })
    expect(decisionFor(out, 'was-parked')).toMatchObject({ action: 'unpark' })
  })

  it('intents with no scheduling metadata read as zero failures, unparked, no backoff', () => {
    const out = reconcileQueue(input({ intents: [intent({ id: 'historic' })], meta: {} }))
    expect(launched(out)).toBe('historic')
    expect(decisionFor(out, 'historic')).toMatchObject({ attemptCount: 0, backoffCount: 0 })
  })
})

// ---------------------------------------------------------------------------
// Spec phase (SDD): author → review → rework → approve
// ---------------------------------------------------------------------------

describe('reconcileQueue — spec phase', () => {
  /**
   * An SDD workspace with one automate intent whose spec is AUTHORED but not
   * approved (`pending`) — the state the review / rework / approval steps all
   * start from. Cases about a spec that is still being written pass
   * `specStatus: 'raw'` explicitly.
   */
  function sdd(over: Partial<QueueIntentFact>, rest: Partial<QueueReconcileInput> = {}) {
    return reconcileQueue(
      input({
        sddEnabled: true,
        intents: [intent({ id: 'A', specStatus: 'pending', ...over })],
        ...rest,
      }),
    )
  }

  it('authors a spec when the intent has none', () => {
    const out = sdd({ specStatus: 'raw', specPath: null })
    expect(out.actions).toContainEqual({
      kind: 'launch_spec',
      intentId: 'A',
      origin: 'queue-kernel',
      rework: false,
      reworkRound: 0,
    })
    expect(decisionFor(out, 'A')).toMatchObject({ action: 'launch_spec', reason: 'spec_authoring' })
    // Authoring a spec is NOT developing it.
    expect(launched(out)).toBeNull()
  })

  it('never reviews or blocks a raw spec — even with a readable file and a leftover pass', () => {
    // The kernel decides on the persisted STATUS first, before any fingerprint or
    // stored conclusion. A `raw` intent may still carry review facts from an
    // earlier life (or a machine-approval opt-in): none of them may turn the seed
    // into a review target or an "awaiting approval" block. The only way forward
    // is to keep authoring.
    const out = sdd({
      specStatus: 'raw',
      specPath: '/s/spec.md',
      specFingerprint: 'fp1',
      specReviewVerdict: 'pass',
      specReviewFingerprint: 'fp1',
      specReviewReworkRounds: 0,
    })
    expect(out.actions).toContainEqual({
      kind: 'launch_spec',
      intentId: 'A',
      origin: 'queue-kernel',
      rework: false,
      reworkRound: 0,
    })
    expect(out.actions.some((a) => a.kind === 'launch_spec_review')).toBe(false)
    expect(out.actions.some((a) => a.kind === 'machine_approve_spec')).toBe(false)
    expect(decisionFor(out, 'A')).toMatchObject({ action: 'launch_spec', reason: 'spec_authoring' })
  })

  it('does not report a raw spec as awaiting approval when machine approval is off', () => {
    const out = sdd({ specStatus: 'raw', specPath: '/s/spec.md', specFingerprint: 'fp1' })
    const decision = decisionFor(out, 'A')
    expect(decision?.action).toBe('launch_spec')
    expect(decision?.reason).toBe('spec_authoring')
    expect(decision?.reason).not.toBe('spec_awaiting_approval')
  })

  it('reviews an authored spec that has no conclusion yet', () => {
    const out = sdd({ specPath: '/s/spec.md', specFingerprint: 'fp1' })
    expect(out.actions).toContainEqual({
      kind: 'launch_spec_review',
      intentId: 'A',
      origin: 'queue-kernel',
      fingerprint: 'fp1',
    })
    expect(decisionFor(out, 'A')).toMatchObject({ reason: 'spec_reviewing' })
  })

  it('re-reviews when the spec changed under an existing conclusion', () => {
    const out = sdd({
      specPath: '/s/spec.md',
      specFingerprint: 'fp2',
      specReviewVerdict: 'pass',
      specReviewFingerprint: 'fp1',
    })
    // A `pass` bound to content that no longer exists is not a pass.
    expect(out.actions).toContainEqual({
      kind: 'launch_spec_review',
      intentId: 'A',
      origin: 'queue-kernel',
      fingerprint: 'fp2',
    })
    expect(out.actions.some((a) => a.kind === 'machine_approve_spec')).toBe(false)
  })

  it('waits instead of re-launching while an authoring or review session is alive', () => {
    const authoring = sdd(
      { specPath: '/s/spec.md', specFingerprint: 'fp1', specSessionId: 'spec-1' },
      { specRuns: [{ sessionId: 'spec-1', alive: true }] },
    )
    expect(authoring.actions).toHaveLength(0)
    expect(decisionFor(authoring, 'A')).toMatchObject({ action: 'wait', reason: 'spec_authoring' })

    const reviewing = sdd(
      { specPath: '/s/spec.md', specFingerprint: 'fp1', specReviewSessionId: 'rev-1' },
      { specRuns: [{ sessionId: 'rev-1', alive: true }] },
    )
    expect(reviewing.actions).toHaveLength(0)
    expect(decisionFor(reviewing, 'A')).toMatchObject({
      action: 'wait',
      reason: 'spec_review_running',
    })
  })

  it('keeps a raw intent occupied across ticks while its pending launch has not bound', () => {
    // A spec-authoring session was launched (`spec_session_id` already holds the
    // pre-bind pending id) but `run:bound` has not written the real id yet. The
    // cooldown (5s) is shorter than the tick (10s), so the ONLY thing standing
    // between the queue and a duplicate launch is the occupancy itself: every
    // tick must wait, never produce a second `launch_spec`.
    const occupied = { specStatus: 'raw', specPath: null, specSessionId: 'pending:abc' } as const
    for (let tick = 0; tick < 3; tick++) {
      const out = sdd(occupied, {
        specRuns: [{ sessionId: 'pending:abc', alive: true }],
        now: NOW + tick * QUEUE_TICK_MS,
      })
      expect(out.actions.some((a) => a.kind === 'launch_spec')).toBe(false)
      expect(out.actions).toHaveLength(0)
      expect(decisionFor(out, 'A')).toMatchObject({ action: 'wait', reason: 'spec_authoring' })
    }
  })

  it('keeps a pending review occupied across ticks while its launch has not bound', () => {
    // The review twin: `spec_review_session_id` holds the pre-bind pending id, so
    // consecutive ticks wait instead of producing a second `launch_spec_review`.
    const occupied = {
      specPath: '/s/spec.md',
      specFingerprint: 'fp1',
      specReviewSessionId: 'pending:rev',
    } as const
    for (let tick = 0; tick < 3; tick++) {
      const out = sdd(occupied, {
        specRuns: [{ sessionId: 'pending:rev', alive: true }],
        now: NOW + tick * QUEUE_TICK_MS,
      })
      expect(out.actions.some((a) => a.kind === 'launch_spec_review')).toBe(false)
      expect(out.actions).toHaveLength(0)
      expect(decisionFor(out, 'A')).toMatchObject({ action: 'wait', reason: 'spec_review_running' })
    }
  })

  it('does not start a second spec run for an intent the kernel already drives', () => {
    const out = sdd({ specStatus: 'raw', specPath: null }, { specInFlight: ['A'] })
    expect(out.actions).toHaveLength(0)
    expect(decisionFor(out, 'A')).toMatchObject({ action: 'wait', reason: 'running' })
  })

  it('honours the per-intent cooldown so a tick and an event cannot double-launch', () => {
    const out = sdd(
      { specStatus: 'raw', specPath: null },
      { meta: { A: meta('A', { cooldownUntil: NOW + 3_000 }) } },
    )
    expect(out.actions).toHaveLength(0)
    expect(decisionFor(out, 'A')).toMatchObject({ reason: 'blocked_cooldown' })
    expect(out.nextWakeupAt).toBe(NOW + 3_000)
  })

  it('refuses to review an unreadable spec rather than treating it as empty', () => {
    const out = sdd({ specPath: '/s/spec.md', specFingerprint: null })
    expect(out.actions).toHaveLength(0)
    expect(decisionFor(out, 'A')).toMatchObject({ action: 'block', reason: 'spec_unreadable' })
  })

  it('keeps a RAW spec in authoring even with a path, a fingerprint and leftover review facts', () => {
    // write_spec seeded the document (path set, status raw). The queue must NOT
    // review the placeholder, must NOT block it as awaiting approval, and must
    // NOT machine-approve it — no matter that a readable file, a live fingerprint
    // and even an old valid-looking conclusion happen to be sitting there. Only a
    // persisted `pending` (content actually landed) opens those paths.
    const out = sdd({
      specStatus: 'raw',
      specPath: '/s/spec.md',
      specFingerprint: 'fp1',
      specReviewVerdict: 'pass',
      specReviewFingerprint: 'fp1',
      specReviewReworkRounds: 0,
    })
    expect(out.actions.some((a) => a.kind === 'launch_spec_review')).toBe(false)
    expect(out.actions.some((a) => a.kind === 'machine_approve_spec')).toBe(false)
    expect(out.actions).toContainEqual({
      kind: 'launch_spec',
      intentId: 'A',
      origin: 'queue-kernel',
      rework: false,
      reworkRound: 0,
    })
    expect(decisionFor(out, 'A')).toMatchObject({ action: 'launch_spec', reason: 'spec_authoring' })
    // And it is not "awaiting approval" either — the placeholder is still being written.
    expect(decisionFor(out, 'A')?.reason).not.toBe('spec_awaiting_approval')
  })

  it('only a PENDING spec can be reviewed — raw never reaches the conclusion check', () => {
    // Same facts, but the document was authored (`pending`): now the review
    // launches exactly as before the tri-state existed.
    const out = sdd(
      {
        specStatus: 'pending',
        specPath: '/s/spec.md',
        specFingerprint: 'fp1',
        specReviewVerdict: 'pass',
        specReviewFingerprint: 'fp1',
      },
      { machineApprovalEnabled: true },
    )
    expect(out.actions.some((a) => a.kind === 'launch_spec_review')).toBe(false)
    expect(out.actions).toContainEqual({
      kind: 'machine_approve_spec',
      intentId: 'A',
      fingerprint: 'fp1',
    })
  })

  it('reworks on changes_requested, carrying the round number', () => {
    const out = sdd({
      specPath: '/s/spec.md',
      specFingerprint: 'fp1',
      specReviewVerdict: 'changes_requested',
      specReviewFingerprint: 'fp1',
      specReviewReworkRounds: 2,
    })
    expect(out.actions).toContainEqual({
      kind: 'launch_spec',
      intentId: 'A',
      origin: 'queue-kernel',
      rework: true,
      reworkRound: 2,
    })
    expect(decisionFor(out, 'A')).toMatchObject({ reason: 'spec_rework' })
  })

  it('reworks on the LAST allowed round, then escalates to a human on the next failure', () => {
    const last = sdd({
      specPath: '/s/spec.md',
      specFingerprint: 'fp1',
      specReviewVerdict: 'changes_requested',
      specReviewFingerprint: 'fp1',
      specReviewReworkRounds: QUEUE_MAX_SPEC_REWORK,
    })
    expect(last.actions.some((a) => a.kind === 'launch_spec')).toBe(true)

    const exhausted = sdd({
      specPath: '/s/spec.md',
      specFingerprint: 'fp1',
      specReviewVerdict: 'changes_requested',
      specReviewFingerprint: 'fp1',
      specReviewReworkRounds: QUEUE_MAX_SPEC_REWORK + 1,
    })
    // No retry of any kind — neither a fresh authoring round nor another review;
    // a park plus exactly one human todo, and nothing else.
    expect(exhausted.actions.some((a) => a.kind === 'launch_spec')).toBe(false)
    expect(exhausted.actions.some((a) => a.kind === 'launch_spec_review')).toBe(false)
    expect(exhausted.actions.map((a) => a.kind).sort()).toEqual(['park', 'wait_user_involve'])
    expect(exhausted.actions).toContainEqual({
      kind: 'park',
      intentId: 'A',
      reason: 'spec_rework_exhausted',
      detail: expect.stringContaining(String(QUEUE_MAX_SPEC_REWORK)),
    })
    expect(exhausted.actions.filter((a) => a.kind === 'wait_user_involve')).toHaveLength(1)
    expect(decisionFor(exhausted, 'A')).toMatchObject({
      action: 'park',
      reason: 'spec_rework_exhausted',
    })
  })

  it('with machine approval OFF, a pass stops at the human checkpoint', () => {
    const out = sdd({
      specPath: '/s/spec.md',
      specFingerprint: 'fp1',
      specReviewVerdict: 'pass',
      specReviewFingerprint: 'fp1',
    })
    expect(out.actions).toHaveLength(0)
    expect(decisionFor(out, 'A')).toMatchObject({
      action: 'block',
      reason: 'spec_awaiting_approval',
    })
    expect(launched(out)).toBeNull()
  })

  it('with machine approval ON, a pass produces the approval action', () => {
    const out = sdd(
      {
        specPath: '/s/spec.md',
        specFingerprint: 'fp1',
        specReviewVerdict: 'pass',
        specReviewFingerprint: 'fp1',
      },
      { machineApprovalEnabled: true },
    )
    expect(out.actions).toContainEqual({
      kind: 'machine_approve_spec',
      intentId: 'A',
      fingerprint: 'fp1',
    })
    expect(decisionFor(out, 'A')).toMatchObject({
      action: 'approve_spec',
      reason: 'spec_machine_approved',
    })
  })

  it('never re-approves a conclusion a human revoked, even with the opt-in ON', () => {
    const out = sdd(
      {
        specPath: '/s/spec.md',
        specFingerprint: 'fp1',
        specReviewVerdict: 'pass',
        specReviewFingerprint: 'fp1',
        specReviewMachineApprovalBlocked: true,
      },
      { machineApprovalEnabled: true },
    )
    expect(out.actions.some((a) => a.kind === 'machine_approve_spec')).toBe(false)
    expect(decisionFor(out, 'A')).toMatchObject({ reason: 'spec_awaiting_approval' })
  })

  it('starts at most ONE spec session per pass; plain writes are not serialized', () => {
    const out = reconcileQueue(
      input({
        sddEnabled: true,
        machineApprovalEnabled: true,
        intents: [
          intent({ id: 'first', priority: 'P0', specStatus: 'raw', specPath: null }),
          intent({ id: 'second', priority: 'P1', specStatus: 'raw', specPath: null }),
          intent({
            id: 'passer',
            priority: 'P3',
            specStatus: 'pending',
            specPath: '/s/spec.md',
            specFingerprint: 'fp1',
            specReviewVerdict: 'pass',
            specReviewFingerprint: 'fp1',
          }),
        ],
      }),
    )
    const launches = out.actions.filter(
      (a) => a.kind === 'launch_spec' || a.kind === 'launch_spec_review',
    )
    expect(launches).toHaveLength(1)
    expect(launches[0]).toMatchObject({ intentId: 'first' })
    expect(decisionFor(out, 'second')).toMatchObject({
      action: 'wait',
      reason: 'blocked_concurrency_gate',
    })
    // The approval is a DB write, not an agent run, so it is not held back.
    expect(out.actions).toContainEqual({
      kind: 'machine_approve_spec',
      intentId: 'passer',
      fingerprint: 'fp1',
    })
  })

  it('does not disturb the existing work launch / resume / attach verbs', () => {
    const out = reconcileQueue(
      input({
        sddEnabled: true,
        machineApprovalEnabled: true,
        intents: [
          // Approved and half-done → the ordinary resume path, untouched.
          intent({
            id: 'approved',
            priority: 'P0',
            specStatus: 'approved',
            status: 'in_progress',
            lastWorkSessionId: 'w1',
          }),
          intent({ id: 'needs-spec', priority: 'P1', specStatus: 'raw', specPath: null }),
        ],
        runs: [{ sessionId: 'w1', alive: false, awaitingPermissionSince: null }],
      }),
    )
    expect(out.actions).toContainEqual({
      kind: 'resume',
      intentId: 'approved',
      sessionId: 'w1',
      origin: 'queue-kernel',
    })
    // The spec phase runs alongside, on a DIFFERENT intent, without contending
    // for the work queue's single slot.
    expect(out.actions).toContainEqual({
      kind: 'launch_spec',
      intentId: 'needs-spec',
      origin: 'queue-kernel',
      rework: false,
      reworkRound: 0,
    })
  })

  it('a parked or force-skipped intent never enters the spec phase', () => {
    const parked = sdd(
      { specStatus: 'raw', specPath: null },
      { meta: { A: meta('A', { parked: true }) } },
    )
    expect(parked.actions).toHaveLength(0)
    expect(decisionFor(parked, 'A')).toMatchObject({ reason: 'blocked_parked' })

    const skipped = sdd(
      { specStatus: 'raw', specPath: null },
      { control: { state: 'running', startedAt: NOW - 1000, forceSkipped: ['A'] } },
    )
    expect(skipped.actions).toHaveLength(0)
    expect(decisionFor(skipped, 'A')).toMatchObject({ reason: 'blocked_force_skipped' })
  })

  it('a paused queue starts no spec session either', () => {
    const out = sdd(
      { specStatus: 'raw', specPath: null },
      { control: { state: 'paused', startedAt: NOW - 1000, forceSkipped: [] } },
    )
    expect(out.actions).toHaveLength(0)
    expect(decisionFor(out, 'A')).toMatchObject({ reason: 'queue_paused' })
  })
})
