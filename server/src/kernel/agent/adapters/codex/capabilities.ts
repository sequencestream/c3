/**
 * Codex's probed capability ledger (ADR-0011, Phase 0 probe 008 NO-GO,
 * 2026-06-06-005). **Every flag is FALSE** — and the load-bearing one is
 * `perToolApproval: false`: the `@openai/codex-sdk` drives `codex exec
 * --experimental-json`, writes the prompt to the child's stdin and immediately
 * `stdin.end()`s it, so the event stream is read-only and single-directional —
 * there is no write-back half-channel, no "approval request" event, and the only
 * runtime intervention is a whole-turn `AbortSignal`. A tool can therefore only
 * be allowed/denied for the *entire* turn, never per-call.
 *
 * The rest are FALSE for the same structural reason (no in-the-loop point exists):
 * no mid-turn `interrupt` (only whole-turn abort), no live `setActionMode`
 * (sandbox/approvalPolicy are launch-time, fixed at `startThread`), no
 * `streamingPush` (stdin closes after dispatch), no in-process MCP server, and no
 * `forkSession` (Phase 0 killed the per-tool-approval branch that would have used
 * `resumeThread` as a fork; `resumeThread` instead serves the neutral
 * {@link import('../types.js').DriverStartOptions} `resume`, which is session
 * *resume*, not fork).
 *
 * This ledger is the honest contract the upper layer probes: Codex is c3's
 * read-only advisor seat — launch-time sandbox/policy gate + run-time read-only
 * monitor + whole-turn abort. See `changes/.../008-codex-approval-probe/conclusion.md`.
 */
import type { AdapterCapabilities } from '../types.js'

export const codexCapabilities: AdapterCapabilities = {
  interrupt: false,
  setActionMode: false,
  streamingPush: false,
  inProcessMcp: false,
  forkSession: false,
  perToolApproval: false,
}
