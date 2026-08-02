/**
 * Cursor's probed capability ledger (ADR-0011). c3 drives
 * `cursor-agent -p --output-format stream-json`: the prompt is an argv value and
 * the NDJSON stream is read-only and single-directional. There is no write-back
 * half-channel, so the only run-time intervention is a whole-turn abort — every
 * live-run control below is `false`, and each stays false until a probe proves
 * otherwise rather than being assumed from another vendor's shape.
 *
 * `perToolApproval: false` is the load-bearing one: the permission policy is
 * fixed at launch (the `--force` / allowlist decision), so a tool can only be
 * allowed or denied for the whole turn, never per call. `inProcessMcp` is false
 * for a different reason than "MCP does not work" — MCP demonstrably does work,
 * but only as an *external* server the CLI connects to over HTTP, never hosted
 * inside c3's process.
 *
 * `taskStore` is false: the stream carries no todo/task items, so there is no
 * neutral task model to project. `nativeUserInput` is false: a `-p` run never
 * asks the human anything; human involvement degrades to c3's own flows.
 *
 * The structured {@link AdapterCapabilities.sessions} sub-ledger is the honest
 * split between what Cursor's own store guarantees and what c3 merely mirrors:
 * `resume` is `'full'` — the blocking probe proved `--resume <session_id>`
 * restores native context end-to-end, including after the run is killed mid-turn.
 * `list`/`read` are `'partial'`: they are served from c3's own canonical mirror,
 * not from Cursor's store, so they show exactly the turns c3 itself observed and
 * silently miss anything the user ran in the Cursor IDE or another client. That
 * is a genuine reduction, and `'partial'` is the state that says so without
 * either overclaiming (`'full'`) or hiding the affordance (`'none'`).
 * `rename`/`delete` are `'none'`: the CLI exposes neither, and c3 must not
 * pretend to mutate a store it does not own.
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
