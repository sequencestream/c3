/**
 * OpenCode's probed capability ledger (ADR-0011, 2026-06-06-003). The load-bearing
 * flag is `perToolApproval: true` — OpenCode gates each tool out-of-loop via a
 * `permission.updated` event + REST write-back (009 GO), which the
 * {@link import('./approval.js').OpencodeApprovalBridge} drives.
 *
 * The rest are FALSE on purpose. They are kept conservative to the controls this
 * phase actually wires (the safe direction ADR-0011 pins is "a method present ⇒
 * its flag is true"): the driver exposes no `interrupt` (OpenCode only has
 * whole-turn `session.abort`), no live `setActionMode`, no `pushInput`, no
 * in-process MCP, and does not wire `forkSession` (the REST `session.fork` exists
 * but is out of scope here). A later phase can flip a flag the moment it wires the
 * matching `AgentRun` method.
 *
 * The structured {@link AdapterCapabilities.sessions} sub-ledger (ADR-0011
 * amendment) is where OpenCode exercises `temporarily-unavailable`: `list`/`read`
 * are `full` (the REST `session.list`/`session.messages` the
 * {@link import('./session-store.js').OpencodeSessionStore} reads), `resume` is
 * `full`, but `rename`/`delete` are `temporarily-unavailable` — the OpenCode
 * server owns those write-paths and this phase has not wired them, so they are not
 * structurally absent (`none`, like Codex) but not currently reachable either.
 * The honest middle state: flip to `full` the moment the REST write-path is wired.
 */
import type { AdapterCapabilities } from '../types.js'

export const opencodeCapabilities: AdapterCapabilities = {
  interrupt: false,
  setActionMode: false,
  streamingPush: false,
  inProcessMcp: false,
  forkSession: false,
  perToolApproval: true,
  sessions: {
    list: 'full',
    read: 'full',
    resume: 'full',
    rename: 'temporarily-unavailable',
    delete: 'temporarily-unavailable',
  },
}
