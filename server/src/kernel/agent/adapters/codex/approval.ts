/**
 * Codex's {@link ApprovalBridge} — a structural no-op (008 NO-GO, 2026-06-06-005).
 * Codex has NO in-the-loop, per-tool approval point: c3 runs `codex exec`
 * non-interactively, closes the child's stdin after dispatch, and reads only a
 * read-only event stream. So `onRequest` honours the required contract (registers
 * a handler, returns a working disposer — `assertNeutralAdapterShape` checks this)
 * but the handler **never fires**: there is no event that would call it. Approval
 * is degraded to the launch-time `sandboxMode` + `approvalPolicy` gate the
 * {@link import('./driver.js').CodexDriver} applies at `startThread`.
 *
 * MCP-approval fallback (Phase 0 §4 escape hatch 2) — SKELETON ONLY, default OFF.
 * The "fifth path" idea: expose c3 as an MCP server with a `c3_request_approval`
 * tool, register it with Codex, and prompt-engineer "call the approval tool before
 * acting". Phase 0 already judged this a NARROW lever — it can only gate tools that
 * route through c3's MCP server, never Codex's built-in `shell`/`apply_patch`, and
 * its reliability rests on the model's compliance. So it is intentionally left as a
 * closed extension point (the flag + the wiring seam), NOT wired to a prompt loop
 * in this phase. Flipping {@link CodexApprovalOptions.mcpFallback} on today changes
 * nothing observable; turning it into a real channel is a separate intent.
 */
import type { ApprovalBridge, ApprovalHandler, Disposer } from '../types.js'

/** Tunables for the (skeleton) Codex approval bridge. */
export interface CodexApprovalOptions {
  /**
   * Enable the MCP-approval fallback (Phase 0 §4). SKELETON: even when true, no
   * prompt loop is wired yet — this is the seam a later intent builds on. The
   * handler still never fires for Codex's built-in tools, by construction.
   */
  mcpFallback?: boolean
}

export class CodexApprovalBridge implements ApprovalBridge {
  /** Registered handler. Held for contract compliance; never invoked (no approval event exists). */
  private handler: ApprovalHandler | null = null
  /** Reserved seam for the MCP-approval fallback (Phase 0 §4); inert in this phase. */
  readonly mcpFallback: boolean

  constructor(opts: CodexApprovalOptions = {}) {
    this.mcpFallback = opts.mcpFallback ?? false
  }

  onRequest(handler: ApprovalHandler): Disposer {
    this.handler = handler
    return () => {
      if (this.handler === handler) this.handler = null
    }
  }
}
