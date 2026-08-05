/**
 * System / personalized settings and app update wire messages.
 *
 * Each type is one arm of `ClientToServer` / `ServerToClient`; the unions are
 * assembled in `../protocol.ts`, which is their only definition site. These arm
 * types are internal to the partition and are NOT part of the public
 * `@ccc/shared/protocol` surface.
 */

import type {
  ExternalMcpToolDescriptor,
  McpApiKeyMeta,
  PersonalizedSettings,
  PersonalizedSettingsScope,
  SystemSettings,
  UpdateStatus,
} from './settings.js'
import type { SkillSupportState } from './skill.js'
import type {
  AdapterCapability,
  SandboxHostStatus,
  SessionBindingStats,
  SessionCapabilities,
  VendorHostStatus,
  VendorId,
  VendorModeCatalog,
  VendorRuntimeStatus,
} from './vendor.js'

/** Fetch the system configuration (reply: `settings`). */
export type ClientGetSettings = { type: 'get_settings' }

/** Replace the system configuration; server normalizes and echoes `settings`. */
export type ClientSaveSettings = { type: 'save_settings'; settings: SystemSettings }

/**
 * Fetch this connection's {@link PersonalizedSettings} (reply:
 * `personalized_settings`). `localFallback` carries the browser's own current
 * values so the server can seed a brand-new account record from them; it is a
 * *seed*, never an override — an existing account record always wins, and the
 * client cannot influence which subject is read (the server uses the verified
 * connection identity). Needs no administrator authority.
 */
export type ClientGetPersonalizedSettings = {
  type: 'get_personalized_settings'
  localFallback?: PersonalizedSettings
}

/**
 * Persist this connection's {@link PersonalizedSettings}; server normalizes and
 * echoes `personalized_settings`. Stored under the verified subject when one
 * applies — a client cannot name the account it writes to. Needs no administrator
 * authority.
 */
export type ClientSavePersonalizedSettings = {
  type: 'save_personalized_settings'
  settings: PersonalizedSettings
}

/**
 * Fetch ONE workspace's external-MCP API key roster (reply: `mcp_api_keys`).
 * Metadata only — no plaintext key has ever been recoverable after its creation
 * reply. Scoped by workspace because a key is bound to exactly one: there is no
 * "all keys on this host" view to ask for.
 */
export type ClientListMcpApiKeys = { type: 'list_mcp_api_keys'; workspaceId: string }

/**
 * Mint a long-lived external-MCP API key bound to ONE registered workspace. The
 * caller names only the workspace and a display name: the initial tool scope is
 * server-decided (the full read-only set, no write tool), so a forged default
 * cannot smuggle write access into a fresh key. The reply is the ONLY message
 * that carries the plaintext key.
 */
export type ClientCreateMcpApiKey = {
  type: 'create_mcp_api_key'
  workspaceId: string
  name: string
}

/**
 * Update a key's display name and/or its granted tool scope. An omitted field is
 * left untouched; an explicitly EMPTY `tools` means "this key may call nothing"
 * and is never read as "all". Every name must be in the server catalog — an
 * unknown or duplicated name fails the WHOLE update rather than being dropped,
 * so an administrator is never told a scope was saved that was not.
 *
 * The workspace binding is immutable and therefore absent here.
 */
export type ClientUpdateMcpApiKey = {
  type: 'update_mcp_api_key'
  /** The workspace whose roster the reply should carry; the key's own binding is unchanged. */
  workspaceId: string
  id: string
  name?: string
  tools?: string[]
}

/** Revoke (delete) a key. Takes effect on the revoked key's very next request. */
export type ClientRevokeMcpApiKey = {
  type: 'revoke_mcp_api_key'
  /** The workspace whose roster the reply should carry. */
  workspaceId: string
  id: string
}

/**
 * ONE workspace's external-MCP API key roster, in reply to any of the four key
 * operations. Always that workspace's full list, so the console never has to
 * reconcile a delta, and always alongside the server's capability `catalog` so
 * the tool pickers render from server truth rather than a front-end copy.
 *
 * `created` is present ONLY in the reply to a successful `create_mcp_api_key` and
 * is the single point in the whole system where a plaintext key exists on the
 * wire. It is not stored, not re-sent, and not recoverable after the client
 * discards it.
 */
export type ServerMcpApiKeys = {
  type: 'mcp_api_keys'
  /** The workspace this roster belongs to; the console ignores a stale reply for another. */
  workspaceId: string
  keys: McpApiKeyMeta[]
  /** Every tool that may be granted, with its read/write grading. */
  catalog: ExternalMcpToolDescriptor[]
  created?: { meta: McpApiKeyMeta; key: string }
}

/**
 * Push the refreshed {@link UpdateStatus} snapshot to every connection after each
 * server-side update check. Fail-soft: a failed check keeps the last successful
 * snapshot, so this only ever moves toward "known" (never blanks a prior hit).
 */
export type ServerUpdateStatus = { type: 'update_status'; updateStatus: UpdateStatus }

/**
 * The (normalized) system configuration, in reply to `get_settings`/`save_settings`.
 * Carries three runtime-derived companions the config object itself does not hold:
 * `hostStatus` — each vendor's host-CLI presence (ADR-0012), so the console can
 * grey out an agent whose binary is not on PATH; `bindingStats` — the
 * session→agent binding counts (ADR-0015), so the console can explain that a
 * default-agent change is not retroactive; and `sessionCapabilities` — each
 * vendor's graded {@link SessionCapabilities} (ADR-0011 addendum), the projection
 * of the kernel ledger the UI degrades session-row actions by (per `vendor` tag,
 * never an `if (vendor === …)` branch).
 */
export type ServerSettings = {
  type: 'settings'
  settings: SystemSettings
  hostStatus: VendorHostStatus[]
  /**
   * Every vendor's {@link VendorRuntimeStatus} — the neutral "can c3 run this
   * vendor" signal the console gates the agent-config vendor picker and every
   * other run entry on, with zero `if (vendor === …)`. `hostStatus` keeps
   * meaning host-CLI presence only; a vendor backed by an in-process SDK
   * answers here and appears in no CLI panel.
   *
   * The `Record<VendorId, …>` shape is the coverage guarantee (every vendor
   * answers); each entry still names its own `vendor` so a single row can be
   * passed around self-describingly.
   *
   * Absent on older servers: the console then derives claude/codex from
   * `hostStatus` and treats an SDK-backed vendor as unavailable — never the
   * reverse, so a stale server cannot let a user into a path that must fail.
   */
  vendorRuntime?: Record<VendorId, VendorRuntimeStatus>
  /** Process-level sandbox driver status; absent on older servers. */
  sandboxStatus?: SandboxHostStatus
  bindingStats: SessionBindingStats
  sessionCapabilities: Record<VendorId, SessionCapabilities>
  /**
   * Each vendor's binary {@link AdapterCapability} ledger (interrupt / setActionMode /
   * … / taskStore), mirrored from the kernel's `AdapterCapabilities`. Lets the console
   * gate capability-bound UI by `vendor` with zero `if (vendor === …)` — e.g. the task
   * panel renders only when the active vendor reports `taskStore`. Absent on older
   * servers; the UI then assumes every capability present (no gating, old-session safe).
   */
  vendorCapabilities?: Record<VendorId, Record<AdapterCapability, boolean>>
  /**
   * Each vendor's external-skill mount support (ADR-0016/0017, mount layer 2/3).
   * Probed and cached by `detectSkillSupport()`. A `none` / `temporarily-unavailable`
   * vendor gets its vendor selector in the skillRepos form greyed out — the session
   * still launches, but the skill is not linked into that vendor's discovery dir.
   * Absent when the mount layer hasn't been initialized yet (older configs); the
   * UI then defaults every vendor to `full` (no greying).
   */
  skillSupport?: Record<VendorId, SkillSupportState>
  /**
   * Each vendor's {@link VendorModeCatalog} (2026-06-07-012) — the ordered,
   * native mode tokens + their i18n label codes the console's mode picker
   * renders by `vendor`. The web reads the active session's vendor catalog to
   * label `SessionInfo.mode` and to build the mode dropdown options; absent on
   * older servers, the UI then falls back to the built-in Claude mode list.
   */
  vendorModes?: Record<VendorId, VendorModeCatalog>
}

/**
 * The normalized {@link PersonalizedSettings} for this connection, in reply to
 * `get_personalized_settings` / `save_personalized_settings`. This echo decides
 * the console's live display language. `scope` tells the client which store
 * answered, so it knows whether the value it just received is account-backed
 * (`account`) or merely its own browser value normalized (`local`).
 */
export type ServerPersonalizedSettings = {
  type: 'personalized_settings'
  settings: PersonalizedSettings
  scope: PersonalizedSettingsScope
}
