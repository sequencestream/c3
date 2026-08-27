/**
 * System-wide and per-subject personalized settings, plus app update status.
 *
 * Part of the `@ccc/shared/protocol` contract; re-exported by `../protocol.ts`.
 */

import type { AgentConfig } from './agent-config.js'
import type { ModelProvider } from './model-provider.js'
import type { AuthConfig } from './auth.js'
import type { ConsensusConfig } from './consensus.js'
import type { SkillRepoConfig } from './skill.js'
import type { ModeToken, VendorId } from './vendor.js'
import type { SessionCleanupConfig, WorkspaceSetting } from './workspace.js'

/**
 * The UI display language for the web console. A short language code (no region
 * subtag). Independent from {@link SystemSettings.voiceLang} (browser speech
 * recognition): the two never read or default off each other. Unset ⇒ `en`.
 * Only `en`/`zh` ship translations today; `ja`/`ko`/`ru` are reserved for the
 * i18n rollout and fall back to `en` messages until translated.
 *
 * Lives in {@link PersonalizedSettings} — a per-person preference, not a
 * system-wide knob.
 */
export type UiLang = 'en' | 'zh' | 'ja' | 'ko' | 'ru'

/**
 * The web console's display theme. A stable id, not a colour value: the console
 * keeps one registry entry per theme (id + display name + colour scheme) and the
 * runtime only maps the id onto the root element's `data-theme`, so the palette
 * itself stays entirely in CSS. Unset ⇒ `dark`, which is the console's built-in
 * look; `light` activates the already-defined light token overrides.
 *
 * Adding a preset means adding a registry entry plus its CSS variable block —
 * nothing here or in the settings page enumerates themes by hand.
 *
 * Lives in {@link PersonalizedSettings}: a per-person display preference that
 * never leaves the web console (no server-side rendering decision reads it).
 */
export type UiTheme = 'dark' | 'light'

/**
 * Personalized settings — the third settings class, beside {@link SystemSettings}
 * (administrator-level, system-wide) and {@link WorkspaceSetting} (per workspace).
 * It holds the preferences that legitimately differ **per person**, so changing one
 * never forces the choice onto anyone else and needs no administrator authority
 * (the admin gate does not apply to this class).
 *
 * Scope resolution is by identity, not by deployment: an authenticated connection's
 * settings are stored server-side under its verified subject; without a subject the
 * browser itself is the store. Every field is optional and normalizes to its own
 * default, so a record written by an older client stays readable.
 */
export interface PersonalizedSettings {
  /** Web-console display language. Missing/unknown ⇒ `en`. See {@link UiLang}. */
  uiLang?: UiLang
  /**
   * Web-console display theme. Missing/unknown ⇒ `dark`. See {@link UiTheme}.
   * Normalized on its own, so a corrupt theme never disturbs {@link uiLang}.
   */
  theme?: UiTheme
  /**
   * Console UI font-size scale, as a percentage of the built-in size (100 = 100%,
   * the default). Only values in `[70, 120]` are accepted; a missing, out-of-range
   * or non-numeric value normalizes to 100. Fractions are allowed (e.g. 87.5).
   * Applied to the whole UI through the root element's `--c-font-scale` CSS
   * variable, which every relative-unit (`rem`/`em`/`var`) font token scales by —
   * a per-person display preference like {@link uiLang}/{@link theme}, never a
   * system-wide knob.
   */
  fontScale?: number
}

/**
 * The per-account personalized-settings store: verified subject → that account's
 * {@link PersonalizedSettings}. Persisted as a **sibling of** `SystemSettings` in
 * `settings.json`, never inside it — so it is absent from every system-settings
 * snapshot and a whole-object system-settings save cannot touch it. Subjects are
 * case-sensitive and taken only from the server-verified connection identity; a
 * client can neither read nor address another subject's record.
 */
export type PersonalizedSettingsBySubject = Record<string, PersonalizedSettings>

/**
 * Which store answered a {@link PersonalizedSettings} read/write: `account` ⇒ the
 * server-side record for the connection's verified subject; `local` ⇒ no subject
 * applies, so the browser's own storage is authoritative and the server persisted
 * no account record.
 */
export type PersonalizedSettingsScope = 'account' | 'local'

/**
 * How much damage one externally-grantable tool can do. `read` never mutates the
 * intent ledger, discussions, specs or session lifecycle; `write` does — it can
 * persist intents, submit a review conclusion, or launch an agent. The console
 * groups the two and gates the write group behind an explicit risk confirmation.
 *
 * `publish_event` counts as `read`: it delivers a fact onto the event bus with a
 * server-derived workspace and source, and cannot itself edit state. Subscribed
 * automations may react asynchronously — that is the tool's own documented
 * semantics, not a widening of this grade.
 */
export type ExternalMcpToolAccess = 'read' | 'write'

/**
 * One entry of the server's externally-grantable capability catalog, as it
 * reaches the console. The full catalog entry also carries a description, a zod
 * input schema and the business handler; only the two fields an authorization UI
 * needs cross the wire.
 *
 * The console renders the tool pickers from THIS list rather than from a
 * front-end copy, so a tool the server does not offer can never be checked, and
 * a tool the server adds needs no console release to become grantable.
 */
export interface ExternalMcpToolDescriptor {
  /** The stable MCP tool name, e.g. `find_intents`. Also the authorization token. */
  name: string
  /** Read/write grading; decides which group the console renders it in. */
  access: ExternalMcpToolAccess
}

/**
 * Every READ-graded tool in the externally-grantable catalog — the grading
 * source, NOT the default scope of a new key. Being listed here means an
 * administrator MAY tick it; what a fresh key actually gets is
 * {@link EXTERNAL_MCP_DEFAULT_TOOLS}.
 */
export const EXTERNAL_MCP_READ_TOOLS = [
  'find_intents',
  'view_intent',
  'find_discussions',
  'view_discussion',
  'find_deliveries',
  'view_delivery',
  'publish_event',
  'list_workspaces',
  'whoami',
] as const

/**
 * The tools that really change c3 state. None is granted by default; each must be
 * ticked by an administrator, who is shown the risk before the scope is saved.
 *
 * There is deliberately no delivery write tool: a delivery status write funnels
 * through the state machine and its guards, and a tool that set a status directly
 * would route around all of them.
 */
export const EXTERNAL_MCP_WRITE_TOOLS = [
  'save_intents',
  'save_intent_directly',
  'submit_spec_review',
  'start_session_for_intent',
  'start_discussion',
  'continue_discussion',
] as const

/** Every name that may ever appear in a key's tool scope. */
export type ExternalMcpToolName =
  (typeof EXTERNAL_MCP_READ_TOOLS)[number] | (typeof EXTERNAL_MCP_WRITE_TOOLS)[number]

/**
 * The whole externally-grantable catalog in its declared order (read tools, then
 * write tools). This is the set an effective tool scope is intersected with, so a
 * name a key still carries but the catalog no longer offers grants nothing.
 */
export const EXTERNAL_MCP_TOOL_NAMES = [
  ...EXTERNAL_MCP_READ_TOOLS,
  ...EXTERNAL_MCP_WRITE_TOOLS,
] as const satisfies readonly ExternalMcpToolName[]

/**
 * What a NEW key is granted. The server writes exactly this set on creation
 * regardless of what the client asked for, so a forged "default" cannot smuggle
 * an ungranted tool into a fresh key.
 *
 * Deliberately a SEPARATE list from {@link EXTERNAL_MCP_READ_TOOLS} rather than
 * "every read tool": the catalog says what an administrator may authorize, this
 * says what is authorized without anybody deciding. The delivery read tools are
 * in the catalog but NOT here — a fresh key must not silently gain the ability to
 * read a workspace's delivery plan.
 */
export const EXTERNAL_MCP_DEFAULT_TOOLS = [
  'find_intents',
  'view_intent',
  'find_discussions',
  'view_discussion',
  'publish_event',
  'list_workspaces',
  'whoami',
] as const satisfies readonly ExternalMcpToolName[]

/**
 * The non-secret half of one long-lived external-MCP API key — everything the
 * console may see about a key AFTER it was created. The plaintext key exists in
 * exactly one message (the creation reply) and is never recoverable afterwards:
 * only a salted `scrypt` hash reaches disk.
 *
 * Stored as a **sibling of** {@link SystemSettings} in `settings.json` (like
 * `personalizedSettings`), so a whole-object system-settings save can neither
 * read a hash out nor write one in.
 */
export interface McpApiKeyMeta {
  /**
   * Immutable, NON-SECRET key id. It is embedded in the plaintext key so the
   * server can locate the single candidate record before doing any (expensive)
   * hash derivation, instead of scanning every key.
   */
  id: string
  /** Human-chosen display name; free text, trimmed, never used for lookup. */
  name: string
  /** Creation instant (unix ms). */
  createdAt: number
  /** Last successful authentication (unix ms); `null` until the key is first used. */
  lastUsedAt: number | null
  /**
   * The workspace this key is FILED under, as its {@link WorkspaceInfo} name —
   * the settings tab it is listed and administered on. It is NOT a grant: which
   * workspaces the key reaches is its owner's administrator-managed scope,
   * resolved per request. `null` means that filing workspace is no longer
   * registered, which says nothing about what the key can reach.
   */
  workspaceName: string | null
  /**
   * The tool names this key may call. The effective set is this list intersected
   * with the externally-grantable catalog, and `tools/list` on `POST /mcp` shows
   * exactly that intersection; any other tool call is refused.
   */
  tools: string[]
  /**
   * True when the key's owner is no longer a principal this deployment
   * recognizes — an account that was removed, or a `local` owner after basic auth
   * was configured. The key then reaches nothing and the console marks it
   * unavailable, offering only revocation. How much a VALID owner may reach is a
   * separate, per-request question this flag does not answer.
   */
  unavailable: boolean
  /**
   * A short, non-secret identifying prefix for display (`c3k_<id>`). Derived
   * wholly from {@link id}; it carries no part of the secret, so showing it in a
   * list leaks nothing.
   */
  displayPrefix: string
}

/**
 * The system configuration, persisted at `~/.c3/settings.json`. Always contains
 * the system agent; `defaultAgentId` references an existing agent's id.
 */
export interface SystemSettings {
  agents: AgentConfig[]
  /**
   * Named model-provider registry — shared upstream URLs agents reference via
   * `providerId`. A key rotation or endpoint change edits one row instead of N
   * agents. Empty/absent ⇒ no providers configured (agents use the vendor CLI's
   * own login).
   *
   * Persisted in `system_configs` alongside `agents`; the account `apiKey` is
   * encrypted at rest with the same `c3secretvN:` scheme as agent apiKeys.
   */
  modelProviders?: ModelProvider[]
  /** Id of the agent new/unassigned sessions launch with. */
  defaultAgentId: string
  /**
   * Id of the agent that runs **background tool sessions** (completion judge,
   * session summary; the exception-handling session is not yet agent-driven) so
   * these housekeeping tasks can run on a cheaper/faster agent decoupled from the
   * main conversation's quota. Semantics mirror {@link defaultAgentId} with ONE
   * difference: an **empty string is "follow the default agent"** (the runtime
   * resolves it through `resolveAgent`, falling back `toolAgentId → defaultAgentId
   * → system`). A *non-empty* value that points at a removed/now-disabled agent is
   * **rewritten** on store to the next enabled agent in `order_seq` order — the same
   * `resolveDefaultAgentId` fall-through the default uses (AC-R2/AC-R10/AC-R20); when
   * every agent is disabled it resolves to {@link SYSTEM_AGENT_ID}. An empty string
   * is left empty (never auto-filled), so "follow the default" survives a save.
   */
  toolAgentId: string
  /**
   * Id of the agent that runs **intent-communication sessions** (the intent
   * analyst's requirement-breakdown conversation: `startIntentComm` / `refineIntent`
   * / `discussionToIntent` / opening an intent comm session) so this high-value,
   * reasoning-heavy task can be steered to a stronger/more suitable agent decoupled
   * from the "default agent for new sessions". Semantics are **identical to
   * {@link toolAgentId}**: an **empty string is "follow the default agent"** (the
   * runtime resolves it through `resolveAgent`, falling back `intentAgentId →
   * defaultAgentId → system`). A *non-empty* value that points at a removed/now-disabled
   * agent is **rewritten** on store to the next enabled agent in `order_seq` order —
   * the same `resolveDefaultAgentId` fall-through the default uses (AC-R2/AC-R10/AC-R20);
   * when every agent is disabled it resolves to {@link SYSTEM_AGENT_ID}. An empty string
   * is left empty (never auto-filled), so "follow the default" survives a save.
   */
  intentAgentId: string
  /**
   * Id of the agent that runs **spec-authoring sessions** (writing/refining the
   * project specification: a high-value, read-only reasoning task that benefits
   * from being routed to a stronger/more suitable agent decoupled from the "default
   * agent for new sessions"). Semantics are **identical to {@link intentAgentId}**:
   * an **empty string is "follow the default agent"** (the runtime resolves it
   * through `resolveAgent`, falling back `specAgentId → defaultAgentId → system`).
   * A *non-empty* value that points at a removed/now-disabled agent is **rewritten**
   * on store to the next enabled agent in `order_seq` order — the same
   * `resolveDefaultAgentId` fall-through the default uses (AC-R2/AC-R10/AC-R20); when
   * every agent is disabled it resolves to {@link SYSTEM_AGENT_ID}. An empty string
   * is left empty (never auto-filled), so "follow the default" survives a save.
   */
  specAgentId: string
  /**
   * Id of the agent that runs **spec-REVIEW sessions** (the read-only reviewer
   * that judges an authored spec and submits a structured conclusion). Semantics
   * are **identical to {@link specAgentId}**: an **empty string is "follow the
   * default agent"** (the runtime resolves it through `resolveAgent`, falling back
   * `specReviewAgentId → defaultAgentId → system`). A *non-empty* value that points
   * at a removed/now-disabled agent is **rewritten** on store to the next enabled
   * agent in `order_seq` order; an empty string is left empty (never auto-filled),
   * so "follow the default" survives a save.
   *
   * There is exactly ONE slot — no sandbox-specific reviewer agent exists. Whether
   * a review session runs inside the sandbox is decided solely by whether
   * `sandboxSessionKinds` contains `'spec_review'`.
   */
  specReviewAgentId: string
  /**
   * Id of the agent used to **pre-fill the "new automation" form** (the vendor +
   * agent selected the instant the create form opens). Storage-normalization
   * semantics are **identical to {@link specAgentId}**: an **empty string is
   * "follow the default agent"** (the form resolves it `automationAgentId →
   * defaultAgentId → system`), a *non-empty* value that points at a removed/now-disabled
   * agent is **rewritten** on store to the next enabled agent in `order_seq` order —
   * the same `resolveDefaultAgentId` fall-through the default uses (AC-R2/AC-R10/AC-R20);
   * when every agent is disabled it resolves to {@link SYSTEM_AGENT_ID}. An empty string
   * is left empty (never auto-filled), so "follow the default" survives a save.
   *
   * UNLIKE {@link toolAgentId}/{@link intentAgentId}/{@link specAgentId}, this value is
   * **not** consumed by the runtime `resolveAgent` router: an automation record stores a
   * concrete `vendor`/`agentId` snapshot at creation time and runs on that. This field
   * only decides the create-form's one-time default selection (AC-R25); editing an
   * existing automation and its saved snapshot are unaffected.
   */
  automationAgentId: string
  /** BCP-47 language tag for browser voice input (e.g. `zh-CN`). `zh-CN` when unset. */
  voiceLang?: string
  /**
   * System-wide IANA time zone (e.g. `Asia/Shanghai`, `America/New_York`) used
   * to interpret every automation's cron fields when computing `next_run_at`. The
   * cron expression `0 11 * * *` means 11:00 in this zone, not 11:00 UTC. The
   * stored `next_run_at` is still an absolute Unix-ms instant; the zone only
   * decides which instant a wall-clock cron maps to (DST-aware). Unset/invalid
   * ⇒ the server's local time zone (`Intl.DateTimeFormat().resolvedOptions().timeZone`).
   * Changing it shifts the actual trigger moment of existing automations.
   */
  timezone?: string
  /**
   * Public-facing base URL for this c3 deployment (e.g. `http://192.168.10.10:9000`).
   * Used to construct shareable links and any future external-facing URLs. Stored
   * in plaintext (not sensitive). Normalized on save: trimmed and trailing slashes
   * stripped. Empty or absent ⇒ "not configured" (consumers fall back to defaults).
   * System-wide (not per-workspace).
   */
  baseUrl?: string
  /** When true, tool-created sessions (completion judge, consensus advisor) appear
   * in the sidebar session list. Default is false (hidden). */
  showToolSessions?: boolean
  /** When true, the sessions aggregation page appears in primary navigation.
   * Default is false (hidden); this does not affect in-context session entry points. */
  showSessionsPage?: boolean
  /**
   * @deprecated 2026-06-07 — moved to per-project {@link WorkspaceSetting}. The server
   * no longer writes this field; kept for backward-compatible typecheck of the web
   * UI which has not yet been migrated to the project-level config model.
   * TODO: remove after SettingsPanel is migrated to project-level config (next task).
   * Prefer the per-project getters (`loadWorkspaceSetting`) for authoritative values.
   */
  defaultMode?: ModeToken
  /**
   * @deprecated 2026-06-07 — moved to per-project {@link WorkspaceSetting}. See
   * {@link SystemSettings.defaultMode} deprecation note for the migration plan.
   */
  consensus?: ConsensusConfig
  /**
   * @deprecated 2026-06-07 — moved to per-project {@link WorkspaceSetting}. See
   * {@link SystemSettings.defaultMode} deprecation note for the migration plan.
   */
  devSkill?: string
  /**
   * @deprecated 2026-06-07 — moved to per-project {@link WorkspaceSetting}. See
   * {@link SystemSettings.defaultMode} deprecation note for the migration plan.
   */
  maxRoundsPerStage?: number
  /**
   * @deprecated 2026-06-07 — moved to per-project {@link WorkspaceSetting}. See
   * {@link SystemSettings.defaultMode} deprecation note for the migration plan.
   */
  maxSpeechChars?: number
  /**
   * @deprecated 2026-06-07 — moved to per-project {@link WorkspaceSetting}. The server
   * no longer writes this field; kept for backward-compatible typecheck of the web
   * UI which has not yet been migrated to the project-level skillRepos config.
   * TODO: remove after SettingsPanel is migrated to project-level config (next task).
   * Prefer the per-project getters (`loadWorkspaceSetting`) for authoritative values.
   * @see WorkspaceSetting.skillRepos
   */
  skillRepos?: SkillRepoConfig[]
  /**
   * Ordered list of agent ids defining the degradation/fallback chain.
   * When a session's turn encounters a rate-limit / session-limit / auth /
   * connection error, the server tries agents in this order until one succeeds
   * or all fail. Absent ⇒ no degradation (current behaviour: single agent,
   * error ends the turn immediately).
   * When present, the first entry is tried first on error; subsequent entries
   * are fallbacks. After normalisation each id references an existing agent in
   * `agents`; unknown ids are filtered out. An empty chain (all ids filtered)
   * is treated as absent (no degradation).
   */
  degradationChain?: string[]
  /**
   * Gray-out switch for the socket-disconnect single auto-`resume` (AS-R18 /
   * AVAIL-7). When true (the default), a normal user session whose turn hits a
   * `socket connection was closed unexpectedly` error auto-resumes once (same
   * runId, preserving context) provided the tool side-effect gate is clear.
   * Set to false to disable auto-resume entirely (every socket disconnect then
   * ends the turn with `turn_end { reason: 'error' }`, user continues manually).
   * Absent / non-false ⇒ enabled.
   */
  socketAutoResume?: boolean
  /**
   * Proxy configuration for this deployment's outbound traffic. When `enabled`
   * is true, the proxy URLs (when non-empty) are injected as
   * `HTTP_PROXY`/`http_proxy` and `HTTPS_PROXY`/`https_proxy` into every new
   * session subprocess's environment, AND the server's own requests (the update
   * check and the self-update / `c3 upgrade` download) are routed through the
   * same proxy — loopback targets and `NO_PROXY` matches stay direct. When
   * `enabled` is false (the default), nothing is injected or routed regardless
   * of the saved URL values — the URLs are retained so the user can toggle the
   * switch without re-entering them. Subprocess injection only affects newly
   * launched session processes; running sessions are not retroactively updated
   * (callers must consult {@link getProxyConfig}). `httpProxy` is the HTTP
   * proxy URL (e.g. `http://proxy.local:3128`); `httpsProxy` is the HTTPS proxy
   * URL. All three fields are optional for forward compatibility (absent ≡
   * disabled).
   */
  proxy?: {
    enabled?: boolean
    httpProxy?: string
    httpsProxy?: string
  }
  /**
   * System-wide session-store cleanup ({@link SessionCleanupConfig}). Absent or
   * undefined ⇒ cleanup is not configured (equivalent to disabled — nothing is
   * ever pruned). Global rather than per-workspace because the stores it prunes
   * are shared vendor homes.
   */
  sessionCleanup?: SessionCleanupConfig
  /**
   * Effective (active) vendor CLI version selection per vendor. This selects
   * which already-installed managed version c3 resolves at runtime — it does NOT
   * pin the download target. Empty/missing means automatic: c3 uses the newest
   * compatible managed version. A non-empty value MUST point to a version present
   * in the server-reported installed-versions list; an uninstalled/incompatible
   * value degrades to the latest compatible managed version and records a
   * visible `lastError` rather than silently clearing the selection.
   *
   * Sync always tracks the newest compatible npm release regardless of this
   * field, so historical versions can be selected as active without freezing
   * upgrades.
   */
  vendorCliVersions?: Partial<Record<VendorId, string>>
  /**
   * Authentication configuration (ADR-0023). Absent ⇒ no auth (the C-SEC-5
   * localhost-only default): the server stays bound to loopback and never
   * challenges a connection. When present and `enabled`, it carries the active
   * {@link AuthProvider} (only `basic` this phase), the session-token policy,
   * and the network-exposure intent. `normalize()` drops a malformed `auth` to
   * `undefined` (fail-soft), so an invalid block is equivalent to disabled.
   * NOTE (ADR-0023): this is contract-only — no runtime middleware/login/hashing
   * exists yet; the server does NOT actually relax its bind until a later task
   * implements enforcement.
   */
  auth?: AuthConfig
  /**
   * Per-project (workspace) configuration map, keyed by resolved project path.
   * Each entry holds the project's own {@link WorkspaceSetting} — the workspace-level
   * knobs (`defaultMode`, `consensus`, `devSkill`, `maxRoundsPerStage`,
   * `maxSpeechChars`, `gitBranchMode`, `defaultMainBranch`, sandbox) that were
   * previously global. A project absent from this map falls back to the normalized
   * defaults. Absent/empty ⇒ no project has customised settings yet.
   * NOTE: the on-disk key stays `projectConfigs` for backward compatibility even
   * after the type was renamed `ProjectConfig → WorkspaceSetting` (2026-06-10).
   */
  projectConfigs?: Record<string, WorkspaceSetting>
}

/**
 * A minimal, pure-data snapshot of "is a newer c3 release available?", produced by
 * the server-side update checker (polls the GitHub releases API for the latest
 * release and compares the remote version with the running `VERSION`). Carried on
 * the `ready` handshake and re-pushed via {@link update_status} after each check.
 *
 * The console renders an upgrade hint ONLY when `available === true && latestVersion`;
 * "no update", "not yet checked", and "check failed" all present as `available:false`
 * (or `latestVersion:null`) and render nothing. Intentionally carries no error or
 * URL — it is a UX-visible-to-all state, never an admin-gated one.
 */
export interface UpdateStatus {
  /** True only when the remote version is strictly newer than the local `VERSION`. */
  available: boolean
  /** The latest remote version (normalized, no leading `v`); null until a check succeeds. */
  latestVersion: string | null
  /** When the last successful check completed (unix ms); null before the first success. */
  checkedAt: number | null
}

/**
 * Where the console-driven self-update currently stands.
 *
 * - `idle` — nothing staged and nothing in flight.
 * - `downloading` / `verifying` — the release package is being fetched, then
 *   cross-checked against its published checksum.
 * - `ready` — a verified package is staged; the installed binary is still the OLD
 *   one. Applying it is what swaps the binary and relaunches.
 * - `applying` — the binary has been swapped and the relaunch is handed off; the
 *   connection is about to drop.
 * - `failed` — download / verify / apply failed. The running version is untouched
 *   and the action is retryable.
 */
export type SelfUpdatePhase = 'idle' | 'downloading' | 'verifying' | 'ready' | 'applying' | 'failed'

/**
 * Why this installation cannot self-update. A machine token, not UI copy — the
 * console maps it to a localized hint.
 *
 * `dev-runtime` ⇒ an unbuilt dev version or an interpreter run (no single binary
 * to swap); `desktop-managed` ⇒ the desktop shell owns the update lifecycle for
 * its sidecar; `package-manager` ⇒ the binary lives inside a package manager's
 * prefix and must be updated through it; `not-writable` ⇒ the binary's directory
 * cannot be written.
 */
export type SelfUpdateIncapableReason =
  'dev-runtime' | 'desktop-managed' | 'package-manager' | 'not-writable'

/**
 * Which step failed. A machine token, not UI copy; `detail` carries the raw
 * English diagnostic for logs and tooltips.
 */
export type SelfUpdateFailureCode =
  'network' | 'no-artifact' | 'checksum' | 'unpack' | 'replace' | 'relaunch' | 'unknown'

/**
 * The console-driven self-update snapshot: download the newest release in the
 * background, then let an admin restart into it.
 *
 * Complements {@link UpdateStatus}, which answers only "is a newer release out?".
 * This one carries the transfer progress and the failure surface, and its actions
 * are admin-gated (a restart drops every connected session).
 */
export interface SelfUpdateState {
  /** The stage of the download/apply pipeline. Always `idle` when `capable` is false. */
  phase: SelfUpdatePhase
  /** Whether this installation can swap its own binary at all. */
  capable: boolean
  /** Why not, when `capable` is false; absent otherwise. */
  incapableReason?: SelfUpdateIncapableReason
  /** The running version (the server's build-time `VERSION`). */
  currentVersion: string
  /** The version being downloaded or staged; null when nothing is in flight. */
  targetVersion: string | null
  /** Bytes written so far during `downloading`; 0 otherwise. */
  downloadedBytes: number
  /** The package's total size in bytes when known; 0 otherwise. */
  totalBytes: number
  /** Present only in `failed`. */
  failure?: { code: SelfUpdateFailureCode; detail?: string }
}
