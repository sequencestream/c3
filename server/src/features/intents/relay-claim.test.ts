/**
 * The queue's conditional relay claims against a real database.
 *
 * These are the writes that make the fix budget honest, so every case here is
 * about one question: can the same intention be applied twice? A repeated action,
 * a racing pass, a restart and a stale callback all funnel through
 * `claimIntentRelayPhase` / `replaceIntentRelaySession` /
 * `releaseIntentRelayPhase`, and each must either apply exactly once or refuse
 * without touching a byte.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
vi.mock('../../state.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../state.js')>()),
  resolveWorkspaceRoot: (id: string) => id,
  pathToName: (p: string) => p,
  workspaceNameFor: (value: string) => value,
}))
import { resetDbForTests } from '../../kernel/infra/db.js'
import {
  claimIntentRelayPhase,
  getIntent,
  insertIntents,
  releaseIntentRelayPhase,
  replaceIntentRelaySession,
  resetStoreForTests,
  updateIntentReviewFixStatus,
} from './store.js'

const proj = '/abs/relay-claim-proj'
let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'c3-relay-claim-'))
  process.env.C3_DB_PATH = join(dir, 'c3.db')
  resetDbForTests()
  resetStoreForTests()
})

afterEach(() => {
  resetDbForTests()
  delete process.env.C3_DB_PATH
  rmSync(dir, { recursive: true, force: true })
})

function seed(): string {
  const [intent] = insertIntents(proj, [
    { title: '接力目标', shortEnTitle: 'relay', content: '正文', priority: 'P1' },
  ])
  return intent.id
}

const firstReview = {
  phase: 'review' as const,
  expectReviewStatus: null,
  expectFixStatus: null,
  expectRounds: 0,
  nextRounds: 0,
  pendingSessionId: 'pending:rev-1',
}

describe('claimIntentRelayPhase — review', () => {
  it('registers the placeholder and the pending marker, leaving the round alone', () => {
    const id = seed()
    expect(claimIntentRelayPhase(id, firstReview)).toBe(true)
    const after = getIntent(id)!
    expect(after.reviewSessionId).toBe('pending:rev-1')
    expect(after.reviewStatus).toBe('pending')
    expect(after.reviewFixRounds).toBe(0)
    expect(after.fixSessionId).toBeNull()
    expect(after.fixStatus).toBeNull()
  })

  it('refuses a second claim on the same expectation — the phase is already taken', () => {
    const id = seed()
    expect(claimIntentRelayPhase(id, firstReview)).toBe(true)
    expect(claimIntentRelayPhase(id, { ...firstReview, pendingSessionId: 'pending:rev-2' })).toBe(
      false,
    )
    expect(getIntent(id)!.reviewSessionId).toBe('pending:rev-1')
  })

  it('refuses when the round moved since the snapshot', () => {
    const id = seed()
    updateIntentReviewFixStatus(id, { reviewStatus: 'rejected', reviewFixRounds: 2 })
    expect(
      claimIntentRelayPhase(id, {
        ...firstReview,
        expectReviewStatus: 'rejected',
        expectRounds: 1,
        nextRounds: 1,
      }),
    ).toBe(false)
    expect(getIntent(id)!.reviewFixRounds).toBe(2)
  })

  it('a re-review clears the fix marker so an old `fixed` cannot satisfy the next rejection', () => {
    const id = seed()
    updateIntentReviewFixStatus(id, {
      reviewStatus: 'rejected',
      reviewSessionId: 'rev-1',
      reviewFixRounds: 1,
      fixSessionId: 'fix-1',
      fixStatus: 'fixed',
    })
    expect(
      claimIntentRelayPhase(id, {
        phase: 'review',
        expectReviewStatus: 'rejected',
        expectFixStatus: 'fixed',
        expectRounds: 1,
        nextRounds: 1,
        pendingSessionId: 'pending:rev-2',
      }),
    ).toBe(true)
    const after = getIntent(id)!
    expect(after.reviewStatus).toBe('pending')
    expect(after.fixStatus).toBeNull()
    expect(after.fixSessionId).toBeNull()
    expect(after.reviewFixRounds).toBe(1)
  })
})

describe('claimIntentRelayPhase — fix', () => {
  it('raises the round and keeps `rejected` readable for the fix session', () => {
    const id = seed()
    updateIntentReviewFixStatus(id, { reviewStatus: 'rejected', reviewSessionId: 'rev-1' })
    expect(
      claimIntentRelayPhase(id, {
        phase: 'fix',
        expectReviewStatus: 'rejected',
        expectFixStatus: null,
        expectRounds: 0,
        nextRounds: 1,
        pendingSessionId: 'pending:fix-1',
      }),
    ).toBe(true)
    const after = getIntent(id)!
    expect(after.reviewFixRounds).toBe(1)
    expect(after.reviewStatus).toBe('rejected')
    expect(after.fixStatus).toBe('pending')
    expect(after.fixSessionId).toBe('pending:fix-1')
  })

  it('a duplicated claim cannot spend the budget twice', () => {
    const id = seed()
    updateIntentReviewFixStatus(id, { reviewStatus: 'rejected', reviewSessionId: 'rev-1' })
    const claim = {
      phase: 'fix' as const,
      expectReviewStatus: 'rejected' as const,
      expectFixStatus: null,
      expectRounds: 0,
      nextRounds: 1,
      pendingSessionId: 'pending:fix-1',
    }
    expect(claimIntentRelayPhase(id, claim)).toBe(true)
    expect(claimIntentRelayPhase(id, { ...claim, pendingSessionId: 'pending:fix-2' })).toBe(false)
    expect(getIntent(id)!.reviewFixRounds).toBe(1)
  })

  it('recovering a pending fix re-enters the SAME round', () => {
    const id = seed()
    updateIntentReviewFixStatus(id, {
      reviewStatus: 'rejected',
      reviewSessionId: 'rev-1',
      reviewFixRounds: 2,
      fixSessionId: 'pending:dead',
      fixStatus: 'pending',
    })
    expect(
      claimIntentRelayPhase(id, {
        phase: 'fix',
        expectReviewStatus: 'rejected',
        expectFixStatus: 'pending',
        expectRounds: 2,
        nextRounds: 2,
        pendingSessionId: 'pending:fix-retry',
      }),
    ).toBe(true)
    expect(getIntent(id)!.reviewFixRounds).toBe(2)
  })

  it('refuses on a missing intent without throwing', () => {
    expect(
      claimIntentRelayPhase('does-not-exist', {
        phase: 'fix',
        expectReviewStatus: 'rejected',
        expectFixStatus: null,
        expectRounds: 0,
        nextRounds: 1,
        pendingSessionId: 'pending:x',
      }),
    ).toBe(false)
  })
})

describe('owner-safe session writes', () => {
  it('binds the real session only while the placeholder still holds the phase', () => {
    const id = seed()
    claimIntentRelayPhase(id, firstReview)
    expect(replaceIntentRelaySession(id, 'review', 'pending:rev-1', 'real-1')).toBe(true)
    expect(getIntent(id)!.reviewSessionId).toBe('real-1')
    // A late callback from the previous placeholder writes nothing.
    expect(replaceIntentRelaySession(id, 'review', 'pending:rev-1', 'real-late')).toBe(false)
    expect(getIntent(id)!.reviewSessionId).toBe('real-1')
  })

  it('releasing an un-concluded phase clears the placeholder AND the pending marker', () => {
    const id = seed()
    claimIntentRelayPhase(id, firstReview)
    expect(releaseIntentRelayPhase(id, 'review', 'pending:rev-1')).toBe(true)
    const after = getIntent(id)!
    expect(after.reviewSessionId).toBeNull()
    expect(after.reviewStatus).toBeNull()
  })

  it('releasing never erases a terminal that landed while the session was finishing', () => {
    const id = seed()
    claimIntentRelayPhase(id, firstReview)
    updateIntentReviewFixStatus(id, {
      reviewSessionId: 'pending:rev-1',
      reviewStatus: 'approved',
    })
    expect(releaseIntentRelayPhase(id, 'review', 'pending:rev-1')).toBe(true)
    expect(getIntent(id)!.reviewStatus).toBe('approved')
  })

  it('a release from a session that no longer holds the phase changes nothing', () => {
    const id = seed()
    claimIntentRelayPhase(id, firstReview)
    expect(releaseIntentRelayPhase(id, 'review', 'pending:other')).toBe(false)
    expect(getIntent(id)!.reviewSessionId).toBe('pending:rev-1')
  })

  it('releasing a fix leaves the claimed round spent — a crash refunds no budget', () => {
    const id = seed()
    updateIntentReviewFixStatus(id, { reviewStatus: 'rejected', reviewSessionId: 'rev-1' })
    claimIntentRelayPhase(id, {
      phase: 'fix',
      expectReviewStatus: 'rejected',
      expectFixStatus: null,
      expectRounds: 0,
      nextRounds: 1,
      pendingSessionId: 'pending:fix-1',
    })
    releaseIntentRelayPhase(id, 'fix', 'pending:fix-1')
    const after = getIntent(id)!
    expect(after.reviewFixRounds).toBe(1)
    expect(after.fixStatus).toBeNull()
    expect(after.fixSessionId).toBeNull()
    expect(after.reviewStatus).toBe('rejected')
  })
})
