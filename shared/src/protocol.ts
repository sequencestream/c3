/**
 * WebSocket wire protocol shared between server and web.
 * Path: /ws
 */

// Type-only import keeps protocol.ts zero-runtime; the runtime SoT lives in ui-codes.ts.
import type { UiError } from './ui-codes.js'

/**
 * Permission modes the c3 UI can switch between. These are a subset of the
 * Agent SDK's `PermissionMode` union, all valid values to pass to `query()`'s
 * `permissionMode` option and `setPermissionMode()`.
 */
export type PermissionMode = 'default' | 'auto' | 'plan' | 'acceptEdits' | 'bypassPermissions'

/** A project directory the user manages in the c3 sidebar. */
export interface WorkspaceInfo {
  /** Absolute path; also the SDK `cwd` and the key for `listSessions({ dir })`. */
  path: string
  /** Display name — the directory's basename. */
  name: string
  /** Last time a session in this workspace was selected, ms since epoch. Sort key (desc). */
  lastAccessed: number
}

/**
 * Live run state of a session, surfaced to the sidebar so background sessions
 * show their status without being viewed.
 * - `idle` — no turn in flight (session may still be active for the next prompt).
 * - `running` — a turn is executing.
 * - `awaiting_permission` — a turn is blocked waiting on a permission decision.
 * - `team` — a persistent agent-team session: the team lead's process stays alive
 *   between turns, coordinating background teammates. The run is still in-flight
 *   (not idle) even when no turn is actively producing output; it only ends when
 *   the user explicitly stops it.
 * - `reconnecting` — a transient hold: a normal session's turn hit a socket
 *   disconnect and is backing off before a single auto-`resume` of the same run
 *   (AS-R18). The run is still in flight (not idle); it resolves to `running` on
 *   the resume attempt, or to `idle` via `turn_end` if the resume is refused
 *   (side-effect gate) or exhausted.
 */
export type SessionStatus = 'idle' | 'running' | 'awaiting_permission' | 'team' | 'reconnecting'

/** One session's live run status, broadcast to every connection for the sidebar. */
export interface SessionRunStatus {
  sessionId: string
  status: SessionStatus
}

/** A session inside a workspace, as surfaced to the sidebar. */
export interface SessionInfo {
  /**
   * The session's wire id. Still the **vendor-native** id (Claude SDK UUID,
   * OpenCode session id) — NOT the opaque c3 id. The c3 namespace on the wire is
   * an ADR-0013 deferred phase; `select_session`/`delete_session`/`rename_session`
   * round-trip this id back to the server, which resolves it against the owning
   * vendor's native store.
   */
  sessionId: string
  /** Display title: SDK custom title, summary, or first prompt. */
  title: string
  /** SDK last-modified time, ms since epoch. Sort key within a workspace (desc). */
  lastModified: number
  /** c3-tracked permission mode for this session. */
  mode: PermissionMode
  /** Whether this session was created by a tool (not the user). */
  isToolSession: boolean
  /**
   * The vendor whose native store this session came from (ADR-0013 cross-vendor
   * listing via `SessionAccessor`). A display dimension — drives the sidebar
   * vendor colour dot, cross-vendor filtering, degradation annotation, and the
   * same-vendor candidate filter when switching a session's agent (ADR-0015).
   * The native session *id* is never exposed cross-vendor; only this vendor
   * *tag* is, which the wire already carries elsewhere (`session_selected.vendor`).
   */
  vendor: VendorId
  /**
   * Lifecycle state of the projection row that backs this wire entry
   * (ADR-0013 amendment — `session_metadata` projection). Drives the
   * sidebar's freshness UX: `born`/`alive` are normal list items;
   * `stale` shows a "Unvalidated" tag; `orphaned` grays the row out
   * (the native store has cleared the session); `ghost` shows a
   * "Retry" affordance (the native store errored, so we don't know if
   * the row is real). The web consumer is forward-compatible: an older
   * client that does not know this field simply ignores it.
   */
  state?: 'born' | 'alive' | 'stale' | 'orphaned' | 'ghost'
}

/**
 * Title-bar same-vendor agent-switcher payload (ADR-0015 / AS-R22). The console
 * lets the user re-target a stuck session (token-exhausted / rate-limited /
 * host-binary blip) to another agent of the **same** vendor and `resume` it —
 * vendor is frozen, so cross-vendor candidates are never offered. The candidate
 * set is resolved server-side from the **same** same-vendor rule the degradation
 * chain uses (`sameVendorEnabledAgents`), so manual and automatic fallback agree.
 */
export interface SessionAgentSwitch {
  /** The session's current agent (its bound fact, or the default) — the selected option. */
  current: { id: string; displayName: string }
  /** Other same-vendor, host-binary-present, enabled agents (excludes the current). */
  candidates: { id: string; displayName: string }[]
  /** The current agent's host CLI is missing — prompt the user to switch to continue. */
  currentUnavailable: boolean
}

/**
 * One replayed item of a session's historical transcript. Mirrors the live
 * render kinds so the console renders history and live events the same way.
 */
export type TranscriptItem =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; text: string }
  | { kind: 'tool_use'; toolUseId: string; toolName: string; input: unknown }
  | { kind: 'tool_result'; toolUseId: string; content: string; isError: boolean }
  /**
   * A turn that produced no visible output — the model only thought (an
   * end_turn after a thinking-only response) and emitted no assistant text or
   * tool call. Without this, the turn would render as nothing at all, which is
   * indistinguishable from a silent hang. Surfaced as a muted system line.
   */
  | { kind: 'notice'; text: string }

/** Display text for a turn that ended with only thinking and no visible output. */
export const EMPTY_TURN_NOTICE = '— No response this turn (the model only thought) —'

/**
 * A not-yet-started session. The browser invents the `clientId`; the server
 * binds it to a real SDK `sessionId` (via `session_started`) once the first
 * prompt's `query()` reports one.
 */
export const PENDING_SESSION_PREFIX = 'pending:'

/**
 * The id the **synthesized fallback agent** and the **legacy system-agent
 * migration** use (2026-06-06-007). Historically `'system'` was a reserved,
 * undeletable singleton; that special-casing is gone — `configMode: 'system'`
 * (see {@link AgentConfigBase.configMode}) is now the per-agent way to say "use
 * the vendor CLI's own config, no overrides", available on any vendor. This
 * constant survives only as ① the migration sentinel for old configs that still
 * carry an `id === 'system'` agent, and ② the id of the agent synthesized when
 * settings are empty/corrupt (so a session is never locked out).
 */
export const SYSTEM_AGENT_ID = 'system'

/**
 * The vendor-agnostic public shell common to every agent profile (ADR-0011's
 * `vendor` dimension applied to the config layer). The per-vendor launch
 * specifics live in a discriminated `config` sub-object — see {@link AgentConfig}.
 */
export interface AgentConfigBase {
  /** Stable id (a uuid; {@link SYSTEM_AGENT_ID} only for the synthesized fallback). */
  id: string
  /** Which vendor this agent drives. The discriminant of {@link AgentConfig}. */
  vendor: VendorId
  /**
   * Where this agent's *provider* connection comes from — orthogonal to
   * {@link vendor} (2026-06-06-007):
   *  - `'system'` — use the vendor CLI's own system config / login; the
   *    `config` provider fields (`baseUrl`/`apiKey`/`model`) are **ignored** (no
   *    overrides), exactly like the old built-in system agent. For `claude` this
   *    means first-party (no `CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING` workaround).
   *  - `'custom'` — apply the `config` provider fields as launch overrides.
   * This governs ONLY the provider triple, uniformly across vendors.
   * Back-compat: a legacy config without this field defaults to `'custom'` on
   * load (so previously-configured agents surface with editable provider fields);
   * `'system'` is only ever set explicitly in the console.
   */
  configMode: 'system' | 'custom'
  /** Display name. */
  displayName: string
  /**
   * Whether this agent is enabled. Absent/`true` ⇒ enabled (back-compat: old
   * configs without the field are treated as enabled). When `false`, the agent
   * is excluded from every "list of agents" consumer (discussion participants,
   * consensus voters, degradation chain, default-agent picker) — yet it stays
   * a valid launch target, so `resolveSessionLaunch` can still fall back to a
   * bound/default/system agent that happens to be disabled (a session is never
   * locked out). The system agent may be disabled too.
   */
  enabled?: boolean
  /**
   * Optional display icon: an emoji or short text used to identify this agent
   * in multi-speaker contexts (e.g. discussion chat bubbles). Empty/absent
   * ⇒ no custom icon (consumers fall back to a default marker). Stored
   * verbatim aside from trim and a length cap; not validated as a real emoji.
   * Back-compat: old configs without the field load as `''`. The system agent
   * may have an icon too.
   */
  icon?: string
}

/**
 * The `claude` vendor's config sub-object: the Claude Code launch overrides.
 * Each empty field ⇒ no override (the system agent's config is all-empty).
 */
export interface ClaudeAgentConfig {
  /** ANTHROPIC_BASE_URL override. Empty ⇒ no override. */
  baseUrl: string
  /** API key / auth token override. Empty ⇒ no override. */
  apiKey: string
  /** Model alias or id. Empty ⇒ no override. */
  model: string
}

/**
 * The `opencode` vendor's config sub-object: the per-agent launch overrides
 * routed into the OpenCode server's provider resolution. Mirrors the claude
 * shape (the neutral minimal set); each empty field ⇒ no override. OpenCode runs
 * as a c3-supervised local server (ADR-0011 reference vendor, 2026-06-06-003);
 * these overrides flow to that server, not to a per-run CLI env like claude.
 */
export interface OpencodeAgentConfig {
  /** Provider base URL override. Empty ⇒ no override. */
  baseUrl: string
  /** API key / auth token override. Empty ⇒ no override. */
  apiKey: string
  /** Model alias or id (e.g. `anthropic/claude-...`). Empty ⇒ no override. */
  model: string
}

/**
 * The `codex` vendor's config sub-object (2026-06-06-005). The neutral launch
 * overrides (mirroring claude/opencode); each empty string ⇒ no override.
 *
 * Codex has NO per-tool runtime approval (Phase 0 probe 008 NO-GO), so its
 * launch-time policy gate (`sandboxMode` + `approvalPolicy`) is the substitute for
 * in-the-loop allow/deny. That gate is NOT persisted here (2026-06-06-008):
 * instead it is DERIVED at launch from the session's `defaultMode`
 * ({@link SystemSettings.defaultMode}) via the neutral `ActionMode × ToolGate`
 * grid — one permission knob drives every vendor — so a codex agent needs no
 * separate sandbox/approval configuration.
 */
export interface CodexAgentConfig {
  /** OpenAI-compatible base URL override. Empty ⇒ no override. */
  baseUrl: string
  /** API key / auth token override. Empty ⇒ no override. */
  apiKey: string
  /** Model alias or id. Empty ⇒ no override. */
  model: string
}

/**
 * One agent profile under the system-config module: a vendor-agnostic public
 * shell ({@link AgentConfigBase}) plus a `vendor`-discriminated `config`
 * sub-object. A session launches the agent's vendor CLI using its agent (or the
 * default agent when unassigned), routing the `config` per its `vendor` tag.
 *
 * `claude` (ADR-0011 reference), `opencode` (Phase 1 full integration,
 * 2026-06-06-003), and `codex` (read-only advisor seat, Phase 0 008 NO-GO,
 * 2026-06-06-005) all have real adapters and config shapes. The runtime
 * validation/routing lives server-side in `kernel/agent-config/schema.ts` (zod
 * stays out of this zero-runtime, SDK-free wire module — ADR-0009); a type-level
 * assertion there pins the zod schema to this union so the two cannot drift.
 */
export type AgentConfig = AgentConfigBase &
  (
    | { vendor: 'claude'; config: ClaudeAgentConfig }
    | { vendor: 'opencode'; config: OpencodeAgentConfig }
    | { vendor: 'codex'; config: CodexAgentConfig }
  )

/**
 * Multi-agent consensus voting over permission prompts. When enabled, a pending
 * permission request is first put to the *other* configured agents (every agent
 * except the session's own); if they unanimously agree it is auto-resolved,
 * otherwise the human decides with their opinions attached. Off by default.
 */
export interface ConsensusConfig {
  enabled: boolean
  /**
   * Majority rule. Optional; `false`/absent by default (back-compat: existing
   * configs without the field keep the unanimous-only behaviour). When `true`,
   * the consensus auto-resolves on a clear *majority* verdict among the voters
   * instead of requiring **unanimity**; a tie or no clear majority still defers
   * to the human. This is the configuration base for majority adjudication —
   * the tally semantics live in `consensus-tally.ts` (see
   * `permission-gateway/consensus.md`).
   */
  majority?: boolean
}

/**
 * The UI display language for the web console. A short language code (no region
 * subtag). Independent from {@link SystemSettings.voiceLang} (browser speech
 * recognition): the two never read or default off each other. Unset ⇒ `en`.
 * Only `en`/`zh` ship translations today; `ja`/`ko`/`ru` are reserved for the
 * i18n rollout and fall back to `en` messages until translated.
 */
export type UiLang = 'en' | 'zh' | 'ja' | 'ko' | 'ru'

// ---- External skill git mount (ADR-0016) ----

/**
 * How much a {@link SkillRepoConfig}'s content is trusted across updates.
 * - `pinned` — frozen to an exact commit ({@link SkillRepoConfig.pinCommit}); a
 *   `git cat-file` check after clone rejects a force-pushed fake SHA.
 * - `review-on-update` — auto-mounts the configured `ref`, but a content change
 *   since the last mount is surfaced for human review (mount-layer concern, 2/3).
 * - `unreviewed` — mounts whatever `ref` resolves to, no review gate. The default.
 */
export type SkillTrust = 'pinned' | 'review-on-update' | 'unreviewed'

/**
 * Which vendor's skill-discovery directory a repo's skills are mounted into.
 * Reuses {@link VendorId} (single SoT, never drifts from the vendor union) plus
 * `'all'` = mount into every build-link-capable vendor. Per ADR-0016 spike B,
 * `claude`/`codex` are verified mountable; `opencode` stays a valid literal but
 * the mount layer (2/3) does not build links for it until its discovery
 * mechanism is confirmed. Default when unset: `'claude'`.
 */
export type SkillVendor = VendorId | 'all'

/**
 * One external git repository configured as a skill source (ADR-0016). c3 clones
 * it into a shared `~/.c3/repo/` cache and (mount layer, 2/3) soft-links its
 * skills into the target vendor's discovery directory under a flat
 * `_c3_<id>/SKILL.md` layout (spike A: nested dirs are not discovered).
 */
export interface SkillRepoConfig {
  /** Stable, user-meaningful id; globally unique across `skillRepos`. Also the mount dir suffix (`_c3_<id>`). */
  id: string
  /** Git repo address, e.g. `https://github.com/owner/repo` (or an SSH/ssh-config remote). */
  repo: string
  /**
   * Required git ref (branch / tag / commit) to check out. Missing is a hard
   * config error — c3 never silently falls back to the remote's default branch.
   */
  ref: string
  /** Optional sub-directory within the repo that holds the skill(s). Repo root when absent. */
  subpath?: string
  /** Target vendor(s). Default `'claude'` when unset. See {@link SkillVendor}. */
  vendor?: SkillVendor
  /** Update-trust policy. Default `'unreviewed'` when unset. See {@link SkillTrust}. */
  trust: SkillTrust
  /** Required 40-hex commit SHA when `trust === 'pinned'`; verified post-clone via `git cat-file`. */
  pinCommit?: string
}

/**
 * How a target vendor's SKILL-discovery support is reported to the console
 * (mount layer 2/3). Reuses {@link CapabilityState} (single SoT): `full` ⇒ c3's
 * soft-linked `_c3_<id>` skills are discovered and the vendor builds links;
 * `none` ⇒ the vendor's SDK/CLI does not (or cannot be confirmed to) discover
 * them, so c3 builds NO link and the console greys the vendor (the session still
 * launches). `temporarily-unavailable` is the host-down overlay. Persisted in
 * `state.json` and invalidated on an SDK-version change (re-probed).
 */
export type SkillSupportState = CapabilityState

/**
 * Which kind of pre-launch skill-load gate the backend is asking the human to
 * resolve (mount layer 2/3; the modal UI is rendered by 3/3):
 * - `trust` — a `review-on-update` first-load / ref-change ack, or an
 *   `unreviewed` per-mount ack (cancel ⇒ the session does not launch).
 * - `gitignore` — the one-time confirm to append a `_c3_` + wildcard line to the
 *   project's `.gitignore` before the first mount; acked once, then silent.
 * - `orphan` — a boot-time reminder for an `unreviewed`, never-consumed link
 *   left from a prior session (informational; does not block a launch).
 */
export type SkillApprovalKind = 'trust' | 'gitignore' | 'orphan'

/**
 * Per-project (workspace) configuration, keyed by resolved project path in
 * {@link SystemSettings.projectConfigs}. Each project holds its own copy of the
 * 5 workspace-level knobs — independent of every other project's values.
 * Absent or partial entries fall back to the normalized defaults.
 */
export interface ProjectConfig {
  /** Permission mode new sessions start in for this project. Optional; `default` when unset. */
  defaultMode?: PermissionMode
  /** Multi-agent consensus voting on permission prompts. Optional; off by default. */
  consensus?: ConsensusConfig
  /** Slash command (leading `/`) prefixed when launching dev for this project. Optional; empty ⇒ no prefix. */
  devSkill?: string
  /** Per-stage round cap for multi-agent discussions in this project. Minimum 8 (clamped up). */
  maxRoundsPerStage?: number
  /** Per-turn character guidance for participant speech in this project. Minimum 300 (clamped up). */
  maxSpeechChars?: number
  /** External git repositories configured as skill sources (ADR-0016). c3 clones
   * each into a shared `~/.c3/repo/` cache and soft-links its skills into the
   * target vendor's discovery directory. Validated by `getSkillRepos()` (fail-hard).
   * Absent/empty ⇒ no external skills configured for this project. */
  skillRepos?: SkillRepoConfig[]
}

/**
 * The system configuration, persisted at `~/.c3/settings.json`. Always contains
 * the system agent; `defaultAgentId` references an existing agent's id.
 */
export interface SystemSettings {
  agents: AgentConfig[]
  /** Id of the agent new/unassigned sessions launch with. */
  defaultAgentId: string
  /** BCP-47 language tag for browser voice input (e.g. `zh-CN`). `zh-CN` when unset. */
  voiceLang?: string
  /** UI display language for the web console. `en` when unset. Decoupled from
   * {@link voiceLang}. See {@link UiLang}. */
  uiLang?: UiLang
  /**
   * System-wide IANA time zone (e.g. `Asia/Shanghai`, `America/New_York`) used
   * to interpret every schedule's cron fields when computing `next_run_at`. The
   * cron expression `0 11 * * *` means 11:00 in this zone, not 11:00 UTC. The
   * stored `next_run_at` is still an absolute Unix-ms instant; the zone only
   * decides which instant a wall-clock cron maps to (DST-aware). Unset/invalid
   * ⇒ the server's local time zone (`Intl.DateTimeFormat().resolvedOptions().timeZone`).
   * Changing it shifts the actual trigger moment of existing schedules.
   */
  timezone?: string
  /** When true, tool-created sessions (completion judge, consensus advisor) appear
   * in the sidebar session list. Default is false (hidden). */
  showToolSessions?: boolean
  /**
   * @deprecated 2026-06-07 — moved to per-project {@link ProjectConfig}. The server
   * no longer writes this field; kept for backward-compatible typecheck of the web
   * UI which has not yet been migrated to the project-level config model.
   * TODO: remove after SettingsPanel is migrated to project-level config (next task).
   * Prefer the per-project getters (`loadProjectConfig`) for authoritative values.
   */
  defaultMode?: PermissionMode
  /**
   * @deprecated 2026-06-07 — moved to per-project {@link ProjectConfig}. See
   * {@link SystemSettings.defaultMode} deprecation note for the migration plan.
   */
  consensus?: ConsensusConfig
  /**
   * @deprecated 2026-06-07 — moved to per-project {@link ProjectConfig}. See
   * {@link SystemSettings.defaultMode} deprecation note for the migration plan.
   */
  devSkill?: string
  /**
   * @deprecated 2026-06-07 — moved to per-project {@link ProjectConfig}. See
   * {@link SystemSettings.defaultMode} deprecation note for the migration plan.
   */
  maxRoundsPerStage?: number
  /**
   * @deprecated 2026-06-07 — moved to per-project {@link ProjectConfig}. See
   * {@link SystemSettings.defaultMode} deprecation note for the migration plan.
   */
  maxSpeechChars?: number
  /**
   * @deprecated 2026-06-07 — moved to per-project {@link ProjectConfig}. The server
   * no longer writes this field; kept for backward-compatible typecheck of the web
   * UI which has not yet been migrated to the project-level skillRepos config.
   * TODO: remove after SettingsPanel is migrated to project-level config (next task).
   * Prefer the per-project getters (`loadProjectConfig`) for authoritative values.
   * @see ProjectConfig.skillRepos
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
   * Per-project (workspace) configuration map, keyed by resolved project path.
   * Each entry holds the project's own {@link ProjectConfig} — the 5 workspace-level knobs
   * (`defaultMode`, `consensus`, `devSkill`, `maxRoundsPerStage`, `maxSpeechChars`)
   * that were previously global. A project absent from this map falls back to the
   * normalized defaults. Absent/empty ⇒ no project has customised settings yet.
   */
  projectConfigs?: Record<string, ProjectConfig>
}

/** One agent's vote on a pending permission request during consensus voting. */
export interface ConsensusVote {
  /** Voting agent's id. */
  agentId: string
  /** Voting agent's display name. */
  agentName: string
  /** Verdict. `abstain` ⇒ the agent errored or returned no parseable answer. */
  decision: 'allow' | 'deny' | 'abstain'
  /** One-line rationale from the agent. */
  reason: string
}

/**
 * The aggregated result of a consensus vote over the other agents. Produced by
 * the server's consensus orchestrator and surfaced to the console either as an
 * auto-decision (`consensus_auto`) or attached to a `permission_request`.
 */
export interface ConsensusOutcome {
  /** Discriminates from {@link AskConsensusOutcome} on the wire. */
  kind: 'tool'
  /** Each voter's verdict + reason. */
  votes: ConsensusVote[]
  /** Decider-agent (or code-fallback) one-line summary of the opinions. */
  summary: string
  /**
   * True ⇒ every voter returned the same allow/deny verdict (no abstain).
   * Reports **literal** unanimity regardless of the majority toggle, so the UI
   * can distinguish a unanimous outcome from one carried only by a majority
   * (`decision` set while `unanimous` is false).
   */
  unanimous: boolean
  /**
   * The verdict the gateway auto-resolved on, or null ⇒ the human decides.
   * Unanimous-only mode: set only when `unanimous`. Majority mode
   * (`ConsensusConfig.majority`): set on a strict majority of cast votes
   * (abstentions excluded); a tie or no clear majority leaves it null.
   */
  decision: 'allow' | 'deny' | null
  /**
   * The vendor the vote was scoped to (the session's own agent vendor). Consensus
   * is **vendor-homogeneous**: only same-vendor agents vote, because tool names and
   * risk semantics are not comparable across vendors (the heterogeneous-tolerance
   * decision — see `permission-gateway/consensus.md`). The console labels the
   * outcome honestly ("共识限 \<vendor\> 内") rather than implying a cross-vendor vote.
   */
  vendorScope?: VendorId
  /**
   * How many *enabled* agents of a **different** vendor were excluded from voting
   * (would-be voters that a cross-vendor scope dropped). `> 0` ⇒ the console notes
   * the excluded advisors so the human knows the heterogeneous table did not all weigh in.
   */
  crossVendorExcluded?: number
}

/**
 * One voter's answer to ONE question of an `AskUserQuestion` prompt. Unlike the
 * allow/deny vote, the agent picks option label(s) (or writes a custom reply)
 * for each question put to the user.
 */
export interface AgentAnswer {
  agentId: string
  agentName: string
  /** Matched option label(s); empty when the agent only gave a custom reply. */
  optionLabels: string[]
  /** Free-text reply when no option fits (or as an addition). */
  custom?: string
  /** One-line rationale. */
  reason: string
  /** True ⇒ the agent gave no parseable answer for this question (ignored in the tally). */
  abstain?: boolean
}

/** Per-question roll-up of every voter's answer, plus whether they agreed. */
export interface QuestionConsensus {
  /** Index into the original `AskUserQuestion` `questions` array. */
  index: number
  /** Question text — also the key used in the SDK `answers` map. */
  question: string
  header: string
  multiSelect: boolean
  /** Each voter's answer to this question. */
  answers: AgentAnswer[]
  /** True ⇒ every non-abstaining voter chose the same answer (≥1 voter, none abstained). */
  unanimous: boolean
  /** The agreed answer string (SDK format: option labels comma-separated); null when split. */
  agreed: string | null
  /**
   * True ⇒ the string tally was split, but the decider agent judged the advisors
   * to be in effective consensus and supplied {@link agreed}. Distinguishes an
   * AI-adjudicated agreement from a literal unanimous vote (for honest UI/labels).
   */
  decidedByAgent?: boolean
  /**
   * True ⇒ the literal vote was NOT unanimous, but the majority toggle is on and a
   * single answer won a strict plurality of the cast (non-abstaining) votes, which
   * became {@link agreed}. A deterministic pre-step that runs before the decider,
   * so it is mutually exclusive with {@link decidedByAgent}. Distinguishes a
   * majority-carried answer from a literal unanimous vote (for honest UI/labels).
   */
  decidedByMajority?: boolean
}

/**
 * Consensus over an `AskUserQuestion` prompt: voters answer each question rather
 * than vote allow/deny. When every question is unanimous the gateway can answer
 * on the user's behalf; otherwise the human fills in the answers (split questions
 * highlighted, agreed ones pre-filled). Surfaced like {@link ConsensusOutcome}.
 */
export interface AskConsensusOutcome {
  kind: 'ask'
  /** One roll-up per question, in original order. */
  perQuestion: QuestionConsensus[]
  /** True ⇒ every question is unanimous — eligible for auto-answer. */
  fullyUnanimous: boolean
  /** Pre-built `answers` map (question text → agreed answer) for the unanimous questions. */
  agreedAnswers: Record<string, string>
  /** Decider-agent (or code-fallback) one-line summary. */
  summary: string
  /** The vendor the vote was scoped to — see {@link ConsensusOutcome.vendorScope}. */
  vendorScope?: VendorId
  /** Same-vendor scope's excluded cross-vendor count — see {@link ConsensusOutcome.crossVendorExcluded}. */
  crossVendorExcluded?: number
}

/** Either consensus shape, discriminated by `kind`. */
export type AnyConsensusOutcome = ConsensusOutcome | AskConsensusOutcome

/**
 * One available slash command / skill for the input-box autocomplete menu.
 * Mirrors the SDK `SlashCommand` shape but is declared here to keep the wire
 * protocol independent of SDK types (the boundary rule). Covers both built-in
 * commands and Skills (user + project), exactly what the CLI lists on `/`.
 */
export interface SlashCommandInfo {
  /** Command/skill name without the leading slash. */
  name: string
  /** What the command/skill does. */
  description: string
  /** Hint for arguments, e.g. "<file>" (may be empty). */
  argumentHint: string
  /** Alternate names that resolve to this command (e.g. /cost → /usage). */
  aliases?: string[]
}

// ---- Canonical agent message model (vendor-neutral) ----
//
// The wire SoT for the vendor-neutral envelope (ADR-0011 → ADR-0013). The
// canonical model was first defined inside `kernel/agent/adapters/types.ts`
// (011); 013 promotes the definitions here so the WIRE only ever gains a
// `vendor` dimension — it does NOT start a second schema per vendor. The kernel
// re-exports these (single SoT); `shared/protocol.ts` stays zero-runtime and
// SDK-free: NO `@anthropic-ai/claude-agent-sdk` (or any vendor SDK) type appears
// here (ADR-0009). SDK values are narrowed to canonical shapes inside each
// adapter before they ever travel on the wire.

/** The agent vendors c3 can drive. New vendors extend this union (ADR-0011). */
export type VendorId = 'claude' | 'codex' | 'opencode'

/**
 * One vendor's host-CLI presence (ADR-0012), surfaced to the web so the
 * new-session agent picker can grey out an agent whose binary is not on PATH and
 * the settings diagnostics panel can list what is/isn't installed. No absolute
 * path is sent (operator-facing guidance only, never a filesystem detail).
 */
export interface VendorHostStatus {
  vendor: VendorId
  /** Whether the vendor's host CLI was resolved on PATH (or via its `*_PATH` override). */
  present: boolean
  /** The probed executable name (e.g. `claude`). */
  binary: string
  /** Operator-facing install guidance shown when the binary is missing. */
  installHint: string
}

/**
 * Session→agent binding counts (ADR-0015) shown in the settings console to make
 * concrete that changing the default agent is **not** retroactive: every already
 * recorded session keeps its own agent (and frozen vendor); only future sessions
 * adopt the new default.
 */
export interface SessionBindingStats {
  /** Real sessions with a frozen vendor *fact* — they keep their agent/vendor. */
  bound: number
  /** Pending sessions with an explicit *intent*, not yet bound by a first run. */
  pending: number
}

/**
 * The wire-facing capability enum (the names of every optional/degradable
 * adapter capability). The kernel's `AdapterCapabilities` boolean ledger is
 * keyed by exactly these names; a type-level assertion there pins the two
 * together so they cannot drift. "Required" capabilities (start/messages/abort/
 * list/read/onRequest) are the unconditional interface contract and are NOT
 * enumerated here — only the probed, degradable ones are.
 */
export type AdapterCapability =
  | 'interrupt'
  | 'setActionMode'
  | 'streamingPush'
  | 'inProcessMcp'
  | 'forkSession'
  | 'perToolApproval'

/**
 * A structured capability *state* — the honest grade of a degradable ability,
 * richer than a `boolean` (ADR-0011 addendum). Where the six {@link AdapterCapability}
 * live-run controls are genuinely binary (a vendor either has a mid-turn interrupt
 * point or it does not), the **session-lifecycle** operations admit intermediate
 * grades a flag cannot express:
 *  - `'none'`    — the vendor has no such ability at all (Codex has no listing/read
 *                  API; its store returns empty rather than fabricate a transcript).
 *  - `'partial'` — the ability exists but is reduced (e.g. resumes the thread but
 *                  cannot reconstruct full prior history).
 *  - `'full'`    — first-class support (the Claude reference grade).
 *  - `'temporarily-unavailable'` — the ability normally exists but is unreachable
 *                  *right now* (a remote-backed vendor like OpenCode whose REST
 *                  server is down). Distinct from `'none'`: the upper layer/UI
 *                  degrades softly (greyed-out, "try again later") rather than
 *                  hiding the affordance as structurally absent.
 */
export type CapabilityState = 'none' | 'partial' | 'full' | 'temporarily-unavailable'

/**
 * The session-lifecycle operations whose support a vendor self-reports as a
 * {@link CapabilityState} (ADR-0011 addendum). Unlike the binary
 * {@link AdapterCapability} live-run controls, these were the "required, unflagged"
 * contract — but Phase 0 proved that contract is NOT universal (Codex has neither
 * `list` nor `read`), so they are graded honestly instead. The kernel's
 * `SessionCapabilities` is keyed by exactly these names (a type-level assertion
 * pins the two together so they cannot drift).
 */
export type SessionCapability = 'list' | 'read' | 'resume' | 'rename' | 'delete'

/**
 * A vendor's graded support for each session-lifecycle operation (ADR-0011
 * addendum). The upper layer (and UI) reads a state and degrades by it — never by
 * vendor identity — so a new vendor that self-reports its grades is correctly
 * degraded with no `if (vendor === …)` branch anywhere above the adapter.
 */
export interface SessionCapabilities {
  /** Enumerate a workspace's sessions. Codex: `'none'` (the SDK has no listing API). */
  readonly list: CapabilityState
  /** Back-read a session's history as canonical messages. Codex: `'none'`. */
  readonly read: CapabilityState
  /** Continue an existing session by id (vendor-native resume). */
  readonly resume: CapabilityState
  /** Rename a session. Only the vendors whose store supports it report above `'none'`. */
  readonly rename: CapabilityState
  /** Delete a session. Only the vendors whose store supports it report above `'none'`. */
  readonly delete: CapabilityState
}

/**
 * Live runtime reachability of the c3-supervised OpenCode REST server — a
 * **first-class wire signal** (2026-06-07-003). Unlike Claude/Codex (a CLI
 * subprocess per run) OpenCode is a long-lived local server every back-read /
 * resume talks to; its up/down state is therefore real product state the console
 * must reflect, not an internal detail. The server is lazily (re)started on
 * demand (`select_session` of an opencode session) with a short grace window;
 * failure degrades honestly (this signal flips to `temporarily-unavailable`) and
 * a background loop self-heals — it is never fatal.
 *
 * `reachability` reuses {@link CapabilityState} so the degraded state is expressed
 * by the *same* enum as the session-lifecycle capability ledger (the UI degrades
 * by state, never by vendor): `'full'` = the server is up, `'temporarily-unavailable'`
 * = registered but currently down / starting / retrying, `'none'` = opencode is not
 * registered at all (no host CLI and no `--opencode-url`). `'partial'` is unused.
 * Pushed to every connection on each state transition and as a snapshot on connect.
 */
export interface OpencodeServerStatus {
  /** Graded reachability of the supervised server (`'full'`/`'temporarily-unavailable'`/`'none'`). */
  reachability: CapabilityState
  /** True while a lazy (re)start / self-heal attempt is in flight — drives the "retrying…" hint. */
  retrying: boolean
  /** The base URL the server is listening on when up (operator-facing; absent when down/unregistered). */
  url?: string
}

/**
 * The only role the canonical model commits to. Codex carries no role on its
 * items and must synthesize one (item-type → role); Claude/OpenCode carry it
 * natively. `system`/`result` SDK frames are NOT messages — they map to side
 * channels (session id, turn end) or the {@link ApprovalBridge} stream, never to
 * a CanonicalMessage.
 */
export type CanonicalRole = 'user' | 'assistant'

/**
 * A tool's return, embedded on its {@link CanonicalBlock} `tool_use` (011 D3
 * ruling): there is NO standalone `tool_result` block.
 */
export interface CanonicalToolResult {
  /** Flattened display content (vendor result shapes collapse to a string). */
  content: string
  /** Whether the tool errored. */
  isError: boolean
  /** Block-result overflow: Codex `exit_code`/`aggregated_output`, … */
  vendorExtra?: Record<string, unknown>
}

/**
 * A content block. **011 D3 ruling:** there is NO standalone `tool_result`
 * block — a tool's return is embedded as `tool_use.result`, back-filled by
 * id-upsert when it arrives. This matches the incremental vendors (Codex
 * collapses a tool into a single in-place item; OpenCode correlates by `callID`)
 * more naturally than Claude's two-block split, which the Claude adapter folds
 * inward.
 *
 * The union is the **three-vendor common set** (`text`/`thinking`/`tool_use`).
 * Vendor-unique kinds (Codex `reasoning`, OpenCode `diff`, …) are NOT promoted
 * to their own variant yet (ADR-0013 D-D: no adapter produces them); they ride
 * `vendorExtra`. A future `vendorTag`-discriminated escape variant is the
 * extension point. `thinking.signature` / `redacted_thinking` drop to
 * `vendorExtra` (encrypted, cross-vendor-meaningless). Block `id` exists for
 * upsert correlation, not cross-vendor identity.
 */
export type CanonicalBlock =
  | {
      type: 'text'
      text: string
      id?: string
      vendorExtra?: Record<string, unknown>
    }
  | {
      type: 'thinking'
      thinking: string
      id?: string
      vendorExtra?: Record<string, unknown>
    }
  | {
      type: 'tool_use'
      /** Correlation id (Claude `tool_use.id`, OpenCode `callID`, Codex item id). */
      id: string
      name: string
      input: unknown
      /** Embedded return, absent until the tool completes (D3 in-place back-fill). */
      result?: CanonicalToolResult
      vendorExtra?: Record<string, unknown>
    }

/**
 * A vendor-spanning message envelope. The 010 diff pinned the true common set:
 * `vendor`/`sessionId` are unconditional; `role`/`blocks`/`ts`/`turnId?` carry a
 * discount (synthesized, append-with-upsert, c3-stamped, or droppable). Anything
 * that does not survive all three vendors lands in {@link vendorExtra}, never the
 * top level ("宁丢勿强塞" — drop before you fake a union).
 *
 * **Two-form upsert (ADR-0013).** Blocks are append-with-**id-upsert**, not
 * append-only: a consumer keys blocks by `(sessionId, block.id)`. Both vendor
 * forms collapse to this rule — Claude emits a whole message (full block set,
 * idempotent re-emit) and Codex emits incremental `ItemUpdated` frames that
 * revise an earlier block in place. Approval/permission events are NOT part of
 * this model — they ride the {@link ApprovalBridge} stream so the envelope never
 * becomes a god type.
 */
export interface CanonicalMessage {
  /** Which vendor produced this (010: the `vendor` tag is required, not optional). */
  vendor: VendorId
  /** The one unconditional common field. Source: `session_id`/`threadId`/`sessionID`. */
  sessionId: string
  /** Turn grouping. Semantics differ per vendor and are not uniformly available — droppable. */
  turnId?: string
  /** `assistant` for model output; `user` for prompts/tool returns. Codex synthesizes this. */
  role: CanonicalRole
  /**
   * Append-only with **id-upsert**: incremental vendors (Codex item, OpenCode
   * part) revise an earlier block in place rather than stacking a new one, so a
   * consumer keys blocks by {@link CanonicalBlock} id, not array position.
   */
  blocks: CanonicalBlock[]
  /**
   * c3 ingest timestamp (epoch ms), NOT a vendor-authoritative value — only
   * OpenCode carries a real `time`; Claude/Codex do not. The vendor's own time,
   * if any, goes to {@link vendorExtra}.
   */
  ts: number
  /**
   * Audit marker: this turn's tool call(s) were auto-allowed by the vendor's own
   * permission rule engine WITHOUT a c3/human decision — i.e. c3 observed the
   * vendor reply to its own `permission.asked` (OpenCode: a `permission.replied`
   * with no matching c3 write-back) and is reconstructing the bypass for the
   * audit trail (2026-06-06-003). Absent/`false` ⇒ a normal turn (either no
   * approval was needed, or c3/the human decided it). This is the ONE top-level
   * approval-derived field on the envelope; the live approval *request* stream
   * still rides the {@link ApprovalBridge}, never the message model.
   */
  preApproved?: boolean
  /** Envelope-level overflow: `usage`, `parent_tool_use_id`, vendor `time`, … */
  vendorExtra?: Record<string, unknown>
}

// ---- Intent management ----

/** Intent priority. `P0` highest … `P3` lowest. */
export type IntentPriority = 'P0' | 'P1' | 'P2' | 'P3'

/**
 * Intent lifecycle status.
 * - `draft` — captured but not yet finalized (optional).
 * - `todo` — finalized, not started (the state save-to-db produces).
 * - `in_progress` — development launched (dev session running).
 * - `done` / `cancelled` — terminal, set by the user (never auto-set).
 */
export type IntentStatus = 'draft' | 'todo' | 'in_progress' | 'done' | 'cancelled'

/**
 * Derived run-state of an in_progress intent, computed by reconciling the
 * intent's lastDevSessionId liveness against the process table.
 * - `running` — the dev session's process is still alive (tracking in-flight).
 * - `dangling` — the dev process is dead but the intent is still in_progress
 *   (service restart / crash); a completion judge found the intent not done.
 * - `idle` — not in_progress, or the dev process ended and the judge confirmed done
 *   (just done, or never started).
 */
export type IntentRunStatus = 'running' | 'dangling' | 'idle'

/** One persisted intent, scoped to a project (workspace path). */
export interface Intent {
  /** Stable uuid. */
  id: string
  /** Owning project — the workspace absolute path (resolved). */
  projectPath: string
  title: string
  content: string
  priority: IntentPriority
  /** Owning module name, inferred by the comm agent from title/content. `''` when historic/unidentified. */
  module: string
  status: IntentStatus
  /** Ids of other intents (same project) this one depends on. */
  dependsOn: string[]
  /** The last dev session launched for this intent, for the detail back-link. */
  lastDevSessionId: string | null
  /**
   * Whether the automation orchestrator may pick this intent up. User-toggled
   * (a checkbox per intent); `false` by default. Only `automate` intents
   * are developed by `start_automation`.
   */
  automate: boolean
  createdAt: number
  updatedAt: number
  /** When the intent entered `done`; `null` until completed, cleared if it leaves `done`. */
  completedAt: number | null
  /**
   * Derived run-state of an `in_progress` intent, computed at list-time by
   * the server's reconcile logic. `'idle'` for other statuses. Clients use this
   * to render a "tracking" badge or a "dangling" warning next to an in_progress item.
   */
  runStatus: IntentRunStatus
}

/**
 * Lifecycle of the per-project automation orchestrator (a single background loop
 * that develops `automate` intents one by one, by priority + dependencies).
 * - `idle` — not running (never started, or stopped by the user).
 * - `running` — actively developing intents.
 * - `done` — finished: no more eligible intents remain.
 * - `error` — stopped abnormally (a dev run errored, blocked on a permission, a
 *   completion check failed, or commit/push failed). `error` text says why.
 */
export type AutomationState = 'idle' | 'running' | 'done' | 'error'

/** A project's automation orchestrator status, broadcast to every connection. */
export interface AutomationStatus {
  /** Owning project — the workspace absolute path (resolved). */
  projectPath: string
  state: AutomationState
  /** The intent currently being developed (null when not running). */
  currentIntentId: string | null
  /** The dev session of the current intent, for a back-link (null when none). */
  currentSessionId: string | null
  /**
   * True while the current dev turn is paused on a permission prompt awaiting a
   * human answer (automation mirrors manual: it does NOT abort, it waits for the
   * watching human to answer in the browser). Cleared once the turn settles.
   */
  awaitingPermission: boolean
  /** Why the orchestrator stopped abnormally; null unless `state === 'error'`. */
  error: string | null
  /** Intent ids completed (committed + pushed) in this run. */
  completedIds: string[]
  /** When the orchestrator was started, ms since epoch; null when never started. */
  startedAt: number | null
}

/**
 * One intent proposed by the intent-communication agent via the
 * `save_intents` tool. Rendered in the confirmation prompt; persisted with
 * status `todo` once the user allows.
 */
export interface ProposedIntent {
  title: string
  content: string
  priority: IntentPriority
  /** Module name the comm agent inferred from title/content; persisted as `''` when omitted. */
  module?: string
  /** Optional ids of existing intents (same project) it depends on. */
  dependsOn?: string[]
  /**
   * Optional 0-based indexes into THIS batch's `intents` array, naming
   * sibling proposed intents this item depends on. Sibling ids don't exist
   * yet at proposal time, so intra-batch ordering can only be expressed by index;
   * `insertIntents` resolves each index to the sibling's freshly-minted id and
   * merges it into `dependsOn`. Complements (does not replace) `dependsOn`.
   * Validated on save: an out-of-range, self, or cyclic reference rejects the whole
   * batch (nothing is written). See RM-R17.
   */
  dependsOnIndexes?: number[]
}

// ---- Discussion ----

/**
 * Discussion lifecycle status.
 * - `draft` — created, not yet started.
 * - `in_progress` — discussion underway.
 * - `completed` — concluded; stamps `completedAt`.
 * - `cancelled` — abandoned (terminal, no completion stamp).
 */
export type DiscussionStatus = 'draft' | 'in_progress' | 'completed' | 'cancelled'

/**
 * Who authored a discussion message.
 * - `organizer` — the discussion organizer/orchestrator.
 * - `agent` — a participating agent (identified by `speakerAgentId`/`speakerName`).
 * - `human` — the user.
 */
export type DiscussionSpeakerKind = 'organizer' | 'agent' | 'human'

/** One persisted discussion, scoped to a project (workspace path). */
export interface Discussion {
  /** Stable uuid. */
  id: string
  /** Owning project — the workspace absolute path (resolved). */
  projectPath: string
  title: string
  /** Free-form discussion type/category. */
  type: string
  /** What the discussion aims to achieve. */
  goal: string
  /** Background material seeding the discussion — the user's original input, never overwritten. */
  context: string
  /**
   * The read-only research agent's completed output, stored independently of the user's
   * `context` (which stays as entered). `''` until research produces a non-empty result
   * (or when research is skipped/fails).
   */
  researchResult: string
  status: DiscussionStatus
  /**
   * Ordered subtopics the organizer decomposed `goal` into (the explicit agenda).
   * `[]` when no agenda has been set. Only meaningful in the `discuss` stage.
   */
  agenda: string[]
  /**
   * 0-based index of the current subtopic within `agenda` (range `0..agenda.length`).
   * Items before it are done; `agendaIndex === agenda.length` means all subtopics
   * are complete. Completion status is derived from this index (strictly forward).
   */
  agendaIndex: number
  /** The concluded outcome; `null` until set. */
  conclusion: string | null
  createdAt: number
  updatedAt: number
  /** When the discussion entered `completed`; `null` otherwise. */
  completedAt: number | null
}

/** One message within a discussion, ordered by `seq` (per-discussion monotonic). */
export interface DiscussionMessage {
  /** Stable uuid. */
  id: string
  /** The owning discussion's id. */
  discussionId: string
  /** Per-discussion monotonic sequence number (1-based, assigned on append). */
  seq: number
  speakerKind: DiscussionSpeakerKind
  /** The participating agent's id when `speakerKind === 'agent'`; else `null`. */
  speakerAgentId: string | null
  /** Display name of the speaker; `null` when not applicable. */
  speakerName: string | null
  content: string
  createdAt: number
}

/**
 * One streamed item from a discussion's read-only research run. Runtime-only —
 * NOT persisted (unlike `DiscussionMessage`), mirroring `discussion_dispatch_status`:
 * a reconnect mid-research reconciles the run's liveness from the `researchStates`
 * snapshot but does not replay the transcript; later live items still append.
 * `seq` is monotonic (1-based) within a single research run.
 */
export interface ResearchMessage {
  discussionId: string
  seq: number
  /** `text` = an assistant turn's text; `tool` = a tool-activity marker (`content` is the tool name). */
  kind: 'text' | 'tool'
  content: string
  createdAt: number
}

// ---- Schedules ----

export type ScheduleType = 'command' | 'llm'

export type McpMode = 'read-only' | 'sandboxed' | 'full-access'

export type ScheduleStatus = 'active' | 'paused' | 'error'

export interface Schedule {
  id: string
  type: ScheduleType
  /**
   * Arbitrary JSON configuration, interpreted by the cron runner per `type`.
   * Holds `config.name` — a display name auto-generated by the server on
   * create (never client-supplied). There is no `description` field; any in
   * legacy rows is ignored.
   */
  config: unknown
  /** Owning workspace absolute path (resolved). */
  workspacePath: string
  cronExpression: string
  /** Unix ms timestamp of the next planned run; null when not scheduled. */
  nextRunAt: number | null
  status: ScheduleStatus
  mcpMode: McpMode
  toolAllowlist: string[]
  toolDenylist: string[]
  createdAt: number
  updatedAt: number
}

/**
 * Fields the client supplies when creating a schedule.
 *
 * `config` carries the task body (`command` or `prompt`) but NOT a name or
 * description: the server auto-generates `config.name` from the task content
 * and strips any client-supplied `name`/`description`.
 */
export interface CreateScheduleInput {
  type: ScheduleType
  config: unknown
  workspacePath: string
  cronExpression: string
  mcpMode: McpMode
  toolAllowlist?: string[]
  toolDenylist?: string[]
}

/** Fields the client may supply when updating a schedule. All optional. */
export interface UpdateScheduleInput {
  type?: ScheduleType
  config?: unknown
  cronExpression?: string
  mcpMode?: McpMode
  toolAllowlist?: string[]
  toolDenylist?: string[]
  status?: ScheduleStatus
}

export interface ScheduleExecutionLog {
  id: string
  scheduleId: string
  startedAt: number
  finishedAt: number | null
  exitCode: number | null
  output: string
  error: string | null
  /** Current status: 'running' | 'success' | 'failed' | 'cancelled' */
  status: string | null
  /**
   * Agent session id for `llm`-type executions; null for `command` type or when
   * the run never started a session. Used to load the run's transcript on demand.
   */
  sessionId: string | null
}

// ---- Schedule MCP Security ----

/** One pending write operation approval for a sandboxed schedule execution. */
export interface PendingWriteApproval {
  id: string
  scheduleId: string
  /** Owning workspace absolute path (resolved). */
  workspacePath: string
  toolName: string
  /** The tool call input (shown for diff review). */
  toolInput: unknown
  /** Server-generated diff/preview summary. */
  diffPreview: string
  createdAt: number
  expiresAt: number
  /** 'pending' | 'approved' | 'rejected' | 'expired' */
  status: string
  resolvedBy: string | null
  resolvedAt: number | null
}

/** Workspace-level MCP server connections and denylist configuration. */
export interface WorkspaceMcpConfig {
  /** MCP server connection definitions, keyed by server name. */
  mcpServers: Record<
    string,
    {
      command: string
      args?: string[]
      env?: Record<string, string>
    }
  >
  /** Workspace-level global denylist (subtraction-based disable). */
  denylist: string[]
}

// Client → Server
export type ClientToServer =
  | { type: 'user_prompt'; text: string }
  /**
   * Answer a pending permission request. For `AskUserQuestion`, an `allow` may
   * carry `answers` (question text → selected option label(s) / custom reply,
   * multi-select comma-separated) which the gateway injects into the tool input.
   */
  | {
      type: 'permission_response'
      requestId: string
      decision: 'allow' | 'deny'
      answers?: Record<string, string>
    }
  /** Change the active session's permission mode (per-session, persisted). */
  | { type: 'set_mode'; mode: PermissionMode }
  /**
   * Re-target a session's agent within its frozen vendor (ADR-0015): rewrites the
   * `sessionAgents` fact so the session's next turn `resume`s with `agentId`. The
   * server rejects a cross-vendor change (reply `session_agent_changed { ok:false }`,
   * fact untouched). The console only offers same-vendor candidates, so a rejection
   * is a defensive guard, not an expected path.
   */
  | { type: 'set_session_agent'; sessionId: string; agentId: string }
  /** Register a project directory as a workspace. */
  | { type: 'add_workspace'; path: string }
  /** Remove a workspace from the sidebar (does not delete its sessions on disk). */
  | { type: 'remove_workspace'; path: string }
  /** List sessions for a workspace (server replies with `sessions`). */
  | { type: 'list_sessions'; workspacePath: string }
  /**
   * Create a new (pending) session in a workspace and make it active. The
   * optional `agentId` is the agent the new session should run on (ADR-0015): it
   * is recorded as the pending session's mutable *intent*, so the first run
   * launches with it (and freezes that agent's vendor onto the session). Absent
   * or empty ⇒ **Auto** — no intent is written and the run falls back to the
   * configured `defaultAgentId`.
   */
  | { type: 'create_session'; workspacePath: string; agentId?: string }
  /** Delete a session from disk. */
  | { type: 'delete_session'; workspacePath: string; sessionId: string }
  /**
   * Make a session active; server replies with `session_selected` (history + mode).
   * Optional `vendor` is a caller-supplied hint for resume-by-id of a session the
   * projection has never seen — used when a vendor cannot be enumerated (Codex):
   * the user pastes a native session id, and the hint lets the server skip the
   * Claude-only cold-load path, seed an empty baseline, and bind the id to a
   * vendor-matching agent so the next turn resumes natively. Absent ⇒ the server
   * resolves the vendor from its own facts (the normal, already-known path).
   */
  | { type: 'select_session'; workspacePath: string; sessionId: string; vendor?: VendorId }
  /** Rename a session's title. */
  | { type: 'rename_session'; workspacePath: string; sessionId: string; title: string }
  /** Stop the in-flight run of the currently-viewed session (if any). */
  | { type: 'stop_run' }
  /** List slash commands/skills for the active session's cwd (reply: `commands`). */
  | { type: 'list_commands' }
  /** Fetch the system configuration (reply: `settings`). */
  | { type: 'get_settings' }
  /** Replace the system configuration; server normalizes and echoes `settings`. */
  | { type: 'save_settings'; settings: SystemSettings }
  /** Load the project configuration for a workspace (reply: `project_config`). */
  | { type: 'load_project_config'; projectPath: string }
  /** Save the project configuration for a workspace. */
  | { type: 'save_project_config'; projectPath: string; config: ProjectConfig }
  /** List a project's intents (reply: `intents`), optionally filtered by status. */
  | { type: 'list_intents'; projectPath: string; status?: IntentStatus }
  /**
   * Enter the intent view for a project: open or resume its (persisted)
   * communication session and return the intent list. Replies with a
   * `session_selected` for the comm session plus a `intents` list.
   */
  | { type: 'open_intent_chat'; projectPath: string }
  /**
   * Start a brand-new communication session for a project: resets the previous
   * `is_current` comm session to 0, creates a fresh one marked current, and
   * replies with a `session_selected` (empty history) plus the `intents`
   * list. The "+" button in the intent view title bar triggers this.
   */
  | { type: 'new_intent_chat'; projectPath: string }
  /**
   * Restart the comm session as a fresh one seeded with a intent to refine;
   * the server injects the first prompt with the intent's id and content.
   */
  | { type: 'refine_intent'; projectPath: string; intentId: string }
  /**
   * Bridge a completed discussion's conclusion into the intent domain: a
   * `refine_intent` variant whose seed is the discussion's conclusion rather
   * than an existing intent. The server resolves the project from the
   * discussion, restarts the comm session as a fresh one, injects a first prompt
   * carrying the discussion title + conclusion, and replies with a
   * `session_selected` (empty history) plus the `intents` list. Rejected if
   * the discussion is missing, not `completed`, or has no conclusion. The agent
   * then splits it into intents via the unchanged `save_intents` flow.
   */
  | { type: 'discussion_to_intent'; discussionId: string }
  /** Launch a background dev session for a `todo` intent via the configurable development skill. */
  | { type: 'start_development'; projectPath: string; intentId: string }
  /** Manually set a intent's status (e.g. mark done/cancelled). */
  | { type: 'update_intent_status'; intentId: string; status: IntentStatus }
  /** Toggle a intent's automation flag (whether the orchestrator may pick it). */
  | { type: 'set_intent_automate'; intentId: string; automate: boolean }
  /** Start the project's automation orchestrator (develops `automate` intents). */
  | { type: 'start_automation'; projectPath: string }
  /** Stop the project's automation orchestrator (aborts the current dev run). */
  | { type: 'stop_automation'; projectPath: string }
  /** List a project's discussions (reply: `discussions`), optionally filtered by status. */
  | { type: 'list_discussions'; projectPath: string; status?: DiscussionStatus }
  /**
   * Create a discussion from the "+" form. The server persists it as `draft`
   * (title derived from `goal`), **replies to the creating connection with
   * `discussion_detail`** so the right pane opens the new discussion immediately,
   * and pushes a refreshed `discussions` list. It then runs a read-only research
   * agent that reads project material + searches the web to complete its `context`
   * (pushing `discussions` again); **on success the server auto-starts the
   * orchestration** (equivalent to an automatic `start_discussion`, re-validating
   * the discussion is still a `draft` with no live run). Research failure leaves it
   * a `draft` for a manual Start (the title bar reads "Researching…" until it
   * auto-starts). `type` must name a known discussion type (see `discussion-types.ts`).
   */
  | {
      type: 'create_discussion'
      projectPath: string
      discussionType: string
      goal: string
      context?: string
    }
  /**
   * Open a discussion: enter the discussion view for one discussion and return
   * it together with its full message history. Replies with `discussion_detail`.
   */
  | { type: 'open_discussion'; discussionId: string }
  /**
   * Start the organizer-driven orchestration of a `draft` discussion. The server
   * flips it to `in_progress` and runs the engine in the background: the organizer
   * (the default agent) picks speakers among the configured agents and drives the
   * type's workflow (discuss → summarize → confirm → conclude), each turn a
   * one-shot `askAgentOnce` over the current transcript. Every speech is appended
   * and streamed back as `discussion_message`; the run ends by writing the
   * `conclusion` and flipping to `completed`. A no-op if already running or not a
   * `draft`. The background run does not end any session (既有 session 约定).
   */
  | { type: 'start_discussion'; discussionId: string }
  /**
   * Pause a live discussion orchestration: the engine suspends at the next round
   * boundary, so no new organizer decision or agent speech happens until resumed
   * (an already in-flight one-shot turn may still finish). No-op if the discussion
   * has no live run or is already paused. The frontend reflects it via the
   * `discussion_run_status` (`paused`) event.
   */
  | { type: 'pause_discussion'; discussionId: string }
  /**
   * Resume a paused discussion orchestration: the engine continues from where it
   * suspended (its local stage/round state is preserved). No-op if not paused.
   */
  | { type: 'resume_discussion'; discussionId: string }
  /**
   * Human interjection into a live discussion ("I want to speak"): the server
   * pauses the run, appends a `human` message, and resumes — so the organizer's
   * next round sees it. Requires a live run (running or paused); when the
   * discussion is `in_progress` without a live run, the message is simply appended.
   */
  | { type: 'discussion_speak'; discussionId: string; text: string }
  /**
   * Drive a *new round* on a `completed` discussion: the server appends the
   * human's follow-up question/intent as a `human` message, flips the
   * discussion back to `in_progress`, and re-runs the organizer engine over the
   * full transcript (the prior conclusion + the new question as context). The run
   * walks the workflow again and writes a fresh `conclusion`. Rejected if the
   * discussion is not `completed` or already has a live run.
   */
  | { type: 'continue_discussion'; discussionId: string; text: string }
  /** Pull the authoritative session-status snapshot (session-layer heartbeat). */
  | { type: 'request_session_status' }
  /** Create a schedule in a workspace; server broadcasts `schedules`. */
  | { type: 'create_schedule'; workspacePath: string; input: CreateScheduleInput }
  /** List schedules in a workspace; server replies with `schedules`. */
  | { type: 'list_schedules'; workspacePath: string }
  /** Partial update of a schedule; server broadcasts `schedules`. */
  | { type: 'update_schedule'; scheduleId: string; input: UpdateScheduleInput }
  /** Delete a schedule; server broadcasts `schedules`. */
  | { type: 'delete_schedule'; scheduleId: string }
  /** Get full schedule detail with execution logs; server replies with `schedule_detail`. */
  | { type: 'get_schedule_detail'; scheduleId: string }
  /**
   * Read one `llm`-type execution's agent session transcript (read-only replay);
   * server replies with `execution_transcript`.
   */
  | { type: 'get_execution_transcript'; scheduleId: string; executionId: string }
  /** Manual trigger: execute a schedule immediately (outside normal tick). */
  | { type: 'schedule_run_now'; scheduleId: string }
  /** Get workspace-level MCP server configuration. */
  | { type: 'get_workspace_mcp_config'; workspacePath: string }
  /** Save workspace-level MCP server configuration. */
  | {
      type: 'save_workspace_mcp_config'
      workspacePath: string
      config: WorkspaceMcpConfig
    }
  /** List pending write approvals for a workspace. */
  | { type: 'list_pending_write_approvals'; workspacePath: string }
  /** Approve or reject a pending write approval. */
  | {
      type: 'approve_write_approval'
      approvalId: string
      decision: 'approve' | 'reject'
    }
  /**
   * Resolve a pending pre-launch skill-load gate (mount layer 2/3). `approve`
   * lets the mount proceed and (for `trust`/`gitignore`) persists the ack;
   * `cancel` aborts the mount — for an `unreviewed` `trust` gate that means the
   * session does not launch. Correlated to a {@link SkillLoadApprovalRequest} by
   * `requestId`.
   */
  | { type: 'skill_load_approval_resolve'; requestId: string; decision: 'approve' | 'cancel' }
  | { type: 'ping' }

// Server → Client
export type ServerToClient =
  /** Handshake: full workspace list + which session is active (if any) + live run statuses. */
  | {
      type: 'ready'
      workspaces: WorkspaceInfo[]
      activeSessionId: string | null
      statuses: SessionRunStatus[]
    }
  /** Live run statuses for all sessions with a runtime; drives sidebar badges. */
  | { type: 'session_status'; statuses: SessionRunStatus[] }
  /**
   * The supervised OpenCode server's live reachability (2026-06-07-003) — a
   * first-class signal pushed on every state transition (up/down/retrying) and as
   * a snapshot on connect. Drives the session-list offline warning; the same state
   * also overlays `settings.sessionCapabilities.opencode` (list/read/resume degrade
   * to `'temporarily-unavailable'` while down) so the whole UI degrades by state.
   */
  | { type: 'opencode_status'; status: OpencodeServerStatus }
  /** Full workspace list, sorted by recent access (desc). */
  | { type: 'workspaces'; workspaces: WorkspaceInfo[] }
  /** Session list for one workspace, sorted by last-modified (desc). */
  | { type: 'sessions'; workspacePath: string; sessions: SessionInfo[] }
  /**
   * A session became active in this connection's view; carries its mode and
   * replayed history. `status` is the runtime's authoritative live status at
   * selection time — the client seeds its per-session status map from it so the
   * composer locks immediately, without waiting for the next status broadcast
   * (the source of a stale "ready" window on a background-running session). For a
   * session viewed while running in the background, the live tail follows as
   * normal stream events after this message.
   */
  | {
      type: 'session_selected'
      workspacePath: string
      sessionId: string
      title: string
      mode: PermissionMode
      history: TranscriptItem[]
      status: SessionStatus
      /**
       * The session's resolved agent vendor (ADR-0015) — a real session's frozen
       * vendor, or a pending session's intent/default vendor — used to paint the
       * vendor colour dot beside the title. Absent for comm/intent sessions
       * (no agent dot there).
       */
      vendor?: VendorId
      /**
       * Data for the title-bar same-vendor agent switcher (ADR-0015 / AS-R22): the
       * other **same-vendor, host-binary-present, enabled** agents this session may
       * switch to (cross-vendor never appears — vendor is frozen), plus whether the
       * current agent's host CLI is missing. Present only for a real, non-comm
       * session that actually has switch candidates; absent otherwise (no switcher).
       */
      agentSwitch?: SessionAgentSwitch
    }
  /** Binds a pending session's `clientId` to its real SDK `sessionId`. */
  | { type: 'session_started'; clientId: string; sessionId: string }
  /**
   * Result of a `set_session_agent` re-target (ADR-0015): `ok` is false when the
   * change was rejected (cross-vendor — vendor is immutable), true on a same-vendor
   * swap. On success the session's next turn `resume`s with `agentId`. `vendor` is
   * the session's (unchanged) frozen vendor, echoed for the client's local update.
   */
  | {
      type: 'session_agent_changed'
      sessionId: string
      agentId: string
      vendor: VendorId
      ok: boolean
    }
  /** Confirms the active session's mode change. */
  | { type: 'mode_changed'; mode: PermissionMode }
  /** Available slash commands/skills for the active session (reply to `list_commands`). */
  | { type: 'commands'; commands: SlashCommandInfo[] }
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
  | {
      type: 'settings'
      settings: SystemSettings
      hostStatus: VendorHostStatus[]
      bindingStats: SessionBindingStats
      sessionCapabilities: Record<VendorId, SessionCapabilities>
      /**
       * Each vendor's external-skill mount support (ADR-0016/0017, mount layer 2/3).
       * Probed and cached by `detectSkillSupport()`. A `none` / `temporarily-unavailable`
       * vendor gets its vendor selector in the skillRepos form greyed out — the session
       * still launches, but the skill is not linked into that vendor's discovery dir.
       * Absent when the mount layer hasn't been initialized yet (older configs); the
       * UI then defaults every vendor to `full` (no greying).
       */
      skillSupport?: Record<VendorId, SkillSupportState>
    }
  /**
   * The normalized project configuration for a workspace (reply to
   * `load_project_config` or `save_project_config`).
   */
  | { type: 'project_config'; projectPath: string; config: ProjectConfig }
  /** A project's intent list (reply to `list_intents`/`open_intent_chat`, or a push after a change). */
  | { type: 'intents'; projectPath: string; items: Intent[] }
  /**
   * The project's automation-orchestrator status. Pushed on entering the
   * intent view and on every state change (start/stop/progress/error), so
   * the intent list's automation button reflects the live run.
   */
  | { type: 'automation_status'; status: AutomationStatus }
  /**
   * A project's discussion list (reply to `list_discussions`/`open_discussion` entry, or a push
   * after a change). `runStates` is a live snapshot of which listed discussions have an active
   * orchestration run (id → `running`/`paused`) — only active entries are present. It rides every
   * list send (first fetch / reconnect re-fetch / state-change push), so a refresh or reconnect
   * authoritatively reconciles the run-state of background runs (decoupled from persisted `status`).
   */
  | {
      type: 'discussions'
      projectPath: string
      items: Discussion[]
      runStates?: Record<string, 'running' | 'paused'>
      /**
       * Companion snapshot for the read-only research phase (id → `running`, only discussions
       * with a live research run present). Rides every list send like `runStates`, so a refresh
       * or reconnect mid-research authoritatively rebuilds the research phase (right pane stays on
       * the research stream, Start stays hidden) — the transition-only `research_run_status` is
       * missed by a freshly-(re)connected view.
       */
      researchStates?: Record<string, 'running'>
    }
  /** One discussion plus its full message history (reply to `open_discussion`). */
  | { type: 'discussion_detail'; discussion: Discussion; messages: DiscussionMessage[] }
  /**
   * A newly-appended discussion message, pushed live to every connection while
   * the organizer engine runs (the client appends it when viewing that
   * discussion). The companion status/conclusion change rides the refreshed
   * `discussions` list broadcast.
   */
  | { type: 'discussion_message'; discussionId: string; message: DiscussionMessage }
  /**
   * Live run-state of a discussion's background orchestration, decoupled from its
   * persisted `DiscussionStatus`: `running` / `paused` while the engine is alive,
   * `ended` when the run finishes or is torn down (the frontend then drops its
   * run-state entry and falls back to the persisted status). Runtime-only — not
   * persisted, not restored across a server restart.
   */
  | { type: 'discussion_run_status'; discussionId: string; state: 'running' | 'paused' | 'ended' }
  /**
   * Runtime-only, transient in-flight status of the agents the organizer just
   * dispatched in a round — surfaced in the chat tail so viewers see which agents
   * are replying (and which failed) before anything lands in the transcript.
   * Decoupled from `discussion_message`: never persisted, never an entry in
   * `discussion_messages`, and (unlike `discussion_run_status`) NOT snapshotted on
   * the `discussions` list — it self-heals via `cleared`/`failed`/the reply message
   * /run `ended`/discussion switch, so a refresh or reconnect leaves no stuck pending.
   *
   * - `pending`: `agents` were dispatched and are now replying (a `broadcast` lists
   *   several at once).
   * - `cleared`: `agents` finished (reply appended, or an empty/skipped speech that
   *   produces no `discussion_message`) — drop them from the in-flight set. The
   *   reliable clear for the no-message case; the reply-message path also clears.
   * - `failed`: `agents` (a single agent) failed to reply; `error` is a brief reason.
   *   The discussion continues (the speech is skipped, the round is not blocked).
   */
  | {
      type: 'discussion_dispatch_status'
      discussionId: string
      phase: 'pending' | 'cleared' | 'failed'
      agents: { id: string; name: string }[]
      error?: string
    }
  /**
   * A streamed item from a discussion's read-only research run, pushed live while the
   * research agent works (the client appends it to the right pane's research stream when
   * viewing that discussion). Runtime-only, mirrors `discussion_message` but for the
   * research phase; the research transcript is never persisted, so it is not replayed on
   * reconnect (only the `researchStates` liveness snapshot is).
   */
  | { type: 'research_message'; discussionId: string; message: ResearchMessage }
  /**
   * Live run-state of a discussion's read-only research run: `running` while the research
   * agent works, `ended` when it finishes, fails, or its underlying process dies (the run
   * is awaited, so a dead process settles the promise and yields `ended`). Runtime-only —
   * not persisted. On `ended` the frontend drops the research phase; the server then
   * auto-starts the orchestration (emitting `discussion_run_status: running`) on success,
   * or leaves a `draft` for a manual Start on failure.
   */
  | { type: 'research_run_status'; discussionId: string; state: 'running' | 'ended' }
  /**
   * Echo of a user prompt, emitted into the session's stream when a turn starts.
   * Lets every viewer (including one switching back to a background session) see
   * the prompt that drove the in-flight turn, since it isn't part of the on-disk
   * `baseline` captured before the turn.
   */
  | { type: 'user_text'; text: string }
  | { type: 'assistant_text'; text: string }
  /**
   * A turn produced no visible output (thinking-only, end_turn with no text or
   * tool call). Emitted just before the turn's `turn_end` so the viewer sees a
   * muted line instead of a silent gap. Buffered like any other event, so a
   * viewer switching back replays it too.
   */
  | { type: 'notice'; text: string }
  | {
      type: 'tool_use'
      toolUseId: string
      toolName: string
      input: unknown
      /**
       * Audit hint surfaced to the console (2026-06-06-004): this tool call was
       * auto-allowed by the vendor's OWN permission rule engine WITHOUT a c3/human
       * decision — so it never raised a `permission_request`. Carried from the
       * neutral {@link CanonicalMessage.preApproved} marker via the driver path's
       * `WireEmitter`. The web renders it with a distinct "vendor pre-approved"
       * color, making "c3 is a gateway, not the sole authority" explicit (PG-R12).
       * Absent/false on a tool c3 gated (or any claude-path tool).
       */
      preApproved?: boolean
    }
  | { type: 'tool_result'; toolUseId: string; content: string; isError: boolean }
  | {
      type: 'permission_request'
      requestId: string
      toolName: string
      input: unknown
      /**
       * Present when consensus ran but was split — the agents' opinions for the
       * human. For `AskUserQuestion` this is the per-question roll-up
       * ({@link AskConsensusOutcome}) the answer panel renders.
       */
      consensus?: AnyConsensusOutcome
    }
  /**
   * A permission request the multi-agent consensus resolved on its own (all
   * voters agreed). Informational — no decision needed from the human; carries
   * the opinions so the console can show how it was decided.
   */
  | { type: 'consensus_auto'; toolName: string; input: unknown; outcome: AnyConsensusOutcome }
  /**
   * One prompt→result turn finished. `complete` = the run ended normally;
   * `error` = it failed. This NEVER means the session ended — the session stays
   * active for the next prompt. A session only truly ends when the user clears it.
   * For a team session this fires per lead turn; the lead process keeps running.
   *
   * Socket-disconnect auto-resume telemetry (AS-R18, all optional / absent on a
   * normal turn): `reconnect_attempted` — this turn went through a single
   * auto-`resume` after a socket disconnect; `retry_count` — how many resume
   * attempts were spent (0 or 1, bounded); `original_error` — the socket
   * disconnect message that triggered the resume path; `side_effect_pending` —
   * the side-effect gate refused auto-resume because an unclosed write-class
   * `tool_use` was in flight when the socket dropped (AS-R19), so this `error`
   * turn ends and the user must continue manually.
   */
  | {
      type: 'turn_end'
      reason: 'complete' | 'error'
      error?: string
      reconnect_attempted?: boolean
      retry_count?: number
      original_error?: string
      side_effect_pending?: boolean
    }
  /**
   * The session was upgraded to a persistent agent team: the run detected a team
   * tool (TeamCreate / SendMessage / a background Agent) and the lead process now
   * stays alive between turns to coordinate teammates. The client keeps the
   * composer enabled (messages route to the live lead) and shows a team badge.
   * Emitted once, into the session buffer, so reconnecting viewers also see it.
   */
  | { type: 'team_upgraded' }
  /**
   * One agent in the degradation chain failed (rate-limit / auth / connection
   * error). Emitted into the session buffer between the original user_text and
   * the next attempt's first event, so the viewer sees why the first agent was
   * skipped. Followed by either the next agent's output or `all_agents_failed`.
   */
  | {
      type: 'agent_failed'
      agentId: string
      agentName: string
      error: string
    }
  /**
   * Every agent in the degradation chain has been exhausted — none could
   * complete the current turn. The session then emits `turn_end { reason:
   * 'error' }` with a combined message. This is the terminal failure banner
   * for the current turn (the session stays alive for a manual retry).
   */
  | {
      type: 'all_agents_failed'
      agents: Array<{ agentId: string; agentName: string; error: string }>
      message: string
      /**
       * Degradation-chain agents of a **different** vendor than the session's
       * current agent, skipped at chain-build time. Cross-vendor degradation cannot
       * carry context (a Claude session cannot `resume` into Codex — the SDK errors;
       * ADR-0011 / 008), so the chain is **vendor-homogeneous**: cross-vendor entries
       * are dropped rather than launched under the wrong vendor. Surfaced here so the
       * console honestly notes the skipped candidates ("无法承接上下文") instead of
       * implying they were tried. Absent/empty ⇒ no cross-vendor entry was configured.
       */
      crossVendorSkipped?: Array<{ agentId: string; agentName: string; vendor: VendorId }>
    }
  /**
   * A requested operation failed (bad path, missing session, etc.). Carries a
   * machine-readable `{ code, params }` (see ui-codes.ts) — never translated text;
   * the web renders it through its i18n catalog. The server holds no UI copy.
   */
  | { type: 'error'; error: UiError }
  /** A workspace's schedule list (reply to `list_schedules` or broadcast after create/update/delete). */
  | { type: 'schedules'; workspacePath: string; items: Schedule[] }
  /** Full schedule detail with execution logs (reply to `get_schedule_detail`). */
  | { type: 'schedule_detail'; schedule: Schedule; logs: ScheduleExecutionLog[] }
  /**
   * One execution's agent session transcript (reply to `get_execution_transcript`).
   * `items` is empty for `command`-type or sessionless executions; `sessionId` is
   * null in that case.
   */
  | {
      type: 'execution_transcript'
      executionId: string
      sessionId: string | null
      items: TranscriptItem[]
    }
  /** Execution logs for a schedule. */
  | { type: 'schedule_execution_logs'; scheduleId: string; items: ScheduleExecutionLog[] }
  /** Workspace-level MCP server configuration (reply to `get_workspace_mcp_config`). */
  | { type: 'workspace_mcp_config'; workspacePath: string; config: WorkspaceMcpConfig }
  /** A new pending write approval entry was created. */
  | { type: 'schedule_write_approval_pending'; approval: PendingWriteApproval }
  /** A pending write approval was resolved (approved/rejected/expired). */
  | {
      type: 'schedule_write_approval_resolved'
      approvalId: string
      status: 'approved' | 'rejected' | 'expired'
      scheduleId: string
    }
  /** Pending write approvals for a workspace (reply to `list_pending_write_approvals`). */
  | { type: 'pending_write_approvals'; workspacePath: string; items: PendingWriteApproval[] }
  /**
   * A pre-launch skill-load gate awaiting a human decision (mount layer 2/3; the
   * modal is rendered by 3/3). The backend emits one before mounting an external
   * skill when the `trust` tier or first-time `.gitignore` write needs an ack,
   * then blocks the mount on the matching {@link SkillLoadApprovalRequest}
   * `skill_load_approval_resolve`. `detail` is a human-readable summary of what is
   * about to happen (e.g. the ref change, or the `.gitignore` line to append).
   */
  | {
      type: 'skill_load_approval_request'
      requestId: string
      kind: SkillApprovalKind
      /** The {@link SkillRepoConfig.id} being mounted. */
      id: string
      /** The vendor whose discovery dir is the mount target. */
      vendor: VendorId
      repo: string
      ref: string
      detail: string
    }
  | { type: 'pong' }
