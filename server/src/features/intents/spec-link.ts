/**
 * Intent↔spec-session early-bind linkage — feature-private (ADR-0009).
 *
 * A minimal pending→intentId registration table used by `write_spec` so the
 * resident `run:bound` subscription can link the real spec session id back onto
 * the intent (`spec_session_id`) as soon as the SDK reports the first bind,
 * without the launch handler subscribing to the event bus itself.
 *
 * The map is keyed by the **pending** session id (`pending:…`), registered by
 * the `write_spec` handler before calling `launchRun`, and consumed (and
 * deleted) by the resident `run:bound` handler on first bind. A safety-net sweep
 * in the `run:settled` handler clears any entry whose run settled without
 * binding (an error-before-bind edge).
 *
 * Pattern: mirrors `./dev-link.ts` (feature-private standalone module, no
 * KernelContext dependency, pure in-memory state that does NOT survive restart).
 */
const pendingSpecLink = new Map<string, string>()

/**
 * Register a spec-to-be-written's pending session id, so the resident
 * `run:bound` subscription can link it on first bind. Called by the `write_spec`
 * handler just before `ctx.launchRun`.
 */
export function registerPendingSpecLink(pendingId: string, intentId: string): void {
  pendingSpecLink.set(pendingId, intentId)
}

/**
 * Atomically read and remove the intent id for a pending spec session.
 * Returns `undefined` if `pendingId` was never registered.
 *
 * Idempotent: the second call on the same `pendingId` always returns
 * `undefined` (the entry was consumed on the first call).
 */
export function takePendingSpecLink(pendingId: string): string | undefined {
  const intentId = pendingSpecLink.get(pendingId)
  if (intentId !== undefined) pendingSpecLink.delete(pendingId)
  return intentId
}

/**
 * Remove a pending-link entry without consuming it (e.g. when the spec run
 * errors out before binding). Idempotent.
 */
export function clearPendingSpecLink(pendingId: string): string | undefined {
  const intentId = pendingSpecLink.get(pendingId)
  pendingSpecLink.delete(pendingId)
  return intentId
}

/** Reset the map (test teardown only). */
export function resetForTests(): void {
  pendingSpecLink.clear()
}
