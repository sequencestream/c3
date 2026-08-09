/**
 * The ONE criterion for "may this intent's `specMode` still be changed", as a
 * pure function of a fact snapshot.
 *
 * `specMode` ("does this intent need a spec first") is a decision about the
 * ORDER of work — spec first, or code first and back-fill later. It only means
 * anything BEFORE either has started: switching it afterwards neither revokes an
 * approved spec nor rolls back finished development, so a late switch changes
 * nothing while leaving the ledger claiming a mode this intent never followed.
 * Hence: once spec or development has started, the mode is locked.
 *
 * It lives here rather than in `protocol/` because it is a RULE, not a shape,
 * and rather than in either caller because it has exactly two readers that must
 * agree: the web console (which decides whether to render the select at all) and
 * the `set_intent_spec_mode` handler (which is the backstop against direct WS
 * calls and stale tabs). Two private copies would drift the moment a new
 * "spec has started" signal appears.
 *
 * Data in, verdict out: no I/O, no clock, no store access. Each reader reduces
 * its own world into {@link SpecModeEditFacts} at its own boundary — both happen
 * to hold the same `Intent` read model, whose field names this snapshot mirrors.
 */
import type { SpecStatus } from './protocol.js'

/** An intent reduced to the facts the criterion reads — nothing else is consulted. */
export interface SpecModeEditFacts {
  /** Where the spec document lives; blank (or whitespace) means no spec content. */
  specPath: string | null | undefined
  /** The spec lifecycle stage; anything past `raw` means a spec exists. */
  specStatus: SpecStatus
  /** The spec-AUTHORING session, if one was ever started. */
  specSessionId: string | null | undefined
  /** The spec-REVIEW session, if one was ever started. */
  specReviewSessionId: string | null | undefined
  /** The most recent development session, if development ever ran. */
  lastWorkSessionId: string | null | undefined
}

/** A blank / whitespace-only id or path counts as absent. */
function isBlank(value: string | null | undefined): boolean {
  return (value ?? '').trim() === ''
}

/**
 * `true` while `specMode` may still be changed — all three must hold:
 *
 * | # | condition        | fields                                        |
 * | - | ---------------- | --------------------------------------------- |
 * | ① | no spec content  | `specPath` blank AND `specStatus === 'raw'`    |
 * | ② | no spec session  | `specSessionId` and `specReviewSessionId` blank |
 * | ③ | no work session  | `lastWorkSessionId` blank                     |
 *
 * A merged PR is deliberately NOT a separate condition: a merged intent always
 * ran a work session, so ③ already covers it, and a second PR-shaped rule would
 * be a duplicate statement of the same fact that could disagree with the first.
 */
export function canEditIntentSpecMode(facts: SpecModeEditFacts): boolean {
  const noSpecContent = isBlank(facts.specPath) && facts.specStatus === 'raw'
  const noSpecSession = isBlank(facts.specSessionId) && isBlank(facts.specReviewSessionId)
  const noWorkSession = isBlank(facts.lastWorkSessionId)
  return noSpecContent && noSpecSession && noWorkSession
}
