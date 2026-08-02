/**
 * Cursor's probed capability ledger (ADR-0011). c3 drives `@cursor/sdk`'s local
 * runtime: `Agent.create` → `send` → an async `Run.stream()`. The stream is
 * read-only and single-directional, so the whole of c3's run-time control is
 * "start it" and "cancel it" — every live-run control below is `false`, and each
 * stays false until a probe proves otherwise rather than being assumed from
 * another vendor's shape.
 *
 * `perToolApproval: false` is the load-bearing one: the permission decision is
 * fixed when the turn starts (the conversation mode + whether Cursor's
 * Auto-review classifier vets calls), so a tool can only be allowed or vetted for
 * the whole turn, never per call — nothing in the SDK can pause a run to ask a
 * human.
 *
 * `interrupt: false` is narrower than it looks: `Run.cancel()` exists and is a
 * real cooperative stop, but it ends the turn. There is no way to interject and
 * have the same run continue, which is what this flag means.
 *
 * `inProcessMcp: false` is a c3-side fact, not an SDK limitation. The SDK does
 * offer in-process callback tools (`local.customTools`, surfaced to the model as
 * a synthetic MCP server), but c3 does not wire its own tools through them yet;
 * the flag flips when that is built, not before.
 *
 * `taskStore` is false: the SDK has no task API — its `updateTodos` tool is a
 * conversation-local bookkeeping call, not a store c3 can read or write.
 * `nativeUserInput` is false: a headless run never asks the human anything;
 * human involvement degrades to c3's own flows.
 *
 * The structured {@link AdapterCapabilities.sessions} sub-ledger is the honest
 * split between what the SDK's store guarantees and what it does not cover:
 * `resume` is `'full'` — `Agent.resume(agentId)` restores native context, and the
 * id is minted by the SDK itself so it can never be fabricated. `list`/`read` are
 * `'partial'`: they are served from the SDK's own local agent store, which holds
 * exactly the agents created through the SDK and silently misses anything the
 * user ran in the Cursor IDE or the `cursor-agent` CLI. That is a genuine
 * reduction, and `'partial'` is the state that says so without either
 * overclaiming (`'full'`) or hiding the affordance (`'none'`). `rename`/`delete`
 * are `'none'`: the SDK exposes neither for local agents, and c3 must not pretend
 * to mutate a store it does not own.
 */
import type { AdapterCapabilities } from '../types.js'

export const cursorCapabilities: AdapterCapabilities = {
  interrupt: false,
  setActionMode: false,
  streamingPush: false,
  inProcessMcp: false,
  forkSession: false,
  perToolApproval: false,
  taskStore: false,
  nativeUserInput: false,
  sessions: {
    list: 'partial',
    read: 'partial',
    resume: 'full',
    rename: 'none',
    delete: 'none',
  },
}
