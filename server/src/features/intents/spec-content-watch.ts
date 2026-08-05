/**
 * Spec content watch — the write boundary where `raw` becomes `pending`.
 *
 * The server seeds a placeholder `spec.md` before the authoring agent starts, so
 * "a spec file exists" says nothing about whether a spec was written. The one
 * fact that does is whether the document CHANGED across an authoring run: the
 * fingerprint captured just before the run is compared against the one on disk
 * once it settles, and only a real difference promotes the status.
 *
 * Why a captured fingerprint rather than reading the file and judging it: the
 * seed's wording is not evidence (a real spec may legitimately contain
 * `_(to be authored)_`), and no consumer may reverse-engineer state from live
 * file content — the status column is the single source of truth, and it moves
 * only here and at the other controlled write boundaries (the human inline edit,
 * approval, revocation).
 *
 * Entries are keyed by intent id: a spec run belongs to exactly one intent, and
 * the settle handler resolves the intent from the session either way (pending
 * link or `spec_session_id`), so this map never has to survive the pending→real
 * re-key. Pure in-memory, feature-private (ADR-0009), and NOT restart-durable —
 * a lost entry costs one missed promotion, which the next authoring run redoes.
 */
import { markSpecAuthored, safeInsertIntentLog, type SpecAuthoredOutcome } from './store.js'
import { readSpecFingerprint } from './spec-review.js'

interface SpecContentWatch {
  workspacePath: string
  /** The spec path as it stood when the run started. */
  specPath: string
  /** The document's fingerprint before this run wrote anything; `null` when unreadable. */
  fingerprint: string | null
}

const watches = new Map<string, SpecContentWatch>()

/**
 * Remember what an intent's spec looked like BEFORE an authoring run touches it.
 * Called by every path that starts or resumes a spec-authoring turn — including
 * the first-time scaffold, where the fingerprint is the SEED's, so an agent that
 * writes nothing leaves the intent `raw`.
 */
export function armSpecContentWatch(input: {
  intentId: string
  workspacePath: string
  specPath: string
  fingerprint: string | null
}): void {
  watches.set(input.intentId, {
    workspacePath: input.workspacePath,
    specPath: input.specPath,
    fingerprint: input.fingerprint,
  })
}

/** Drop an intent's watch without evaluating it. Idempotent. */
export function clearSpecContentWatch(intentId: string): void {
  watches.delete(intentId)
}

/** Reset the map (test teardown only). */
export function resetForTests(): void {
  watches.clear()
}

/**
 * What the settle check concluded.
 * - `no_watch`   — this run was never armed (nothing to compare against).
 * - `unreadable` — the spec cannot be read now; unreadable is NOT changed, so the
 *   status stays exactly where it was and a later run tries again.
 * - `unchanged`  — the run wrote nothing new (it may also have failed): still `raw`.
 * - `promoted` / `reopened` — see {@link SpecAuthoredOutcome}.
 */
export type SpecContentSettleOutcome = 'no_watch' | 'unreadable' | 'unchanged' | SpecAuthoredOutcome

/**
 * Evaluate (and consume) an intent's watch after its authoring run settled.
 *
 * Returns the outcome; `promoted` / `reopened` mean the ledger changed and the
 * caller must broadcast and wake the queue — the review agent may only start once
 * the persisted status is `pending`, so this write is the precondition for it,
 * never something that races it.
 *
 * The status write and its audit entry are the only side effects; nothing here
 * starts a session, decides anything, or touches the spec file.
 */
export function settleSpecContentWatch(
  intentId: string,
  readFingerprint: (workspacePath: string, specPath: string) => string | null = readSpecFingerprint,
): SpecContentSettleOutcome {
  const watch = watches.get(intentId)
  if (!watch) return 'no_watch'
  watches.delete(intentId)
  const now = readFingerprint(watch.workspacePath, watch.specPath)
  if (now === null) return 'unreadable'
  if (now === watch.fingerprint) return 'unchanged'
  const outcome = markSpecAuthored(intentId)
  if (outcome === 'reopened') {
    safeInsertIntentLog(intentId, 'spec_unapproved', '批准后的 spec 被改写,批准已失效', 'system')
  }
  return outcome
}
