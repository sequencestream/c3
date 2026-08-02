/**
 * Cursor's {@link ApprovalBridge} — a structural no-op. c3 runs
 * `cursor-agent -p` non-interactively and reads a one-way NDJSON stream: there is
 * no event that asks for permission and no channel to answer one on. So
 * `onRequest` honours the required contract (registers a handler, returns a
 * working disposer — `assertNeutralAdapterShape` checks exactly this) while the
 * handler never fires, because nothing can fire it.
 *
 * Approval is degraded to the launch-time gate the driver applies: either the run
 * carries `--force` and every tool executes unattended, or the user's own
 * `~/.cursor` allowlist decides. That is what `perToolApproval: false` in the
 * capability ledger declares, and this bridge is the honest shape of that fact.
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
