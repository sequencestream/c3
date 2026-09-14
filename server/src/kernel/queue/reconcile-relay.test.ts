/**
 * Queue scheduling kernel — the PR review / fix relay, as pure snapshots.
 *
 * Every case is a fixed world plus a fixed clock asserted against the exact
 * actions and decisions the pass must produce. The closed loop is walked round by
 * round with the counter asserted at each step, because the ONE thing these rules
 * must never get wrong is spending — or refunding — a fix round.
 */
import { describe, expect, it } from 'vitest'
import { reconcileQueue, relayEngaged } from './reconcile.js'
import {
  AUTO_RECOVERABLE_PARK_REASONS,
  QUEUE_COOLDOWN_MS,
  QUEUE_MAX_REVIEW_FIX,
  emptyQueueIntentMeta,
  type QueueAction,
  type QueueIntentFact,
  type QueueIntentMeta,
  type QueueReconcileInput,
  type QueueReconcileOutput,
} from './types.js'

const NOW = 1_700_000_000_000

/** A `reviewing` intent with one live PR — the relay's starting world. */
function relayIntent(over: Partial<QueueIntentFact> & { id: string }): QueueIntentFact {
  return {
    title: `intent-${over.id}`,
    status: 'reviewing',
    priority: 'P2',
    automate: true,
    dependsOn: [],
    specStatus: 'approved',
    effectiveSpecMode: 'sdd',
    impactLevel: 'L3',
    specApproveUser: 'alice',
    prStatus: 'reviewing',
    branchName: 'intent/x',
    deliveryIds: [],
    prStatusByDelivery: {},
    lastWorkSessionId: 'work-1',
    createdAt: 1,
    specPath: 'spec.md',
    specSessionId: null,
    specReviewSessionId: null,
    specFingerprint: null,
    specReviewVerdict: null,
    specReviewFingerprint: null,
    specReviewReworkRounds: 0,
    specReviewMachineApprovalBlocked: false,
    hasActivePr: true,
    reviewSessionId: null,
    reviewStatus: null,
    reviewFixRounds: 0,
    fixSessionId: null,
    fixStatus: null,
    mergeAuthorized: false,
    mergeRecovery: false,
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
    gitBranchMode: 'worktree',
    defaultMainBranch: 'main',
    deliveries: [],
    sddEnabled: true,
    machineApprovalEnabled: false,
    automationConcurrency: 2,
    specRuns: [],
    specInFlight: [],
    relayRuns: [],
    relayInFlight: [],
    ...over,
  }
}

/** The relay action this pass produced for `id`, or null. */
function relayAction(
  out: QueueReconcileOutput,
  id: string,
): Extract<QueueAction, { kind: 'launch_review' | 'launch_fix' }> | null {
  const a = out.actions.find(
    (x) => (x.kind === 'launch_review' || x.kind === 'launch_fix') && x.intentId === id,
  )
  return (a as Extract<QueueAction, { kind: 'launch_review' | 'launch_fix' }>) ?? null
}

function decisionFor(out: QueueReconcileOutput, id: string) {
  return out.decisions.find((d) => d.intentId === id)
}

/** The merge action this pass produced for `id`, or null. */
function mergeAction(out: QueueReconcileOutput, id: string) {
  return (out.actions.find((a) => a.kind === 'merge_prs' && a.intentId === id) ?? null) as Extract<
    QueueAction,
    { kind: 'merge_prs' }
  > | null
}

// ---------------------------------------------------------------------------
// Candidate admission
// ---------------------------------------------------------------------------

describe('relay candidates', () => {
  it('L1–L4 and an ungraded intent all need a first review; L5 does not', () => {
    for (const level of ['L1', 'L2', 'L3', 'L4', null] as const) {
      const out = reconcileQueue(input({ intents: [relayIntent({ id: 'r', impactLevel: level })] }))
      expect(relayAction(out, 'r')?.kind, `impact ${level}`).toBe('launch_review')
    }
    const skipped = reconcileQueue(
      input({ intents: [relayIntent({ id: 'r', impactLevel: 'L5' })] }),
    )
    expect(relayAction(skipped, 'r')).toBeNull()
    expect(skipped.actions).toHaveLength(0)
    expect(skipped.state).toBe('done')
  })

  it('an L5 intent that already has a rejection still finishes its fix loop', () => {
    const out = reconcileQueue(
      input({
        intents: [
          relayIntent({
            id: 'r',
            impactLevel: 'L5',
            reviewStatus: 'rejected',
            reviewSessionId: 's',
          }),
        ],
      }),
    )
    expect(relayAction(out, 'r')).toEqual({
      kind: 'launch_fix',
      intentId: 'r',
      origin: 'queue-kernel',
      round: 1,
    })
  })

  it('never engages without reviewing + automate + a live PR', () => {
    const worlds: Array<[string, Partial<QueueIntentFact>]> = [
      ['work still in progress', { status: 'in_progress' }],
      ['work not started', { status: 'todo' }],
      ['already done (converged)', { status: 'done' }],
      ['cancelled', { status: 'cancelled' }],
      ['not automated', { automate: false }],
      ['every PR merged or closed', { hasActivePr: false }],
    ]
    for (const [name, over] of worlds) {
      const out = reconcileQueue(input({ intents: [relayIntent({ id: 'r', ...over })] }))
      expect(relayAction(out, 'r'), name).toBeNull()
    }
  })

  it('leaves the candidate set once the review is approved, so the queue completes', () => {
    const out = reconcileQueue(
      input({
        intents: [relayIntent({ id: 'r', reviewStatus: 'approved', reviewSessionId: 'rev-1' })],
      }),
    )
    expect(out.actions).toHaveLength(0)
    expect(decisionFor(out, 'r')).toBeUndefined()
    expect(out.state).toBe('done')
  })

  it('a merged PR is never reviewed retroactively, whatever the stored conclusion', () => {
    const out = reconcileQueue(
      input({
        intents: [
          relayIntent({
            id: 'r',
            hasActivePr: false,
            prStatus: 'merged',
            reviewStatus: 'rejected',
            reviewSessionId: 'rev-1',
          }),
        ],
      }),
    )
    expect(out.actions).toHaveLength(0)
    expect(out.state).toBe('done')
  })

  it('does not engage at all under a shared checkout', () => {
    const out = reconcileQueue(
      input({ gitBranchMode: 'current-branch', intents: [relayIntent({ id: 'r' })] }),
    )
    expect(out.actions).toHaveLength(0)
    expect(out.state).toBe('done')
    expect(
      relayEngaged({
        worktreeMode: false,
        automate: true,
        status: 'reviewing',
        hasActivePr: true,
        reviewStatus: null,
        impactLevel: 'L2',
        mergeAuthorized: false,
        mergeRecovery: false,
      }),
    ).toBe(false)
  })

  it('the predicate the read models share agrees with the scheduler', () => {
    const engaged = relayEngaged({
      worktreeMode: true,
      automate: true,
      status: 'reviewing',
      hasActivePr: true,
      reviewStatus: null,
      impactLevel: 'L2',
      mergeAuthorized: false,
      mergeRecovery: false,
    })
    expect(engaged).toBe(true)
    expect(
      relayEngaged({
        worktreeMode: true,
        automate: true,
        status: 'reviewing',
        hasActivePr: true,
        reviewStatus: 'approved',
        impactLevel: 'L2',
        mergeAuthorized: false,
        mergeRecovery: false,
      }),
    ).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// The closed loop
// ---------------------------------------------------------------------------

describe('review → fix → re-review closed loop', () => {
  it('the first review spends no fix budget', () => {
    const out = reconcileQueue(input({ intents: [relayIntent({ id: 'r' })] }))
    expect(relayAction(out, 'r')).toEqual({
      kind: 'launch_review',
      intentId: 'r',
      origin: 'queue-kernel',
      round: 0,
    })
    expect(decisionFor(out, 'r')?.action).toBe('launch_review')
    expect(decisionFor(out, 'r')?.reason).toBe('pr_reviewing')
  })

  it('claims rounds 1, 2, 3 across three rejections and re-reviews each fix', () => {
    for (const spent of [0, 1, 2]) {
      const rejected = reconcileQueue(
        input({
          intents: [
            relayIntent({
              id: 'r',
              reviewStatus: 'rejected',
              reviewSessionId: 'rev',
              reviewFixRounds: spent,
            }),
          ],
        }),
      )
      expect(relayAction(rejected, 'r'), `rejection ${spent + 1}`).toEqual({
        kind: 'launch_fix',
        intentId: 'r',
        origin: 'queue-kernel',
        round: spent + 1,
      })

      // The fix concluded → the SAME round is re-reviewed, counter unchanged.
      const reReview = reconcileQueue(
        input({
          intents: [
            relayIntent({
              id: 'r',
              reviewStatus: 'rejected',
              reviewSessionId: 'rev',
              reviewFixRounds: spent + 1,
              fixSessionId: 'fix',
              fixStatus: 'fixed',
            }),
          ],
        }),
      )
      expect(relayAction(reReview, 'r'), `re-review ${spent + 1}`).toEqual({
        kind: 'launch_review',
        intentId: 'r',
        origin: 'queue-kernel',
        round: spent + 1,
      })
    }
  })

  it('the third fix still earns its re-review — the budget is not spent early', () => {
    const out = reconcileQueue(
      input({
        intents: [
          relayIntent({
            id: 'r',
            reviewStatus: 'rejected',
            reviewSessionId: 'rev',
            reviewFixRounds: QUEUE_MAX_REVIEW_FIX,
            fixSessionId: 'fix',
            fixStatus: 'fixed',
          }),
        ],
      }),
    )
    expect(relayAction(out, 'r')?.kind).toBe('launch_review')
    expect(out.actions.some((a) => a.kind === 'park')).toBe(false)
  })

  it('parks only when the review after the last fix is rejected again', () => {
    const out = reconcileQueue(
      input({
        intents: [
          relayIntent({
            id: 'r',
            reviewStatus: 'rejected',
            reviewSessionId: 'rev',
            reviewFixRounds: QUEUE_MAX_REVIEW_FIX,
          }),
        ],
      }),
    )
    expect(relayAction(out, 'r')).toBeNull()
    expect(out.actions).toEqual([
      {
        kind: 'park',
        intentId: 'r',
        reason: 'review_fix_exhausted',
        detail: expect.stringContaining(String(QUEUE_MAX_REVIEW_FIX)),
      },
      {
        kind: 'wait_user_involve',
        intentId: 'r',
        reason: 'review_fix_exhausted',
        detail: expect.stringContaining(String(QUEUE_MAX_REVIEW_FIX)),
      },
    ])
    expect(decisionFor(out, 'r')?.action).toBe('park')
  })

  it('an approval at any round ends the relay instead of parking', () => {
    const out = reconcileQueue(
      input({
        intents: [
          relayIntent({
            id: 'r',
            reviewStatus: 'approved',
            reviewSessionId: 'rev',
            reviewFixRounds: QUEUE_MAX_REVIEW_FIX,
          }),
        ],
      }),
    )
    expect(out.actions).toHaveLength(0)
  })

  it('`review_fix_exhausted` is not auto-recoverable', () => {
    expect(AUTO_RECOVERABLE_PARK_REASONS.has('review_fix_exhausted')).toBe(false)
  })

  it('a park for a spent budget survives a satisfied-dependency pass', () => {
    const out = reconcileQueue(
      input({
        intents: [
          relayIntent({
            id: 'r',
            reviewStatus: 'rejected',
            reviewSessionId: 'rev',
            reviewFixRounds: QUEUE_MAX_REVIEW_FIX,
          }),
        ],
        meta: {
          r: meta('r', {
            parked: true,
            parkReason: 'review_fix_exhausted',
            parkDetail: '不收敛',
          }),
        },
      }),
    )
    expect(out.actions).toHaveLength(0)
    expect(decisionFor(out, 'r')?.reason).toBe('blocked_parked')
  })
})

// ---------------------------------------------------------------------------
// Liveness, recovery and self-excitation
// ---------------------------------------------------------------------------

describe('relay liveness and recovery', () => {
  it('waits while the review session is alive, even after a result landed', () => {
    const out = reconcileQueue(
      input({
        intents: [
          relayIntent({
            id: 'r',
            reviewStatus: 'rejected',
            reviewSessionId: 'rev-1',
          }),
        ],
        relayRuns: [{ sessionId: 'rev-1', alive: true }],
      }),
    )
    expect(out.actions).toHaveLength(0)
    expect(decisionFor(out, 'r')?.reason).toBe('pr_review_waiting')
  })

  it('waits while the fix session is alive', () => {
    const out = reconcileQueue(
      input({
        intents: [
          relayIntent({
            id: 'r',
            reviewStatus: 'rejected',
            reviewSessionId: 'rev-1',
            reviewFixRounds: 1,
            fixSessionId: 'fix-1',
            fixStatus: 'fixed',
          }),
        ],
        relayRuns: [{ sessionId: 'fix-1', alive: true }],
      }),
    )
    expect(out.actions).toHaveLength(0)
    expect(decisionFor(out, 'r')?.reason).toBe('pr_review_waiting')
  })

  it('recovers a pending review whose session died, without touching the round', () => {
    const out = reconcileQueue(
      input({
        intents: [
          relayIntent({
            id: 'r',
            reviewStatus: 'pending',
            reviewSessionId: 'rev-1',
            reviewFixRounds: 2,
          }),
        ],
        relayRuns: [{ sessionId: 'rev-1', alive: false }],
      }),
    )
    expect(relayAction(out, 'r')).toEqual({
      kind: 'launch_review',
      intentId: 'r',
      origin: 'queue-kernel',
      round: 2,
    })
  })

  it('recovers a pending fix whose session died, re-entering the SAME round', () => {
    const out = reconcileQueue(
      input({
        intents: [
          relayIntent({
            id: 'r',
            reviewStatus: 'rejected',
            reviewSessionId: 'rev-1',
            reviewFixRounds: 2,
            fixSessionId: 'fix-1',
            fixStatus: 'pending',
          }),
        ],
      }),
    )
    expect(relayAction(out, 'r')).toEqual({
      kind: 'launch_fix',
      intentId: 'r',
      origin: 'queue-kernel',
      round: 2,
    })
  })

  it('never re-launches a phase the kernel already holds a run for', () => {
    const out = reconcileQueue(input({ intents: [relayIntent({ id: 'r' })], relayInFlight: ['r'] }))
    expect(out.actions).toHaveLength(0)
    expect(decisionFor(out, 'r')?.reason).toBe('running')
    expect(out.state).toBe('developing')
  })

  it('honours the shared per-intent cooldown', () => {
    const out = reconcileQueue(
      input({
        intents: [relayIntent({ id: 'r' })],
        meta: { r: meta('r', { cooldownUntil: NOW + QUEUE_COOLDOWN_MS }) },
      }),
    )
    expect(out.actions).toHaveLength(0)
    expect(decisionFor(out, 'r')?.reason).toBe('blocked_cooldown')
  })

  it('is idempotent: the same snapshot twice yields the same actions', () => {
    const snapshot = input({
      intents: [relayIntent({ id: 'r', reviewStatus: 'rejected', reviewSessionId: 'rev' })],
    })
    expect(reconcileQueue(snapshot).actions).toEqual(reconcileQueue(snapshot).actions)
  })
})

// ---------------------------------------------------------------------------
// Gates and concurrency
// ---------------------------------------------------------------------------

describe('the relay obeys the same gates development does', () => {
  it('an ambiguous delivery context blocks the relay instead of picking a PR', () => {
    const out = reconcileQueue(
      input({ intents: [relayIntent({ id: 'r', deliveryIds: ['d1', 'd2'] })] }),
    )
    expect(out.actions).toHaveLength(0)
    expect(decisionFor(out, 'r')?.reason).toBe('blocked_delivery_ambiguous')
  })

  it('a paused queue starts nothing but still lists the relay intent', () => {
    const out = reconcileQueue(
      input({
        control: { state: 'paused', startedAt: NOW - 1, forceSkipped: [] },
        intents: [relayIntent({ id: 'r' })],
      }),
    )
    expect(out.actions).toHaveLength(0)
    expect(decisionFor(out, 'r')?.reason).toBe('queue_paused')
  })

  it('an idle queue produces nothing at all', () => {
    const out = reconcileQueue(
      input({
        control: { state: 'idle', startedAt: null, forceSkipped: [] },
        intents: [relayIntent({ id: 'r' })],
      }),
    )
    expect(out.actions).toHaveLength(0)
    expect(out.decisions).toHaveLength(0)
  })

  it('starts at most one relay session per pass', () => {
    const out = reconcileQueue(
      input({
        automationConcurrency: 4,
        intents: [relayIntent({ id: 'a', createdAt: 1 }), relayIntent({ id: 'b', createdAt: 2 })],
      }),
    )
    expect(out.actions.filter((a) => a.kind === 'launch_review')).toHaveLength(1)
    expect(relayAction(out, 'a')?.kind).toBe('launch_review')
    expect(decisionFor(out, 'b')?.reason).toBe('blocked_concurrency_gate')
  })

  it('takes a concurrency slot: at the cap nothing new starts', () => {
    const out = reconcileQueue(
      input({
        automationConcurrency: 1,
        intents: [relayIntent({ id: 'relaying' }), relayIntent({ id: 'waiting', createdAt: 5 })],
        relayInFlight: ['relaying'],
      }),
    )
    expect(out.actions).toHaveLength(0)
    expect(decisionFor(out, 'waiting')?.reason).toBe('blocked_concurrency_gate')
  })

  it('a relay session holds a slot against DEVELOPMENT too', () => {
    const dev = relayIntent({
      id: 'dev',
      status: 'todo',
      hasActivePr: false,
      prStatus: null,
      lastWorkSessionId: null,
      createdAt: 9,
    })
    const out = reconcileQueue(
      input({
        automationConcurrency: 1,
        intents: [relayIntent({ id: 'r', createdAt: 1 }), dev],
      }),
    )
    expect(relayAction(out, 'r')?.kind).toBe('launch_review')
    expect(out.actions.some((a) => a.kind === 'launch')).toBe(false)
    expect(decisionFor(out, 'dev')?.reason).toBe('blocked_concurrency_gate')
  })

  it('with spare capacity a relay phase and a development launch coexist', () => {
    const dev = relayIntent({
      id: 'dev',
      status: 'todo',
      hasActivePr: false,
      prStatus: null,
      lastWorkSessionId: null,
      createdAt: 9,
    })
    const out = reconcileQueue(
      input({
        automationConcurrency: 3,
        intents: [relayIntent({ id: 'r', createdAt: 1 }), dev],
      }),
    )
    expect(relayAction(out, 'r')?.kind).toBe('launch_review')
    expect(out.actions.some((a) => a.kind === 'launch')).toBe(true)
  })

  it('a relay intent is never picked up as a development launch or resume', () => {
    const out = reconcileQueue(
      input({ automationConcurrency: 3, intents: [relayIntent({ id: 'r' })] }),
    )
    expect(out.actions.some((a) => a.kind === 'launch' || a.kind === 'resume')).toBe(false)
  })

  it('reports the relay session as the queue’s current session, not the work session', () => {
    const out = reconcileQueue(
      input({
        intents: [relayIntent({ id: 'r', reviewStatus: 'pending', reviewSessionId: 'rev-1' })],
      }),
    )
    expect(out.currentIntentId).toBe('r')
    expect(out.currentSessionId).toBe('rev-1')
  })
})

// ---------------------------------------------------------------------------
// Post-review auto-merge trigger
// ---------------------------------------------------------------------------

describe('the auto-merge trigger', () => {
  it('a valid credential turns an approved review into a merge action', () => {
    const out = reconcileQueue(
      input({
        intents: [
          relayIntent({
            id: 'r',
            reviewStatus: 'approved',
            reviewSessionId: 'rev-1',
            mergeAuthorized: true,
          }),
        ],
      }),
    )
    expect(mergeAction(out, 'r')).toEqual({
      kind: 'merge_prs',
      intentId: 'r',
      origin: 'queue-kernel',
      recover: false,
    })
    expect(decisionFor(out, 'r')?.reason).toBe('pr_merging')
  })

  it('a persisted in-flight attempt recovers read-only, never re-sends', () => {
    const out = reconcileQueue(
      input({
        intents: [
          relayIntent({
            id: 'r',
            reviewStatus: 'approved',
            reviewSessionId: 'rev-1',
            mergeRecovery: true,
          }),
        ],
      }),
    )
    expect(mergeAction(out, 'r')).toEqual({
      kind: 'merge_prs',
      intentId: 'r',
      origin: 'queue-kernel',
      recover: true,
    })
  })

  it('recovery wins over a still-present credential, so the attempt is never repeated', () => {
    const out = reconcileQueue(
      input({
        intents: [
          relayIntent({
            id: 'r',
            reviewStatus: 'approved',
            reviewSessionId: 'rev-1',
            mergeAuthorized: true,
            mergeRecovery: true,
          }),
        ],
      }),
    )
    expect(mergeAction(out, 'r')?.recover).toBe(true)
  })

  it('an approved review with NO credential stays out of the candidate set', () => {
    const out = reconcileQueue(
      input({
        intents: [
          relayIntent({
            id: 'r',
            reviewStatus: 'approved',
            reviewSessionId: 'rev-1',
            mergeAuthorized: false,
            mergeRecovery: false,
          }),
        ],
      }),
    )
    expect(mergeAction(out, 'r')).toBeNull()
    expect(out.actions).toHaveLength(0)
  })

  it('a merge holds a concurrency slot exactly as review and fix do', () => {
    const out = reconcileQueue(
      input({
        automationConcurrency: 1,
        intents: [
          relayIntent({
            id: 'merging',
            reviewStatus: 'approved',
            reviewSessionId: 'rev-1',
            mergeAuthorized: true,
          }),
          relayIntent({
            id: 'waiting',
            createdAt: 5,
            reviewStatus: 'approved',
            reviewSessionId: 'rev-2',
            mergeAuthorized: true,
          }),
        ],
        relayInFlight: ['merging'],
      }),
    )
    expect(out.actions).toHaveLength(0)
    expect(decisionFor(out, 'waiting')?.reason).toBe('blocked_concurrency_gate')
  })
})
