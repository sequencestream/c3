/**
 * Sandbox-conflict decision registry — the run-launch mirror of the permission
 * registry. When a sandbox run's bound agent is `system`-mode (unusable inside the
 * arapuca sandbox), `launchRun` broadcasts a `sandbox_conflict_request` and awaits
 * `waitForSandboxDecision(requestId)`; the WS handler calls `resolveSandboxDecision`
 * when the browser answers with `sandbox_conflict_response`. The request blocks
 * indefinitely (no timeout) until the user decides, exactly like a permission
 * prompt. Kept dependency-free so it can be unit-tested in isolation.
 */

/** The context a launch hands the composition root to raise the console modal. */
export interface SandboxConflictCtx {
  requestId: string
  sessionId: string
  agentId: string
  agentName: string
  vendor: string
  /** Same-vendor enabled custom agents offered as the "switch" targets. */
  choices: Array<{ id: string; displayName: string }>
}

/** The user's answer: run without the sandbox, switch to a custom agent, or abandon. */
export interface SandboxConflictDecision {
  choice: 'bypass' | 'switch' | 'cancel'
  /** The chosen custom agent id (only for `switch`). */
  agentId?: string
}

// Map<requestId, resolver>. Resolved by the WS handler, or cleared on abort.
const pending = new Map<string, (d: SandboxConflictDecision) => void>()

/**
 * Register a pending sandbox-conflict request and return a promise that resolves
 * with the user's decision. Never resolves on its own — it waits as long as the
 * user takes. If `signal` fires first, the entry is cleared and the promise
 * resolves to `cancel` (the run is being torn down, so the decision is moot).
 */
export function waitForSandboxDecision(
  requestId: string,
  signal?: AbortSignal,
): Promise<SandboxConflictDecision> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve({ choice: 'cancel' })
      return
    }
    const onAbort = () => {
      pending.delete(requestId)
      resolve({ choice: 'cancel' })
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    pending.set(requestId, (d) => {
      signal?.removeEventListener('abort', onAbort)
      pending.delete(requestId)
      resolve(d)
    })
  })
}

/**
 * Resolve a pending request with the user's decision. Returns `true` if a pending
 * request existed for `requestId`, `false` otherwise (unknown/stale id).
 */
export function resolveSandboxDecision(
  requestId: string,
  choice: SandboxConflictDecision['choice'],
  agentId?: string,
): boolean {
  const resolver = pending.get(requestId)
  if (!resolver) return false
  resolver({ choice, agentId })
  return true
}

/** In-flight sandbox-conflict request count. Exposed for tests/diagnostics. */
export function pendingSandboxConflictCount(): number {
  return pending.size
}
