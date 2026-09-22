/**
 * Tests for `resolveIntentRelayManualTrigger` — the single criterion the web
 * title bar and the `start_intent_relay` handler both read.
 *
 * The cases mirror the spec's phase table, one `it` per row, plus the two gates
 * that sit in front of the table (branch mode / live PR, and "something is
 * already in flight") and the stale-`pending` recovery the in-flight INPUT is
 * responsible for: a `pending` status with no occupied session must still offer
 * the resume, or a dead launch would hide the button with no way back.
 */
import { describe, expect, it } from 'vitest'
import { MAX_REVIEW_FIX_ROUNDS } from './protocol.js'
import {
  resolveIntentRelayManualTrigger,
  type IntentRelayManualTriggerFacts,
} from './intent-relay-manual-model.js'

/** The un-reviewed, worktree-mode, live-PR baseline every case starts from. */
function facts(
  overrides: Partial<IntentRelayManualTriggerFacts> = {},
): IntentRelayManualTriggerFacts {
  return {
    gitBranchMode: 'worktree',
    hasActivePr: true,
    reviewStatus: null,
    fixStatus: null,
    reviewFixRounds: 0,
    reviewInFlight: false,
    fixInFlight: false,
    ...overrides,
  }
}

describe('resolveIntentRelayManualTrigger — gates', () => {
  it('offers nothing when the workspace is not in worktree mode', () => {
    expect(resolveIntentRelayManualTrigger(facts({ gitBranchMode: 'current-branch' }))).toEqual({
      canStartReview: false,
      canStartFix: false,
      blockedReason: 'notApplicable',
    })
  })

  it('offers nothing without a live PR', () => {
    expect(resolveIntentRelayManualTrigger(facts({ hasActivePr: false })).canStartReview).toBe(
      false,
    )
  })

  it('withholds BOTH phases while a review session is in flight', () => {
    const r = resolveIntentRelayManualTrigger(
      facts({ reviewStatus: 'pending', reviewInFlight: true }),
    )
    expect(r).toEqual({ canStartReview: false, canStartFix: false, blockedReason: 'inFlight' })
  })

  it('withholds BOTH phases while a fix session is in flight', () => {
    const r = resolveIntentRelayManualTrigger(
      facts({ reviewStatus: 'rejected', fixStatus: 'pending', fixInFlight: true }),
    )
    expect(r).toEqual({ canStartReview: false, canStartFix: false, blockedReason: 'inFlight' })
  })
})

describe('resolveIntentRelayManualTrigger — phase table', () => {
  it('offers the FIRST review when no conclusion exists', () => {
    expect(resolveIntentRelayManualTrigger(facts())).toEqual({
      canStartReview: true,
      canStartFix: false,
      blockedReason: null,
    })
  })

  it('offers the first review for an L5 grade (the queue would skip it)', () => {
    // The grade is not an input at all — the criterion has no L5 branch, which
    // is precisely the intended difference from `needsReview(impactLevel)`.
    expect(resolveIntentRelayManualTrigger(facts({ reviewStatus: null })).canStartReview).toBe(true)
  })

  it('offers the RESUME when a review is marked pending but nothing holds it', () => {
    expect(
      resolveIntentRelayManualTrigger(facts({ reviewStatus: 'pending', reviewInFlight: false })),
    ).toEqual({ canStartReview: true, canStartFix: false, blockedReason: null })
  })

  it('offers the RE-REVIEW once the fix round has concluded', () => {
    expect(
      resolveIntentRelayManualTrigger(facts({ reviewStatus: 'rejected', fixStatus: 'fixed' })),
    ).toEqual({ canStartReview: true, canStartFix: false, blockedReason: null })
  })

  it('offers the NEXT fix round for a fresh rejection', () => {
    expect(
      resolveIntentRelayManualTrigger(facts({ reviewStatus: 'rejected', fixStatus: null })),
    ).toEqual({ canStartReview: false, canStartFix: true, blockedReason: null })
  })

  it('offers the RESUME when a fix is marked pending but nothing holds it', () => {
    expect(
      resolveIntentRelayManualTrigger(
        facts({ reviewStatus: 'rejected', fixStatus: 'pending', fixInFlight: false }),
      ),
    ).toEqual({ canStartReview: false, canStartFix: true, blockedReason: null })
  })

  it('offers nothing once approved', () => {
    expect(resolveIntentRelayManualTrigger(facts({ reviewStatus: 'approved' }))).toEqual({
      canStartReview: false,
      canStartFix: false,
      blockedReason: 'notApplicable',
    })
  })

  it('offers nothing at the round cap while still rejected', () => {
    const r = resolveIntentRelayManualTrigger(
      facts({ reviewStatus: 'rejected', fixStatus: null, reviewFixRounds: MAX_REVIEW_FIX_ROUNDS }),
    )
    expect(r.canStartFix).toBe(false)
    expect(r.blockedReason).toBe('notApplicable')
  })

  it('still offers the fix on the last round under the cap', () => {
    expect(
      resolveIntentRelayManualTrigger(
        facts({
          reviewStatus: 'rejected',
          fixStatus: null,
          reviewFixRounds: MAX_REVIEW_FIX_ROUNDS - 1,
        }),
      ).canStartFix,
    ).toBe(true)
  })

  it('still offers the re-review at the cap once the fix concluded', () => {
    expect(
      resolveIntentRelayManualTrigger(
        facts({
          reviewStatus: 'rejected',
          fixStatus: 'fixed',
          reviewFixRounds: MAX_REVIEW_FIX_ROUNDS,
        }),
      ).canStartReview,
    ).toBe(true)
  })
})
