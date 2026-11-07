/**
 * DSH approval bridge — maps `approval/request` JSON-RPC host requests to the
 * neutral {@link ApprovalBridge}.
 */
import type { ApprovalBridge, ApprovalDecision, ApprovalHandler, Disposer } from '../types.js'

export type DshApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled'

export class DshApprovalBridge implements ApprovalBridge {
  private handler: ApprovalHandler | null = null

  onRequest(handler: ApprovalHandler): Disposer {
    this.handler = handler
    return () => {
      if (this.handler === handler) this.handler = null
    }
  }

  /**
   * Resolve one harness approval request. Rejects closed when no handler is set
   * or the run is already aborted.
   */
  async resolveApproval(
    toolName: string,
    input: unknown,
    signal: AbortSignal,
  ): Promise<DshApprovalOutcome> {
    if (signal.aborted) return 'cancelled'
    if (!this.handler) return 'rejected'
    const requestId = `dsh-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const decision: ApprovalDecision = await this.handler({ requestId, toolName, input })
    if (signal.aborted) return 'cancelled'
    return decision.behavior === 'allow' ? 'allowed-once' : 'rejected'
  }
}
