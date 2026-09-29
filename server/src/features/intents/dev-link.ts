/**
 * Intent↔work-session early-bind linkage — feature-private (ADR-0009).
 *
 * A minimal pending→intentId registration table used by manual
 * `start_development` so the resident `run:bound` subscription can flip the
 * dependent intent to `in_progress` and link the real work session id as soon as
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
 *
 * It also owns the RESTART coordination state: the set of session ids a manual
 * `restart_work_session` is aborting, and a bounded subscribe-once wait for such
 * a session's `run:settled`, so the restart handler can keep two live work
 * sessions from ever overlapping.
 */
/**
 * What a pending manual launch carries to its first bind: the intent it belongs
 * to, and the DELIVERY CONTEXT resolved for that launch. The context is decided
 * before the session exists (it picks the worktree baseline), but the row that
 * records it is only written once the real session id arrives — so it rides
 * along here rather than being re-derived at bind time, where the intent's
 * associations may already have changed.
 */
export interface PendingDevLink {
  intentId: string
  /** `null` = this launch has no delivery context. */
  deliveryId: string | null
}

const pendingDevLink = new Map<string, PendingDevLink>()
const launchingIntentIds = new Set<string>()

/**
 * Session ids currently being RESTARTED by the manual `restart_work_session`
 * path. Populated only when the session being replaced was actually live (an
 * idle session is never stopped, so nothing needs suppressing), and consulted by
 * the resident `run:settled` work subscription: the settle of a restart-aborted
 * turn must write its `cancelled` conclusion but must NOT run the manual
 * dev cleanup (commit/push/PR) or the fast-mode reverse-spec settle — a restart
 * is a mid-flight hand-off, not a delivery.
 *
 * In-process only, like the pending-link table above: a restart cannot outlive
 * the process that started it, so persistence would only create a stale marker.
 */
const restartingSessionIds = new Set<string>()

/** Mark a live session as being aborted by a restart, before `stopRun`. */
export function markSessionRestarting(sessionId: string): void {
  restartingSessionIds.add(sessionId)
}

/** Whether this settled session was aborted by a restart. */
export function isSessionRestarting(sessionId: string): boolean {
  return restartingSessionIds.has(sessionId)
}

/**
 * Clear the restart marker. Called on the settle it was set for, and on the
 * timeout path where the restart was refused and the old run is left to settle
 * normally (its cleanup must then run as usual).
 */
export function clearSessionRestarting(sessionId: string): void {
  restartingSessionIds.delete(sessionId)
}

/** Minimal subscriber surface the settle wait needs (the kernel `EventBus` fits). */
interface RunSettledSubscriber {
  subscribe(topic: 'run:settled', handler: (payload: { sessionId: string }) => void): () => void
}

/**
 * Resolve `true` once `run:settled` fires for `sessionId`, or `false` if the
 * bounded wait elapses first. A subscribe-once (disposed on either path), NOT a
 * poll: `isRunning` stays true until teardown completes, so polling could not
 * tell "still working" from "mid-teardown".
 */
export function waitForSessionSettled(
  eventBus: RunSettledSubscriber,
  sessionId: string,
  timeoutMs: number,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false
    const dispose = eventBus.subscribe('run:settled', (payload) => {
      if (settled || payload.sessionId !== sessionId) return
      settled = true
      clearTimeout(timer)
      dispose()
      resolve(true)
    })
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      dispose()
      resolve(false)
    }, timeoutMs)
  })
}

/**
 * Synchronously claim a manual start_development launch for an intent.
 * Returns false when another launch for the same intent is already between the
 * handler entry and its first successful run:bound (or startup failure).
 */
export function tryClaimDevLaunch(intentId: string): boolean {
  if (launchingIntentIds.has(intentId)) return false
  launchingIntentIds.add(intentId)
  return true
}

/**
 * Release a manual start_development claim. Idempotent so every failure edge can
 * call it without coordinating with the run:bound success path.
 */
export function releaseDevLaunch(intentId: string): void {
  launchingIntentIds.delete(intentId)
}

/**
 * Register an intent-to-be-started's pending work session id, so the resident
 * `run:bound` subscription can link it on first bind. Called by the
 * `start_development` handler just before `ctx.launchRun`.
 */
export function registerPendingDevLink(
  pendingId: string,
  intentId: string,
  deliveryId: string | null = null,
): void {
  pendingDevLink.set(pendingId, { intentId, deliveryId })
}

/**
 * Atomically read and remove the intent id for a pending session.
 * Returns `undefined` if `pendingId` was never registered (normal for
 * non-start_development launches).
 *
 * Idempotent: the second call on the same `pendingId` always returns
 * `undefined` (the entry was consumed on the first call).
 */
export function takePendingDevLink(pendingId: string): PendingDevLink | undefined {
  const link = pendingDevLink.get(pendingId)
  if (link !== undefined) pendingDevLink.delete(pendingId)
  return link
}

/**
 * Remove a pending-link entry without consuming it (e.g. when the dev run
 * errors out before binding). Idempotent.
 */
export function clearPendingDevLink(pendingId: string): string | undefined {
  const intentId = pendingDevLink.get(pendingId)?.intentId
  pendingDevLink.delete(pendingId)
  return intentId
}

/**
 * Read the intent id for a pending work session WITHOUT consuming the entry, so
 * a read-only observer (e.g. the blocked-state projection, which sees an agent
 * failure that happened before the session ever bound) can attribute the failure
 * without stealing the bind-time link from `run:bound`.
 */
export function peekPendingDevLink(pendingId: string): string | undefined {
  return pendingDevLink.get(pendingId)?.intentId
}

/**
 * Reset the map (test teardown only).
 */
export function resetForTests(): void {
  pendingDevLink.clear()
  launchingIntentIds.clear()
  restartingSessionIds.clear()
}
