/**
 * The merge credential: who is allowed to let c3 land a PR by itself.
 *
 * Two halves under test. The pure reductions (`mergeDenial`, `mergeAuthorized`,
 * `mergeRecoveryPending`, `orderedActivePrs`) must agree with every other reader
 * of the credential, so a human backfill, a stale grant and a pushed-over PR all
 * read the same way everywhere. The writes (`recordQueueReviewClaim`,
 * `bindQueueReviewClaimSession`, `issueMergeGrant`, `invalidateMergeGrant`,
 * `sweepMergeGrants`) must never confer authority on a caller that merely names a
 * session id, and must drop it the moment the facts it was built on change.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Intent, IntentPr } from '@ccc/shared/protocol'
import { resetDbForTests } from '../../kernel/infra/db.js'
import {
  emptyQueueIntentMeta,
  type QueueIntentMeta,
  type QueueMergeGrant,
  type QueuePrIdentity,
} from '../../kernel/queue/index.js'
import {
  bindQueueReviewClaimSession,
  invalidateMergeGrant,
  issueMergeGrant,
  mergeAuthorized,
  mergeDenial,
  mergeRecoveryPending,
  orderedActivePrs,
  prIdentityOf,
  recordQueueReviewClaim,
  sweepMergeGrants,
} from './merge-authority.js'
import {
  getQueueIntentMetaById,
  putQueueIntentMeta,
  resetQueueStoreForTests,
} from './queue-store.js'

const proj = '/abs/merge-authority-proj'
let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'c3-merge-auth-'))
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

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function pr(over: Omit<Partial<IntentPr>, 'number'> & { number: string }): IntentPr {
  return {
    id: `pr-${over.number}`,
    intentId: 'A',
    deliveryId: null,
    forge: 'github',
    repo: 'acme/app',
    url: null,
    status: 'reviewing',
    headBranch: 'intent/a',
    baseBranch: 'main',
    createdAt: 1,
    updatedAt: 1,
    ...over,
  }
}

/** A minimal intent; only the fields the credential reads are ever accessed. */
function intent(over: Omit<Partial<Intent>, 'id'> & { id: string }): Intent {
  return {
    title: `intent-${over.id}`,
    content: 'c',
    priority: 'P2',
    status: 'reviewing',
    automate: true,
    reviewStatus: 'approved',
    reviewSessionId: 'rev-1',
    prs: [],
    ...over,
  } as Intent
}

const pinned = (): QueuePrIdentity => ({
  forge: 'github',
  repo: 'acme/app',
  number: '42',
  headBranch: 'intent/a',
  baseBranch: 'main',
  headSha: 'abc1234',
})

function grant(over: Partial<QueueMergeGrant> = {}): QueueMergeGrant {
  return { reviewSessionId: 'rev-1', prs: [pinned()], grantedAt: 1000, ...over }
}

function metaWith(intentId: string, over: Partial<QueueIntentMeta> = {}): QueueIntentMeta {
  return { ...emptyQueueIntentMeta(intentId), ...over }
}

// ---------------------------------------------------------------------------
// Pure reductions
// ---------------------------------------------------------------------------

describe('mergeDenial — the one rule every reader shares', () => {
  const authorized = () => metaWith('A', { mergeGrant: grant(), mergePhase: 'pending' })

  it('authorizes a grant that still matches the live intent', () => {
    const live = intent({ id: 'A', prs: [pr({ number: '42' })] })
    expect(mergeDenial(live, authorized())).toBeNull()
    expect(mergeAuthorized(live, authorized())).toBe(true)
  })

  it('denies each way the credential can stop holding', () => {
    const live = intent({ id: 'A', prs: [pr({ number: '42' })] })

    expect(mergeDenial(live, metaWith('A', { mergeGrant: null }))).toBe('no_grant')
    expect(mergeDenial(live, metaWith('A', { mergeGrant: grant(), mergePhase: 'completed' }))).toBe(
      'phase_consumed',
    )
    expect(
      mergeDenial(intent({ id: 'A', automate: false, prs: [pr({ number: '42' })] }), authorized()),
    ).toBe('automation_off')
    expect(
      mergeDenial(intent({ id: 'A', status: 'done', prs: [pr({ number: '42' })] }), authorized()),
    ).toBe('not_reviewing')
    expect(
      mergeDenial(
        intent({ id: 'A', reviewStatus: 'rejected', prs: [pr({ number: '42' })] }),
        authorized(),
      ),
    ).toBe('not_approved')
    expect(
      mergeDenial(
        intent({ id: 'A', reviewSessionId: 'rev-other', prs: [pr({ number: '42' })] }),
        authorized(),
      ),
    ).toBe('session_changed')
  })

  it('denies a PR set that changed after the approval', () => {
    const live = intent({ id: 'A', prs: [pr({ number: '43' })] })
    expect(mergeDenial(live, authorized())).toBe('pr_set_changed')

    const reTargeted = intent({ id: 'A', prs: [pr({ number: '42', baseBranch: 'release' })] })
    expect(mergeDenial(reTargeted, authorized())).toBe('pr_set_changed')
  })

  it('does not compare the head SHA against the ledger — that is re-read from the forge', () => {
    // The grant's pinned headSha is stale, but the local row cannot know about a
    // push; only the pre-merge forge read does. So this is still authorized here.
    const live = intent({ id: 'A', prs: [pr({ number: '42' })] })
    expect(
      mergeDenial(
        live,
        metaWith('A', { mergeGrant: grant({ prs: [pinned()] }), mergePhase: 'pending' }),
      ),
    ).toBeNull()
  })
})

describe('orderedActivePrs', () => {
  it('keeps only live PRs and orders them by identity, not insertion', () => {
    const live = intent({
      id: 'A',
      prs: [
        pr({ number: '9', forge: 'gitlab', repo: 'b/r' }),
        pr({ number: '2', status: 'merged' }),
        pr({ number: '7', forge: 'github', repo: 'a/r' }),
      ],
    })
    // 'github|a/r|7' < 'gitlab|b/r|9'; the merged PR is dropped.
    expect(orderedActivePrs(live).map((p) => p.number)).toEqual(['7', '9'])
  })
})

describe('mergeRecoveryPending', () => {
  it('flags a persisted in-flight attempt, whatever its shape', () => {
    expect(mergeRecoveryPending(metaWith('A', { mergePhase: 'running' }))).toBe(true)
    expect(mergeRecoveryPending(metaWith('A', { mergePhase: 'awaiting_sync' }))).toBe(true)
    expect(mergeRecoveryPending(metaWith('A', { mergePhase: 'pending' }))).toBe(false)
    expect(mergeRecoveryPending(metaWith('A', { mergePhase: 'handed_back' }))).toBe(false)
  })
})

describe('prIdentityOf', () => {
  it('pins a live PR row with the head commit the caller just read', () => {
    expect(prIdentityOf(pr({ number: '42' }), 'sha-1')).toEqual(
      pinned().headSha ? { ...pinned(), headSha: 'sha-1' } : pinned(),
    )
  })
})

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

describe('recordQueueReviewClaim', () => {
  it('records the claim and resets any previous credential, attempt and hand-back', () => {
    putQueueIntentMeta(proj, {
      ...emptyQueueIntentMeta('A'),
      mergeGrant: grant(),
      mergePhase: 'handed_back',
      mergeDetail: '旧的失败',
      mergeStartedAt: 123,
    })

    recordQueueReviewClaim({
      workspacePath: proj,
      intentId: 'A',
      sessionId: 'pending:rev-2',
      prs: [pinned()],
      now: 500,
    })

    const meta = getQueueIntentMetaById('A')
    expect(meta.reviewClaim).toEqual({
      sessionId: 'pending:rev-2',
      prs: [pinned()],
      claimedAt: 500,
    })
    expect(meta.mergeGrant).toBeNull()
    expect(meta.mergePhase).toBe('none')
    expect(meta.mergeDetail).toBeNull()
    expect(meta.mergeStartedAt).toBeNull()
  })
})

describe('bindQueueReviewClaimSession', () => {
  it('follows the pending placeholder to the real session id', () => {
    recordQueueReviewClaim({
      workspacePath: proj,
      intentId: 'A',
      sessionId: 'pending:rev-1',
      prs: [pinned()],
    })
    bindQueueReviewClaimSession(proj, 'A', 'pending:rev-1', 'real-rev-1')
    expect(getQueueIntentMetaById('A').reviewClaim?.sessionId).toBe('real-rev-1')
  })

  it('is owner-safe: a bind arriving after a newer claim writes nothing', () => {
    recordQueueReviewClaim({
      workspacePath: proj,
      intentId: 'A',
      sessionId: 'pending:rev-1',
      prs: [pinned()],
    })
    recordQueueReviewClaim({
      workspacePath: proj,
      intentId: 'A',
      sessionId: 'pending:rev-2',
      prs: [pinned()],
    })
    bindQueueReviewClaimSession(proj, 'A', 'pending:rev-1', 'stale-real')
    expect(getQueueIntentMetaById('A').reviewClaim?.sessionId).toBe('pending:rev-2')
  })
})

describe('issueMergeGrant', () => {
  it('grants only to the server-bound session of the claim that owns the round', () => {
    recordQueueReviewClaim({
      workspacePath: proj,
      intentId: 'A',
      sessionId: 'pending:rev-1',
      prs: [pinned()],
    })
    bindQueueReviewClaimSession(proj, 'A', 'pending:rev-1', 'real-rev-1')

    expect(
      issueMergeGrant({
        workspacePath: proj,
        intentId: 'A',
        callerSessionId: 'real-rev-1',
        now: 600,
      }),
    ).toBe('issued')

    const meta = getQueueIntentMetaById('A')
    expect(meta.mergeGrant).toEqual({
      reviewSessionId: 'real-rev-1',
      prs: [pinned()],
      grantedAt: 600,
    })
    expect(meta.mergePhase).toBe('pending')
  })

  it('a session that does not match the claim gets not_queue_review', () => {
    recordQueueReviewClaim({
      workspacePath: proj,
      intentId: 'A',
      sessionId: 'rev-1',
      prs: [pinned()],
    })
    expect(issueMergeGrant({ workspacePath: proj, intentId: 'A', callerSessionId: 'rev-2' })).toBe(
      'not_queue_review',
    )
    expect(getQueueIntentMetaById('A').mergeGrant).toBeNull()
  })

  it('a call with no prior claim gets not_queue_review', () => {
    expect(issueMergeGrant({ workspacePath: proj, intentId: 'A', callerSessionId: 'rev-1' })).toBe(
      'not_queue_review',
    )
    expect(getQueueIntentMetaById('A').mergeGrant).toBeNull()
  })

  it('a repeated approved backfill from the same session is unchanged, not re-issued', () => {
    recordQueueReviewClaim({
      workspacePath: proj,
      intentId: 'A',
      sessionId: 'rev-1',
      prs: [pinned()],
    })
    issueMergeGrant({ workspacePath: proj, intentId: 'A', callerSessionId: 'rev-1', now: 600 })
    expect(
      issueMergeGrant({ workspacePath: proj, intentId: 'A', callerSessionId: 'rev-1', now: 700 }),
    ).toBe('unchanged')
    expect(getQueueIntentMetaById('A').mergeGrant?.grantedAt).toBe(600)
  })

  it('a credential already consumed or handed back cannot be rewound', () => {
    recordQueueReviewClaim({
      workspacePath: proj,
      intentId: 'A',
      sessionId: 'rev-1',
      prs: [pinned()],
    })
    issueMergeGrant({ workspacePath: proj, intentId: 'A', callerSessionId: 'rev-1' })
    putQueueIntentMeta(proj, { ...getQueueIntentMetaById('A'), mergePhase: 'running' })
    expect(issueMergeGrant({ workspacePath: proj, intentId: 'A', callerSessionId: 'rev-1' })).toBe(
      'already_consumed',
    )
  })
})

describe('invalidateMergeGrant', () => {
  it('drops a credential and resets the phase', () => {
    putQueueIntentMeta(proj, {
      ...emptyQueueIntentMeta('A'),
      mergeGrant: grant(),
      mergePhase: 'pending',
    })
    invalidateMergeGrant(proj, 'A', '评审结论已改写')
    const meta = getQueueIntentMetaById('A')
    expect(meta.mergeGrant).toBeNull()
    expect(meta.mergePhase).toBe('none')
    expect(meta.mergeDetail).toBe('评审结论已改写')
  })

  it('leaves a handed_back or completed phase alone — only a new round clears those', () => {
    for (const phase of ['handed_back', 'completed'] as const) {
      putQueueIntentMeta(proj, {
        ...emptyQueueIntentMeta('A'),
        mergeGrant: grant(),
        mergePhase: phase,
        mergeDetail: '结果已定',
      })
      invalidateMergeGrant(proj, 'A', '试图失效')
      expect(getQueueIntentMetaById('A').mergePhase).toBe(phase)
      expect(getQueueIntentMetaById('A').mergeGrant).not.toBeNull()
    }
  })
})

describe('sweepMergeGrants', () => {
  it('drops a pending credential whose intent moved out from under it, and keeps a valid one', () => {
    putQueueIntentMeta(proj, {
      ...emptyQueueIntentMeta('off'),
      mergeGrant: grant(),
      mergePhase: 'pending',
    })
    putQueueIntentMeta(proj, {
      ...emptyQueueIntentMeta('good'),
      mergeGrant: grant(),
      mergePhase: 'pending',
    })

    const dropped = sweepMergeGrants(proj, [
      intent({ id: 'off', automate: false, prs: [pr({ number: '42' })] }),
      intent({ id: 'good', prs: [pr({ number: '42' })] }),
    ])

    expect(dropped).toBe(1)
    expect(getQueueIntentMetaById('off').mergeGrant).toBeNull()
    expect(getQueueIntentMetaById('good').mergeGrant).not.toBeNull()
  })

  it('never sweeps a running attempt — that is recovered, not revoked', () => {
    putQueueIntentMeta(proj, {
      ...emptyQueueIntentMeta('A'),
      mergeGrant: grant(),
      mergePhase: 'running',
    })
    sweepMergeGrants(proj, [intent({ id: 'A', automate: false, prs: [pr({ number: '42' })] })])
    expect(getQueueIntentMetaById('A').mergeGrant).not.toBeNull()
  })
})
