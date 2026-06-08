/**
 * Intent↔dev-session early-bind linkage — feature-private (ADR-0009).
 *
 * A minimal pending→intentId registration table used by manual
 * `start_development` so the resident `run:bound` subscription can flip the
 * dependent intent to `in_progress` and link the real dev session id as soon as
 * the SDK reports the first bind, without the launch handler subscribing to the
 * event bus itself.
 *
 * The map is keyed by the **pending** session id (`pending:…`), registered by
 * the start_development handler before calling `launchRun`, and consumed (and
 * deleted) by the resident `run:bound` handler on first bind. A safety-net sweep
 * in the `run:settled` handler clears any entry whose run settled without
 * binding (an error-before-bind edge).
 *
 * Pattern: mirrors `./run-status.ts` (feature-private standalone module, no
 * KernelContext dependency, pure in-memory state that does NOT survive restart).
 */
const pendingDevLink = new Map<string, string>()

/**
 * Register an intent-to-be-started's pending dev session id, so the resident
 * `run:bound` subscription can link it on first bind. Called by the
 * `start_development` handler just before `ctx.launchRun`.
 */
export function registerPendingDevLink(pendingId: string, intentId: string): void {
  pendingDevLink.set(pendingId, intentId)
}

/**
 * Atomically read and remove the intent id for a pending session.
 * Returns `undefined` if `pendingId` was never registered (normal for
 * non-start_development launches).
 *
 * Idempotent: the second call on the same `pendingId` always returns
 * `undefined` (the entry was consumed on the first call).
 */
export function takePendingDevLink(pendingId: string): string | undefined {
  const intentId = pendingDevLink.get(pendingId)
  if (intentId !== undefined) pendingDevLink.delete(pendingId)
  return intentId
}

/**
 * Remove a pending-link entry without consuming it (e.g. when the dev run
 * errors out before binding). Idempotent.
 */
export function clearPendingDevLink(pendingId: string): void {
  pendingDevLink.delete(pendingId)
}

/**
 * Reset the map (test teardown only).
 */
export function resetForTests(): void {
  pendingDevLink.clear()
}
