/**
 * Permission-decision registry shared between the WS handler and the Claude run loop.
 *
 * `canUseTool` (in claude.ts) calls `waitForDecision(requestId)` and awaits the
 * returned promise. The WS handler calls `resolveDecision(requestId, decision)`
 * when a `permission_response` arrives from the browser. The request blocks
 * indefinitely until the user responds — exactly like the terminal CLI prompt.
 * There is no timeout: an unanswered prompt never auto-denies. If the run is
 * aborted (session switch / new prompt) the optional `signal` clears the pending
 * entry so it can't leak.
 *
 * Kept dependency-free (no SDK import) so it can be unit-tested in isolation.
 */

export type Decision = 'allow' | 'deny'

/**
 * A resolved permission decision. For `AskUserQuestion`, an `allow` may carry
 * `answers` (question text → selected option label(s) / custom reply) which the
 * gateway injects into the tool input.
 */
export interface DecisionResult {
  decision: Decision
  answers?: Record<string, string>
  /**
   * The authenticated subject that approved this decision (the responding
   * connection's `conn.subject`), server-authoritative and never sourced from the
   * client message body, so a consumer can attribute the decision to a human;
   * `null` / absent when unauthenticated or auth is disabled.
   */
  actor?: string | null
}

/**
 * An `allow` with answers may carry an answer validator (registered by
 * `waitForAskAnswers`). A rejected answer keeps the request pending so the user
 * can correct it and resubmit — it must NOT resolve the waiter, which would let
 * the run resume with a half answer.
 */
interface PendingApproval {
  resolve: (r: DecisionResult) => void
  validate?: (answers?: Record<string, string>) => { ok: true } | { ok: false; error: string }
}

/** Whether `resolveDecision` settled the request, rejected it, or never knew it. */
export type DecisionResolveStatus = 'resolved' | 'rejected' | 'stale'

export interface DecisionResolveResult {
  status: DecisionResolveStatus
  /** Present when `status === 'rejected'`: the human-readable reason to show. */
  rejected?: string
}

// Map<requestId, resolver>. Resolved by the WS handler, or cleared on abort.
const pendingApprovals = new Map<string, PendingApproval>()

/**
 * Register a pending permission request and return a promise that resolves with
 * the user's decision. It never resolves on its own — it waits as long as the
 * user takes, mirroring the CLI's blocking permission prompt.
 *
 * If `signal` is provided and fires before a decision arrives, the pending entry
 * is removed and the promise resolves to `'deny'` (the run is already being torn
 * down, so the decision is moot).
 */
export function waitForDecision(requestId: string, signal?: AbortSignal): Promise<DecisionResult> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve({ decision: 'deny' })
      return
    }
    const onAbort = () => {
      pendingApprovals.delete(requestId)
      resolve({ decision: 'deny' })
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    pendingApprovals.set(requestId, {
      resolve: (r) => {
        signal?.removeEventListener('abort', onAbort)
        pendingApprovals.delete(requestId)
        resolve(r)
      },
    })
  })
}

/**
 * Register a pending ASK request whose `allow` answers are re-validated
 * server-side before the waiter resolves. On an invalid answer the promise keeps
 * waiting (the request stays pending and the user can resubmit); the rejection
 * reason is surfaced through {@link resolveDecision}'s result so the WS handler
 * can show it. `deny` is never validated.
 */
export function waitForAskAnswers(
  requestId: string,
  validate: (answers?: Record<string, string>) => { ok: true } | { ok: false; error: string },
  signal?: AbortSignal,
): Promise<DecisionResult> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve({ decision: 'deny' })
      return
    }
    const onAbort = () => {
      pendingApprovals.delete(requestId)
      resolve({ decision: 'deny' })
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    pendingApprovals.set(requestId, {
      validate,
      resolve: (r) => {
        signal?.removeEventListener('abort', onAbort)
        pendingApprovals.delete(requestId)
        resolve(r)
      },
    })
  })
}

/**
 * Resolve a pending request with the given decision (and optional answers for an
 * ask tool). A rejected `allow` leaves the entry registered so the user can
 * correct the answers and resubmit; a `stale` id was never (or no longer)
 * pending. Callers decide whether to clear the run's pending guard and the
 * wait-user event status from the returned status.
 */
export function resolveDecision(
  requestId: string,
  decision: Decision,
  answers?: Record<string, string>,
  actor?: string | null,
): DecisionResolveResult {
  const pending = pendingApprovals.get(requestId)
  if (!pending) return { status: 'stale' }
  // An `allow` with a validator re-checks the answer before the waiter resolves.
  // A rejected answer must not consume the entry: the request stays answerable.
  if (decision === 'allow' && pending.validate) {
    const check = pending.validate(answers)
    if (!check.ok) return { status: 'rejected', rejected: check.error }
  }
  pending.resolve({ decision, answers, actor })
  return { status: 'resolved' }
}

/** Number of in-flight permission requests. Exposed for tests/diagnostics. */
export function pendingCount(): number {
  return pendingApprovals.size
}

/**
 * The thin adapter the `permissions` feature handler calls to resolve a pending
 * request from a browser `permission_response`. Kept as a named object so the
 * feature wires to `kernel/permission` (the chokepoint) rather than reaching for
 * `resolveDecision` directly.
 */
export const registerPermissionResolver = {
  resolve(
    requestId: string,
    decision: Decision,
    answers?: Record<string, string>,
    actor?: string | null,
  ): DecisionResolveResult {
    return resolveDecision(requestId, decision, answers, actor)
  },
}
