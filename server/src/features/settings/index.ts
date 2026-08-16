/**
 * `settings` feature handlers — slice 1/3 (ADR-0009).
 *
 * Beyond the persisted {@link SystemSettings}, every `settings` reply carries
 * runtime-derived companions the config object itself does not hold:
 *  - `hostStatus` — each vendor's host-CLI presence (ADR-0012), probed via the
 *    ProcessLauncher, so the console can show the resolved absolute path of each
 *    installed binary. It speaks about CLIs only — never about vendors that have none.
 *  - `vendorRuntime` — the neutral "can c3 run this vendor" signal, answered for
 *    EVERY vendor whatever backs it, which is what the console gates on so no
 *    caller has to know which vendors are CLIs and which are in-process SDKs.
 *  - `bindingStats` — the session→agent binding counts (ADR-0015), so the console
 *    can show that a default-agent change is not retroactive.
 *  - `dbPath` — the absolute path of the c3 database actually in effect, which is
 *    where all configuration lives (path only, no content), so a client can tell an
 *    isolated launch from one running on the real `~/.c3`. The e2e settings guard
 *    refuses to write to the latter.
 */
import type {
  AdapterCapability,
  ServerToClient,
  SystemSettings,
  VendorHostStatus,
  SessionCapabilities,
  SkillSupportState,
  VendorId,
  VendorModeCatalog,
  SandboxHostStatus,
} from '@ccc/shared/protocol'
import { MODE_CATALOGS } from '../../kernel/agent/adapters/index.js'
import { vendorRuntimeStatuses } from '../../kernel/agent/vendor-runtime.js'
import { resolveWorkspaceRoot, pathToName } from '../../state.js'
import {
  getSessionBindingStats,
  loadSettings,
  loadWorkspaceSetting,
  saveSettings,
  saveWorkspaceSetting,
} from '../../kernel/config/index.js'
import { dbPath } from '../../kernel/infra/db.js'
import { detectDefaultBranch } from '../intents/worktree.js'
import { getSpecsBase } from '../intents/specs-root.js'
import { probeArapuca, sysExtraMounts } from '../../kernel/sandbox/SandboxLauncher.js'
import {
  probeAll,
  applyVendorCliChoices,
  readVendorCliStatus,
} from '../../kernel/agent/process/launcher.js'
import { VENDOR_CAPABILITIES } from '../../kernel/agent/adapters/capabilities.js'
import { getSkillSupport } from '../../state.js'
import type { Handler } from '../../transport/handler-registry.js'
import { requireAdmin } from '../auth/authz.js'

/** Map the ProcessLauncher probe into the wire shape (carrying the resolved path),
 *  merged with the manifest-derived multi-version status for the vendor CLI panel. */
function hostStatus(): VendorHostStatus[] {
  return probeAll().map((p) => {
    const status = readVendorCliStatus(p.vendor)
    return {
      vendor: p.vendor,
      present: p.path !== null,
      binary: p.binary,
      path: p.path,
      source: p.source,
      ...(p.version ? { version: p.version } : {}),
      ...(p.expectedVersion ? { expectedVersion: p.expectedVersion } : {}),
      compatibleRange: p.compatibleRange,
      ...(p.error ? { error: p.error } : {}),
      ...(p.managedError ? { managedError: p.managedError } : {}),
      installHint: p.installHint,
      ...(status.installedVersions.length > 0
        ? { installedVersions: status.installedVersions }
        : {}),
      ...(status.activeVersion ? { activeVersion: status.activeVersion } : {}),
      ...(status.downloadTargetVersion
        ? { downloadTargetVersion: status.downloadTargetVersion }
        : {}),
      ...(status.lastCheckedAt ? { lastCheckedAt: status.lastCheckedAt } : {}),
      ...(status.lastRemoteCheckAt ? { lastRemoteCheckAt: status.lastRemoteCheckAt } : {}),
      ...(status.lastError ? { lastError: status.lastError } : {}),
    }
  })
}

function sandboxStatus(): SandboxHostStatus {
  const probe = probeArapuca()
  return probe.ok
    ? { present: true, binary: 'arapuca', path: probe.path }
    : { present: false, binary: 'arapuca', path: null, error: probe.uiCode }
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
 * The `basic` account store (usernames, password hashes, admin designation) is
 * owned SOLELY by the dedicated auth messages (`set_admin_password` upsert /
 * `remove_account` / `set_admin_account`) — never by a generic `save_settings`
 * (AUTH-R7). So when the saved draft is `basic`, force the ENTIRE basic provider
 * back to the on-disk value: a stale/empty client draft can neither wipe accounts
 * nor change the admin. When disk is not basic (the user just switched none
 * → basic via the dropdown), the saved draft keeps its fresh empty-shell basic
 * provider (accounts: [], adminUsername: '') — accounts are then filled only via
 * the dedicated messages. `enabled` is re-derived on load by `normalizeAuth`.
 */
export function preserveBasicProvider(next: SystemSettings): SystemSettings {
  if (next.auth?.provider.kind !== 'basic') return next
  const diskProvider = loadSettings().auth?.provider
  if (diskProvider?.kind !== 'basic') return next
  return { ...next, auth: { ...next.auth, provider: { ...diskProvider } } }
}

/**
 * The `settings` reply for a given configuration snapshot: the persisted object
 * plus every runtime-derived companion, re-probed at send time.
 *
 * One builder rather than a literal per handler, so a companion added here
 * reaches every reply at once — a snapshot that silently lacked `vendorRuntime`
 * would leave the console gating on stale availability.
 */
export function settingsFrame(
  settings: SystemSettings,
): Extract<ServerToClient, { type: 'settings' }> {
  return {
    type: 'settings',
    settings,
    hostStatus: hostStatus(),
    vendorRuntime: vendorRuntimeStatuses(),
    sandboxStatus: sandboxStatus(),
    bindingStats: getSessionBindingStats(),
    sessionCapabilities: sessionCapabilities(),
    vendorCapabilities: vendorCapabilities(),
    skillSupport: skillSupport(),
    vendorModes: vendorModes(),
    dbPath: dbPath(),
  }
}

export const getSettings: Handler<'get_settings'> = (_ctx, conn) => {
  conn.send(settingsFrame(loadSettings()))
}

export const saveSettingsHandler: Handler<'save_settings'> = (_ctx, conn, msg) => {
  // Only the admin may mutate system configuration (ADR-0023 authz). Inert when no
  // admin gate applies (auth disabled / unconfigured) — loopback bootstrap-trust.
  if (!requireAdmin(conn)) return
  const saved = saveSettings(preserveBasicProvider(msg.settings))
  // Sync the manifest's selectedVersion to the user's effective-version choices
  // and refresh the probe cache BEFORE re-probing, so the returned hostStatus and
  // subsequent session launches reflect the new priority. This never touches
  // settings.json — only the vendor manifest + probe cache.
  applyVendorCliChoices(saved.vendorCliVersions ?? {})
  conn.send(settingsFrame(saved))
}

export const loadWorkspaceSettingHandler: Handler<'load_workspace_setting'> = (_ctx, conn, msg) => {
  const proj = resolveWorkspaceRoot(msg.workspaceName)
  if (!proj) {
    conn.send({
      type: 'error',
      error: { code: 'workspace.unknown', params: { workspaceName: msg.workspaceName } },
    })
    return
  }
  const config = loadWorkspaceSetting(proj)
  // Probe the repo's default branch so the form can pre-fill `defaultMainBranch`
  // (origin/HEAD → current HEAD; undefined when unresolvable).
  const detectedMainBranch = detectDefaultBranch(proj)
  conn.send({
    type: 'workspace_setting',
    workspaceName: pathToName(proj)!,
    config,
    detectedMainBranch,
    // Read-only display of the FIXED, centralized SDD spec root (REQ-3).
    resolvedSpecRoot: getSpecsBase(proj),
    // Read-only display of the workspace-scoped built-in sandbox allow set.
    sysExtraMounts: sysExtraMounts(proj),
  })
}

export const saveWorkspaceSettingHandler: Handler<'save_workspace_setting'> = (_ctx, conn, msg) => {
  // Workspace configuration is admin-only too (ADR-0023 authz; full coverage).
  if (!requireAdmin(conn)) return
  const proj = resolveWorkspaceRoot(msg.workspaceName)
  if (!proj) {
    conn.send({
      type: 'error',
      error: { code: 'workspace.unknown', params: { workspaceName: msg.workspaceName } },
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

  // The spec root is fixed/centralized and never user-configurable: any spec
  // directory value the client may have sent in `msg.config` is dropped by
  // `normalizeWorkspaceSetting` (no such field), so the save cannot change it.
  const config = saveWorkspaceSetting(proj, msg.config)
  conn.send({
    type: 'workspace_setting',
    workspaceName: pathToName(proj)!,
    config,
    resolvedSpecRoot: getSpecsBase(proj),
    sysExtraMounts: sysExtraMounts(proj),
  })
}
