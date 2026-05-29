/**
 * Permission-decision registry shared between the WS handler and the Claude run loop.
 *
 * `canUseTool` (in claude.ts) calls `waitForDecision(requestId)` and awaits the
 * returned promise. The WS handler calls `resolveDecision(requestId, decision)`
 * when a `permission_response` arrives from the browser. If no response comes
 * within the timeout, the request auto-denies.
 *
 * Kept dependency-free (no SDK import) so it can be unit-tested in isolation.
 */

export type Decision = 'allow' | 'deny'

export const PERMISSION_TIMEOUT_MS = 60_000

// Map<requestId, resolver>. Resolved by the WS handler or by the timeout.
const pendingApprovals = new Map<string, (d: Decision) => void>()

/**
 * Register a pending permission request and return a promise that resolves with
 * the user's decision, or `'deny'` if `timeoutMs` elapses first.
 */
export function waitForDecision(
  requestId: string,
  timeoutMs: number = PERMISSION_TIMEOUT_MS,
): Promise<Decision> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingApprovals.delete(requestId)
      resolve('deny')
    }, timeoutMs)
    pendingApprovals.set(requestId, (d) => {
      clearTimeout(timer)
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
