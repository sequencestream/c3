/**
 * Claude's probed capability ledger (ADR-0011). Every flag is TRUE — the Claude
 * Agent SDK natively supports all seven divergent capabilities the abstraction
 * models. This is the *vendor* ability, the thing the upper layer probes before
 * reaching for an optional control; the {@link import('./driver.js').ClaudeDriver}
 * additionally wires the run-level controls it can reach in this additive phase
 * (interrupt / setActionMode / pushInput), and exposes a method only when it is
 * actually wired (so `typeof run.method === 'function'` is the second, build-time
 * probe layered under this vendor flag — see ADR-0011 §Probe protocol).
 *
 * The structured {@link AdapterCapabilities.sessions} sub-ledger (ADR-0011
 * amendment) is likewise all `full`: every session-lifecycle op is faithfully
 * supported — JSONL back-read off disk, native rename/delete via `sessions.ts`,
 * SDK resume — with no degradation caveat. Claude is the reference for every state.
 */
import type { AdapterCapabilities } from '../types.js'

export const claudeCapabilities: AdapterCapabilities = {
  interrupt: true,
  setActionMode: true,
  streamingPush: true,
  inProcessMcp: true,
  forkSession: true,
  perToolApproval: true,
  taskStore: true,
  sessions: {
    list: 'full',
    read: 'full',
    resume: 'full',
    rename: 'full',
    delete: 'full',
  },
}
