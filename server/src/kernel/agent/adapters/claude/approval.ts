/**
 * Claude's {@link ApprovalBridge} — the in-the-loop, per-tool approval channel
 * (intercept → suspend → write back), the reference for `perToolApproval: true`.
 *
 * Claude's interception point is the SDK's blocking `canUseTool` callback: the
 * run halts inside it until c3 returns a verdict, so "write back" is simply
 * resolving the promise. {@link ClaudeApprovalBridge.decide} is the function a
 * driver hands to that callback; it routes the request through the registered
 * neutral handler and translates the {@link ApprovalDecision} into the branded
 * {@link PermissionDecision} the SDK accepts (the only place adapter code mints a
 * verdict — via the kernel `allow`/`deny`, never a bare object). In this additive
 * phase `runClaude` still drives the live gateway directly; this bridge is the
 * interface-conformant reference the AgentDriver-rewrite phase folds in.
 */
import type { ApprovalBridge, ApprovalDecision, ApprovalHandler, Disposer } from '../types.js'
import { allow, deny, type PermissionDecision } from '../../../permission/index.js'

export class ClaudeApprovalBridge implements ApprovalBridge {
  private handler: ApprovalHandler | null = null

  onRequest(handler: ApprovalHandler): Disposer {
    this.handler = handler
    return () => {
      if (this.handler === handler) this.handler = null
    }
  }

  /**
   * Resolve one tool call to a branded SDK verdict by routing through the
   * registered handler. With no handler registered the bridge default-denies
   * (PG-R4 default-deny is structural). The `requestId` is c3-minted upstream.
   */
  async decide(requestId: string, toolName: string, input: unknown): Promise<PermissionDecision> {
    if (!this.handler) return deny('no approval handler registered')
    const decision: ApprovalDecision = await this.handler({ requestId, toolName, input })
    return decision.behavior === 'allow' ? allow(decision.updatedInput) : deny(decision.reason)
  }
}
