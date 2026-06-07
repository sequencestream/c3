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
import type {
  AdapterCapability,
  VendorHostStatus,
  SessionCapabilities,
  SkillSupportState,
  VendorId,
  VendorModeCatalog,
} from '@ccc/shared/protocol'
import { MODE_CATALOGS } from '../../kernel/agent/adapters/index.js'
import {
  getSessionBindingStats,
  loadProjectConfig,
  loadSettings,
  saveProjectConfig,
  saveSettings,
} from '../../kernel/config/index.js'
import { probeAll } from '../../kernel/agent/process/launcher.js'
import { VENDOR_CAPABILITIES } from '../../kernel/agent/adapters/capabilities.js'
import { getOpencodeStatus } from '../../opencode-status.js'
import { getSkillSupport } from '../../state.js'
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

/**
 * Each vendor's binary {@link AdapterCapability} ledger, mirrored from the kernel
 * `AdapterCapabilities`. The console gates capability-bound UI by `vendor` (e.g. the
 * task panel by `taskStore`) with **zero `if (vendor === …)`**, the same pattern as
 * `sessionCapabilities`. `sessions` is dropped (sent separately, structured); what
 * remains IS the binary ledger, pinned key-for-key to the wire enum by the assertion
 * in `adapters/types.ts`, so it is structurally a `Record<AdapterCapability, boolean>`.
 */
function vendorCapabilities(): Record<VendorId, Record<AdapterCapability, boolean>> {
  const out = {} as Record<VendorId, Record<AdapterCapability, boolean>>
  for (const v of Object.keys(VENDOR_CAPABILITIES) as VendorId[]) {
    const { sessions: _sessions, ...binary } = VENDOR_CAPABILITIES[v]
    out[v] = binary
  }
  return out
}

/**
 * Each vendor's external-skill mount support (ADR-0016/0017). Probed and cached by
 * `detectSkillSupport()` in the mount layer (2/3). Returns a `Record<VendorId, SkillSupportState>`
 * with every registered vendor; unprobed vendors default to `'full'` (the UI shows no greying).
 * Absent entirely when the mount layer hasn't probed any vendor (the `settings` companion is
 * marked optional so older clients ignore it).
 */
function skillSupport(): Record<VendorId, SkillSupportState> | undefined {
  const out = {} as Record<VendorId, SkillSupportState>
  let anyProbed = false
  for (const v of Object.keys(VENDOR_CAPABILITIES) as VendorId[]) {
    const report = getSkillSupport(v)
    if (report) {
      anyProbed = true
      out[v] = report.state
    } else {
      // Unprobed vendor: default to 'full' so the UI doesn't grey it prematurely.
      out[v] = 'full'
    }
  }
  return anyProbed ? out : undefined
}

/**
 * Each vendor's {@link VendorModeCatalog} (2026-06-07-012) — the ordered native
 * mode tokens + i18n label codes the console's mode picker renders by `vendor`.
 * A static mirror of the kernel `MODE_CATALOGS`; the web reads the active session's
 * vendor catalog to label modes and build the dropdown, the SAME by-`vendor`,
 * no-`if (vendor === …)` pattern as the capability ledgers above.
 */
function vendorModes(): Record<VendorId, VendorModeCatalog> {
  return MODE_CATALOGS
}

export const getSettings: Handler<'get_settings'> = (_ctx, conn) => {
  conn.send({
    type: 'settings',
    settings: loadSettings(),
    hostStatus: hostStatus(),
    bindingStats: getSessionBindingStats(),
    sessionCapabilities: sessionCapabilities(),
    vendorCapabilities: vendorCapabilities(),
    skillSupport: skillSupport(),
    vendorModes: vendorModes(),
  })
}

export const saveSettingsHandler: Handler<'save_settings'> = (_ctx, conn, msg) => {
  conn.send({
    type: 'settings',
    settings: saveSettings(msg.settings),
    hostStatus: hostStatus(),
    bindingStats: getSessionBindingStats(),
    sessionCapabilities: sessionCapabilities(),
    vendorCapabilities: vendorCapabilities(),
    skillSupport: skillSupport(),
    vendorModes: vendorModes(),
  })
}

export const loadProjectConfigHandler: Handler<'load_project_config'> = (_ctx, conn, msg) => {
  const config = loadProjectConfig(msg.projectPath)
  conn.send({ type: 'project_config', projectPath: msg.projectPath, config })
}

export const saveProjectConfigHandler: Handler<'save_project_config'> = (_ctx, conn, msg) => {
  // Validate per-vendor defaultModes against their catalogs (2026-06-07-017).
  const defaultModes = msg.config.defaultMode
  if (defaultModes && typeof defaultModes === 'object') {
    for (const [vendorId, token] of Object.entries(defaultModes)) {
      const vendor = vendorId as VendorId
      const cat = MODE_CATALOGS[vendor]
      if (cat && (typeof token !== 'string' || !cat.modes.some((m) => m.token === token))) {
        conn.send({
          type: 'error',
          error: {
            code: 'projectConfig.invalidDefaultMode',
            params: { vendor: vendorId, mode: String(token) },
          },
        })
        return
      }
    }
  }

  const config = saveProjectConfig(msg.projectPath, msg.config)
  conn.send({ type: 'project_config', projectPath: msg.projectPath, config })
}
