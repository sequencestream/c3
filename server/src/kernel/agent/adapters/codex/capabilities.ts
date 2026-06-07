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
 *
 * The structured {@link AdapterCapabilities.sessions} sub-ledger (ADR-0011
 * amendment) makes Codex the canonical `none` exemplar: the `@openai/codex-sdk`
 * exposes **no listing or reading API at all**, so `list` and `read` are honest
 * `none` (the {@link import('./session-store.js').CodexSessionStore} returns empty
 * rather than fabricate a transcript shape Phase 0 never observed). `resume` is
 * `full` even though `read` is `none` — `resumeThread(id)` continues a known
 * thread end-to-end; only the *back-read/enumeration* is absent. `rename`/`delete`
 * are `none` (the SDK supports neither). This is the matrix that proves a boolean
 * could not have expressed `read=none ∧ resume=full`.
 */
import type { AdapterCapabilities } from '../types.js'

export const codexCapabilities: AdapterCapabilities = {
  interrupt: false,
  setActionMode: false,
  streamingPush: false,
  inProcessMcp: false,
  forkSession: false,
  perToolApproval: false,
  sessions: {
    list: 'none',
    read: 'none',
    resume: 'full',
    rename: 'none',
    delete: 'none',
  },
}
