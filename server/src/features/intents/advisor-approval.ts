/**
 * The write-approval gate for the advisor's confirmation-required tools.
 *
 * Structurally the same gate `save_intents` already uses (`save-gate.ts`): land
 * a WorkCenter wait-user-involve event, emit the `permission_request` frame on
 * the advisor's own run, and block on `waitForDecision`. Reusing the shape — not
 * inventing a second approval mechanism — is the point: a human sees advisor
 * write requests in the same place, in the same form, as every other one.
 *
 * What approval does NOT do: relax anything. It answers one question — may this
 * specific write happen — and the caller still re-validates ownership, status
 * and hard gates afterwards. An approval that arrives after the world moved on
 * therefore cannot execute against stale facts.
 *
 * Pure + dependency-injected, so it is testable without the wire or the live
 * permission registry, and so this feature module never imports the transport.
 */
import type { ServerToClient } from '@ccc/shared/protocol'
import type { PermissionRequestCtx } from '../../kernel/permission/index.js'

export interface AdvisorApprovalDeps {
  emit: (runId: string, frame: ServerToClient) => void
  waitForDecision: (
    requestId: string,
    signal?: AbortSignal,
  ) => Promise<{ decision: 'allow' | 'deny'; actor?: string | null }>
  /**
   * WorkCenter event hook — invoked BEFORE the wire frame so the request lands in
   * the pending-items panel, not only in an open chat.
   */
  onPermissionRequest?: (ctx: PermissionRequestCtx) => void
  /** Injected for tests; defaults to `crypto.randomUUID`. */
  makeRequestId?: () => string
}

/** What one approval request describes. */
export interface AdvisorApprovalRequest {
  toolName: string
  workspacePath: string
  intentId: string
  input: unknown
  /** The advisor run the prompt is emitted on. */
  sessionId: string
  /** Aborts the wait when the advisor run tears down. */
  signal?: AbortSignal
}

/**
 * Build the `requestWriteApproval` callback the advisor tool group expects.
 * Resolves `true` only on an explicit `allow`; a deny, an abort, or a torn-down
 * run all resolve `false` — the write never happens on a non-answer.
 */
export function createAdvisorApproval(
  deps: AdvisorApprovalDeps,
): (req: AdvisorApprovalRequest) => Promise<boolean> {
  return async (req) => {
    const requestId = (deps.makeRequestId ?? (() => crypto.randomUUID()))()
    // The tool name is namespaced on the wire so the console renders it exactly
    // like any other c3 MCP tool prompt.
    const toolName = `mcp__c3__${req.toolName}`
    const input = { intentId: req.intentId, ...(req.input as Record<string, unknown>) }
    deps.onPermissionRequest?.({
      requestId,
      toolName,
      input,
      sessionId: req.sessionId,
      workspacePath: req.workspacePath,
      sessionKind: 'work',
    })
    deps.emit(req.sessionId, { type: 'permission_request', requestId, toolName, input })
    const { decision } = await deps.waitForDecision(requestId, req.signal)
    return decision === 'allow'
  }
}
