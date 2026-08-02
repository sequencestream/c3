/**
 * System-wide and per-subject personalized settings, plus app update status.
 *
 * Part of the `@ccc/shared/protocol` contract; re-exported by `../protocol.ts`.
 */

import type { AgentConfig } from './agent-config.js'
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
 * The system configuration, persisted at `~/.c3/settings.json`. Always contains
 * the system agent; `defaultAgentId` references an existing agent's id.
 */
export interface SystemSettings {
  agents: AgentConfig[]
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
   * Session subprocess proxy configuration. When `enabled` is true, the proxy
   * URLs (when non-empty) are injected as `HTTP_PROXY`/`http_proxy` and
   * `HTTPS_PROXY`/`https_proxy` into every new session subprocess's
   * environment. When `enabled` is false (the default), no proxy env vars are
   * injected regardless of the saved URL values — the URLs are retained so the
   * user can toggle the switch without re-entering them. Only affects newly
   * launched session processes; running sessions are not retroactively updated
   * (callers must consult {@link getProxyConfig}). `httpProxy` is the HTTP
   * proxy URL (e.g. `http://proxy.local:3128`); `httpsProxy` is the HTTPS proxy
   * URL. Does NOT affect the server process's own outbound requests. All three
   * fields are optional for forward compatibility (absent ≡ disabled).
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
