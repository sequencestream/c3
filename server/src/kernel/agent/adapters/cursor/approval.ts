/**
 * Cursor's {@link ApprovalBridge} — a structural no-op. c3 drives the Cursor SDK
 * headlessly and reads a one-way message stream: there is no event that asks for
 * permission and no channel to answer one on. So `onRequest` honours the required
 * contract (registers a handler, returns a working disposer —
 * `assertNeutralAdapterShape` checks exactly this) while the handler never fires,
 * because nothing can fire it.
 *
 * Approval is degraded to the gate the driver fixes when the turn starts: either
 * every tool executes unattended, or Cursor's own Auto-review classifier vets
 * each call. That is what `perToolApproval: false` in the capability ledger
 * declares, and this bridge is the honest shape of that fact.
 */
import type { ApprovalBridge, ApprovalHandler, Disposer } from '../types.js'

export class CursorApprovalBridge implements ApprovalBridge {
  /** Held for contract compliance; never invoked (no approval event exists). */
  private handler: ApprovalHandler | null = null

  onRequest(handler: ApprovalHandler): Disposer {
    this.handler = handler
    return () => {
      if (this.handler === handler) this.handler = null
    }
  }
}
