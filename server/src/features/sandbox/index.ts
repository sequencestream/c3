/**
 * `sandbox` feature handler.
 *
 * Resolves a pending sandbox-conflict decision: when a sandbox run's bound agent is
 * `system`-mode (unusable inside the arapuca sandbox), `launchRun` broadcasts a
 * `sandbox_conflict_request` and blocks on `waitForSandboxDecision`. The browser's
 * `sandbox_conflict_response` (bypass / switch / cancel) unblocks it here.
 */
import { resolveSandboxDecision } from '../../kernel/sandbox/conflict-registry.js'
import type { Handler } from '../../transport/handler-registry.js'

export const sandboxConflictResponse: Handler<'sandbox_conflict_response'> = (_ctx, _conn, msg) => {
  resolveSandboxDecision(msg.requestId, msg.choice, msg.agentId)
}
