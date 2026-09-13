/**
 * The impact-level value guard and the ONE criterion for "may this intent's
 * `impactLevel` still be changed", both as pure functions.
 *
 * `impactLevel` describes how far a change reaches, which is a judgement about
 * work that has NOT happened yet. Once development is under way or finished, the
 * reach is a fact of the code that shipped, not a grade someone may still
 * re-declare — so the field follows the ledger's existing immutability rule
 * (`in_progress` / `done` are locked) rather than inventing a second one.
 *
 * They live here rather than in `protocol/` because they are RULES, not shapes,
 * and rather than in either caller because each has two readers that must agree:
 * the web console (which decides whether to render the select) and the
 * `set_intent_impact_level` handler (the backstop against direct WS calls and
 * stale tabs); the guard is shared by the store's read narrowing and the save
 * tool's input validation.
 *
 * Data in, verdict out: no I/O, no clock, no store access.
 */
import { INTENT_IMPACT_LEVELS, type IntentImpactLevel, type IntentStatus } from './protocol.js'

/** `true` only for a value that is exactly one of the five grades. */
export function isIntentImpactLevel(v: unknown): v is IntentImpactLevel {
  return typeof v === 'string' && (INTENT_IMPACT_LEVELS as readonly string[]).includes(v)
}

/** An intent reduced to the facts the criterion reads — nothing else is consulted. */
export interface ImpactLevelEditFacts {
  status: IntentStatus
}

/**
 * `true` while `impactLevel` may still be changed — i.e. while the intent is
 * still modifiable at all. `in_progress`, `reviewing` and `done` are locked, the
 * same set `save_intents` refuses to upsert (the code has already shipped, so
 * its reach is a fact, not a grade someone may still re-declare mid-review), so
 * the grade cannot be edited through one door while the other holds it shut.
 */
export function canEditIntentImpactLevel(facts: ImpactLevelEditFacts): boolean {
  return facts.status !== 'in_progress' && facts.status !== 'reviewing' && facts.status !== 'done'
}

/**
 * Whether this intent's PR warrants an AI review before it may close the loop.
 * `L1`–`L4` need review, `L5` (wording / cosmetic) does not, and an UNGRADED
 * (`null`) intent DOES — the fail-safe reads "when in doubt, review". An
 * unrecognised persisted grade must be narrowed to `null` by the store before it
 * reaches this function, so it can never slip through as "no review needed".
 *
 * This answers only "is review needed" — whether a FIX is needed is not a second
 * rule here; it derives from the review conclusion (`reviewStatus === 'rejected'`).
 */
export function needsReview(impactLevel: IntentImpactLevel | null): boolean {
  return impactLevel !== 'L5'
}
