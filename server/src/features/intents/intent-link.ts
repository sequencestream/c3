/**
 * Intent↔refine-session early-bind linkage — feature-private (ADR-0009).
 *
 * A minimal pending→intentId registration table used by `refine_intent` so the
 * resident `run:bound` subscription can link the real refine/comm session id
 * back onto the intent (`intent_session_id`) as soon as the SDK reports the
 * first bind, without the launch handler subscribing to the event bus itself.
 *
 * The map is keyed by the **pending** session id (`pending:…`), registered by
 * the `refine_intent` handler before calling `launchRun`, and consumed (and
 * deleted) by the resident `run:bound` handler on first bind. A safety-net sweep
 * in the `run:settled` (kind=intent) handler clears any entry whose run settled
 * without binding (an error-before-bind edge).
 *
 * Pattern: mirrors `./spec-link.ts` / `./dev-link.ts` (feature-private standalone
 * module, no KernelContext dependency, pure in-memory state that does NOT survive
 * restart). Distinct from spec-link because the refine session is a `'intent'`
 * runtime (the comm/refine conversation) vs the `'spec'` runtime (spec authoring).
 */
const pendingIntentLink = new Map<string, string>()

/**
 * Register a refining intent's pending session id, so the resident `run:bound`
 * subscription can link it on first bind. Called by the `refine_intent` handler
 * just before `ctx.launchRun`.
 */
export function registerPendingIntentLink(pendingId: string, intentId: string): void {
  pendingIntentLink.set(pendingId, intentId)
}

/**
 * Atomically read and remove the intent id for a pending refine session.
 * Returns `undefined` if `pendingId` was never registered.
 *
 * Idempotent: the second call on the same `pendingId` always returns
 * `undefined` (the entry was consumed on the first call).
 */
export function takePendingIntentLink(pendingId: string): string | undefined {
  const intentId = pendingIntentLink.get(pendingId)
  if (intentId !== undefined) pendingIntentLink.delete(pendingId)
  return intentId
}

/**
 * Remove a pending-link entry without consuming it (e.g. when the refine run
 * errors out before binding). Idempotent.
 */
export function clearPendingIntentLink(pendingId: string): string | undefined {
  const intentId = pendingIntentLink.get(pendingId)
  pendingIntentLink.delete(pendingId)
  return intentId
}

/** Reset the map (test teardown only). */
export function resetForTests(): void {
  pendingIntentLink.clear()
}
