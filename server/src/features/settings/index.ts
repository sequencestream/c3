/**
 * `settings` feature handlers — slice 1/3 (ADR-0009).
 *
 * Beyond the persisted {@link SystemSettings}, every `settings` reply carries two
 * runtime-derived companions the config object itself does not hold:
 *  - `hostStatus` — each vendor's host-CLI presence (ADR-0012), probed via the
 *    ProcessLauncher, so the console can grey out an agent whose binary is not on
 *    PATH and show the resolved absolute path of each installed binary.
 *  - `bindingStats` — the session→agent binding counts (ADR-0015), so the console
 *    can show that a default-agent change is not retroactive.
 */
import type {
  AdapterCapability,
  SystemSettings,
  VendorHostStatus,
  SessionCapabilities,
  SkillSupportState,
  VendorId,
  VendorModeCatalog,
} from '@ccc/shared/protocol'
import { MODE_CATALOGS } from '../../kernel/agent/adapters/index.js'
import { resolveWorkspaceRoot, pathToId } from '../../state.js'
import {
  getSessionBindingStats,
  loadSettings,
  loadWorkspaceSetting,
  saveSettings,
  saveWorkspaceSetting,
} from '../../kernel/config/index.js'
import { detectDefaultBranch } from '../intents/worktree.js'
import { probeAll } from '../../kernel/agent/process/launcher.js'
import { VENDOR_CAPABILITIES } from '../../kernel/agent/adapters/capabilities.js'
import { getSkillSupport } from '../../state.js'
import type { Handler } from '../../transport/handler-registry.js'

/** Map the ProcessLauncher probe into the wire shape (carrying the resolved path). */
function hostStatus(): VendorHostStatus[] {
  return probeAll().map((p) => ({
    vendor: p.vendor,
    present: p.path !== null,
    binary: p.binary,
    path: p.path,
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

/**
 * The `basic` admin password hash is owned SOLELY by `set_admin_password`
 * (ADR-0023 runtime slice): a generic settings save must never overwrite — or
 * worse, wipe — it, even if the client round-trips a stale/empty hash. Force the
 * persisted hash back to the on-disk value so the password survives any
 * `save_settings` (enabled/username/exposure toggles flow through unchanged).
 */
function preserveAdminPasswordHash(next: SystemSettings): SystemSettings {
  if (next.auth?.provider.kind !== 'basic') return next
  const diskProvider = loadSettings().auth?.provider
  const diskHash = diskProvider?.kind === 'basic' ? diskProvider.passwordHash : ''
  return {
    ...next,
    auth: { ...next.auth, provider: { ...next.auth.provider, passwordHash: diskHash } },
  }
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
    settings: saveSettings(preserveAdminPasswordHash(msg.settings)),
    hostStatus: hostStatus(),
    bindingStats: getSessionBindingStats(),
    sessionCapabilities: sessionCapabilities(),
    vendorCapabilities: vendorCapabilities(),
    skillSupport: skillSupport(),
    vendorModes: vendorModes(),
  })
}

export const loadWorkspaceSettingHandler: Handler<'load_workspace_setting'> = (_ctx, conn, msg) => {
  const proj = resolveWorkspaceRoot(msg.workspaceId)
  if (!proj) {
    conn.send({
      type: 'error',
      error: { code: 'workspace.unknown', params: { workspaceId: msg.workspaceId } },
    })
    return
  }
  const config = loadWorkspaceSetting(proj)
  // Probe the repo's default branch so the form can pre-fill `defaultMainBranch`
  // (origin/HEAD → current HEAD; undefined when unresolvable).
  const detectedMainBranch = detectDefaultBranch(proj)
  conn.send({
    type: 'workspace_setting',
    workspaceId: pathToId(proj)!,
    config,
    detectedMainBranch,
  })
}

export const saveWorkspaceSettingHandler: Handler<'save_workspace_setting'> = (_ctx, conn, msg) => {
  const proj = resolveWorkspaceRoot(msg.workspaceId)
  if (!proj) {
    conn.send({
      type: 'error',
      error: { code: 'workspace.unknown', params: { workspaceId: msg.workspaceId } },
    })
    return
  }
  // Validate per-vendor defaultModes against their catalogs (2026-06-07-017).
  const defaultModes = msg.config.defaultMode
  if (defaultModes && typeof defaultModes === 'object') {
    for (const [vendorId, token] of Object.entries(defaultModes)) {
      const vendor = vendorId as VendorId
      // CodexPolicy objects — skip token-based catalog check (2026-06-08).
      if (typeof token === 'object' && token !== null && 'sandboxMode' in token) continue
      const cat = MODE_CATALOGS[vendor]
      if (cat && (typeof token !== 'string' || !cat.modes.some((m) => m.token === token))) {
        conn.send({
          type: 'error',
          error: {
            code: 'workspaceSetting.invalidDefaultMode',
            params: { vendor: vendorId, mode: String(token) },
          },
        })
        return
      }
    }
  }

  const config = saveWorkspaceSetting(proj, msg.config)
  conn.send({ type: 'workspace_setting', workspaceId: pathToId(proj)!, config })
}
