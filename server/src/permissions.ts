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

// Map<requestId, resolver>. Resolved by the WS handler, or cleared on abort.
const pendingApprovals = new Map<string, (d: Decision) => void>()

/**
 * Register a pending permission request and return a promise that resolves with
 * the user's decision. It never resolves on its own — it waits as long as the
 * user takes, mirroring the CLI's blocking permission prompt.
 *
 * If `signal` is provided and fires before a decision arrives, the pending entry
 * is removed and the promise resolves to `'deny'` (the run is already being torn
 * down, so the decision is moot).
 */
export function waitForDecision(requestId: string, signal?: AbortSignal): Promise<Decision> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve('deny')
      return
    }
    const onAbort = () => {
      pendingApprovals.delete(requestId)
      resolve('deny')
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    pendingApprovals.set(requestId, (d) => {
      signal?.removeEventListener('abort', onAbort)
      pendingApprovals.delete(requestId)
      resolve(d)
    })
  })
}

/**
 * Resolve a pending request with the given decision. Returns `true` if a pending
 * request existed for `requestId`, `false` otherwise (unknown/stale id).
 */
export function resolveDecision(requestId: string, decision: Decision): boolean {
  const resolver = pendingApprovals.get(requestId)
  if (!resolver) return false
  resolver(decision)
  return true
}

/** Number of in-flight permission requests. Exposed for tests/diagnostics. */
export function pendingCount(): number {
  return pendingApprovals.size
}
