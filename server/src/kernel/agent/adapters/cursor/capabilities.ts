/**
 * Cursor's probed capability ledger.
 *
 * c3 drives `cursor-agent` as a non-interactive per-turn process: the prompt goes
 * in on stdin, stdin closes, and what comes back is a one-directional stream of
 * frames. **Every live-run control is therefore false**, and the load-bearing one
 * is `perToolApproval`: there is no write-back channel, no approval-request frame
 * and no way to pause a turn to ask a human, so a tool can only be allowed or
 * vetted for the whole turn — by the launch-time gate — never call by call.
 *
 * The rest are false for the same structural reason: no mid-turn `interrupt`
 * (only a whole-turn kill), no live `setActionMode` (the mode is argv, fixed at
 * launch), no `streamingPush` (stdin closes after dispatch), no in-process MCP
 * server, and no `forkSession`. `taskStore` is false because the todo tool is
 * conversation-local bookkeeping, not a store c3 can read or write.
 * `nativeUserInput` is false because a headless run never asks the human
 * anything; human involvement degrades to c3's own flows.
 *
 * The session sub-ledger is `full` across the operations c3 supports. Sessions
 * live in Cursor's own on-disk chat store, which the CLI and the Cursor IDE both
 * write, so `list` and `read` cover the workspace's whole history rather than the
 * subset c3 created. `resume` continues a chat by an id Cursor itself minted, so
 * it can never be a fabrication. `rename`/`delete` are `none`: this is the user's
 * IDE data, and c3 does not mutate a store it does not own.
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
    list: 'full',
    read: 'full',
    resume: 'full',
    rename: 'none',
    delete: 'none',
  },
}
