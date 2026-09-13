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
 * still modifiable at all. `in_progress` and `done` are locked, the same pair
 * `save_intents` refuses to upsert, so the grade cannot be edited through one
 * door while the other holds it shut.
 */
export function canEditIntentImpactLevel(facts: ImpactLevelEditFacts): boolean {
  return facts.status !== 'in_progress' && facts.status !== 'done'
}
