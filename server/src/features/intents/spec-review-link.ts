/**
 * Intent↔spec-REVIEW-session early-bind linkage — feature-private (ADR-0009).
 *
 * The exact shape of `./spec-link.ts`, kept as its own map rather than a shared
 * one: an author bind and a reviewer bind write DIFFERENT columns on the intent,
 * so one table serving both would have to carry a discriminator and could link a
 * review session into `spec_session_id` on a wiring slip. Two maps make that
 * impossible by construction.
 *
 * Keyed by the **pending** session id, registered before `launchRun`, consumed by
 * the resident `run:bound` handler on first bind, and swept by `run:settled` for
 * the error-before-bind edge. In-memory only; it does not survive a restart, and
 * nothing depends on it doing so (the next reconcile re-derives from the ledger).
 */
const pendingSpecReviewLink = new Map<string, string>()

/** Register a review session's pending id so `run:bound` can link it. */
export function registerPendingSpecReviewLink(pendingId: string, intentId: string): void {
  pendingSpecReviewLink.set(pendingId, intentId)
}

/**
 * Atomically read and remove the intent id for a pending review session.
 * Idempotent: a second call on the same id always returns `undefined`.
 */
export function takePendingSpecReviewLink(pendingId: string): string | undefined {
  const intentId = pendingSpecReviewLink.get(pendingId)
  if (intentId !== undefined) pendingSpecReviewLink.delete(pendingId)
  return intentId
}

/** Remove an entry without consuming it (the run errored before binding). Idempotent. */
export function clearPendingSpecReviewLink(pendingId: string): string | undefined {
  const intentId = pendingSpecReviewLink.get(pendingId)
  pendingSpecReviewLink.delete(pendingId)
  return intentId
}

/** Reset the map (test teardown only). */
export function resetForTests(): void {
  pendingSpecReviewLink.clear()
}
