/**
 * `settings` feature handlers — slice 1/3 (ADR-0009).
 *
 * Beyond the persisted {@link SystemSettings}, every `settings` reply carries two
 * runtime-derived companions the config object itself does not hold:
 *  - `hostStatus` — each vendor's host-CLI presence (ADR-0012), probed via the
 *    ProcessLauncher, so the console can grey out an agent whose binary is not on
 *    PATH. No absolute path is sent (operator guidance only).
 *  - `bindingStats` — the session→agent binding counts (ADR-0015), so the console
 *    can show that a default-agent change is not retroactive.
 */
import type { VendorHostStatus, SessionCapabilities, VendorId } from '@ccc/shared/protocol'
import { getSessionBindingStats, loadSettings, saveSettings } from '../../kernel/config/index.js'
import { probeAll } from '../../kernel/agent/process/launcher.js'
import { VENDOR_CAPABILITIES } from '../../kernel/agent/adapters/capabilities.js'
import { getOpencodeStatus } from '../../opencode-status.js'
import type { Handler } from '../../transport/handler-registry.js'

/** Map the ProcessLauncher probe into the wire shape (drop the absolute path). */
function hostStatus(): VendorHostStatus[] {
  return probeAll().map((p) => ({
    vendor: p.vendor,
    present: p.path !== null,
    binary: p.binary,
    installHint: p.installHint,
  }))
}

/**
 * Each vendor's static session-lifecycle capability ledger (ADR-0011 addendum).
 * The console reads this to render session-row actions by capability *state*
 * (disable/hide rename/delete a vendor cannot do) — with **zero
 * `if (vendor === …)`**. Lives at the top of the `settings` message, orthogonal
 * to the per-vendor `hostStatus` (presence vs ability).
 */
function sessionCapabilities(): Record<VendorId, SessionCapabilities> {
  const out = {} as Record<VendorId, SessionCapabilities>
  for (const v of Object.keys(VENDOR_CAPABILITIES) as VendorId[])
    out[v] = VENDOR_CAPABILITIES[v].sessions
  // Runtime overlay (2026-06-07-003): OpenCode's server-backed lifecycle ops
  // (list/read/resume) are only as reachable as its REST server. While the server
  // is `temporarily-unavailable`, downgrade those grades from the SAME enum the
  // first-class signal uses — so the console degrades opencode rows by state, not
  // by vendor, and recovers automatically once the signal flips back to `full`.
  if (getOpencodeStatus().reachability === 'temporarily-unavailable' && out.opencode) {
    const TU = 'temporarily-unavailable' as const
    out.opencode = { ...out.opencode, list: TU, read: TU, resume: TU }
  }
  return out
}

export const getSettings: Handler<'get_settings'> = (_ctx, conn) => {
  conn.send({
    type: 'settings',
    settings: loadSettings(),
    hostStatus: hostStatus(),
    bindingStats: getSessionBindingStats(),
    sessionCapabilities: sessionCapabilities(),
  })
}

export const saveSettingsHandler: Handler<'save_settings'> = (_ctx, conn, msg) => {
  conn.send({
    type: 'settings',
    settings: saveSettings(msg.settings),
    hostStatus: hostStatus(),
    bindingStats: getSessionBindingStats(),
    sessionCapabilities: sessionCapabilities(),
  })
}
