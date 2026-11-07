/**
 * DSH capability ledger — JSON-RPC SDK subprocess (`dsh --profile sdk`).
 *
 * Per-tool approval is wired when the client enables `approvalRequests` and handles
 * `approval/request`. There is no wire cancel: `stop_run` maps to subprocess shutdown
 * (whole-turn), like Cursor's kill. Agent Teams / subagent orchestration is not
 * surfaced; subagent notifications are ignored for transcript mapping.
 */
import type { AdapterCapabilities } from '../types.js'

export const dshCapabilities: AdapterCapabilities = {
  interrupt: false,
  setActionMode: false,
  streamingPush: false,
  inProcessMcp: false,
  forkSession: false,
  perToolApproval: true,
  taskStore: false,
  nativeUserInput: true,
  sessions: {
    list: 'partial',
    read: 'partial',
    resume: 'full',
    rename: 'none',
    delete: 'none',
  },
}

/** DSH package + SDK versions this adapter is written against (Issue #506). */
export const DSH_SUPPORTED_PACKAGE_VERSION = '0.2.2-rc.1'

/** Minimum Node.js major.minor for the `dsh` CLI (`engines.node` on @deepseek-ai/dsh). */
export const DSH_MIN_NODE = { major: 24, minor: 9 } as const
