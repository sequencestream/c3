/**
 * WebSocket wire protocol shared between server and web.
 * Path: /ws
 */

// Type-only import keeps protocol.ts zero-runtime; the runtime SoT lives in ui-codes.ts.
import type { UiError } from './ui-codes.js'
// Type-only: the task model item is the shape the `task_*` wire messages carry
// (the runtime SoT — applyTaskTool et al. — lives in task-model.ts). 2026-06-07-009.
import type { TaskItem } from './task-model.js'

/**
 * **Claude's** permission-mode token set — the five values valid to pass to the
 * Agent SDK `query()`'s `permissionMode` option and `setPermissionMode()`. As of
 * 2026-06-07-012 this is no longer the universal wire "mode" type: it is exactly
 * `claudeModeCatalog`'s token list (one vendor's tokens). The neutral wire/
 * persistence representation is {@link ModeToken} (a `string` carrying ANY vendor's
 * native token), interpreted via that vendor's {@link VendorModeCatalog}. Every
 * `PermissionMode` literal is a valid `ModeToken`, so Claude code is unaffected.
 */
export type PermissionMode = 'default' | 'auto' | 'plan' | 'acceptEdits' | 'bypassPermissions'

/** A project directory the user manages in the c3 sidebar. */
export interface WorkspaceInfo {
  /**
   * Opaque identity token assigned at first registration. Never an absolute
   * path: the server resolves `id → realpath` internally. The client MUST
   * NOT construct or derive ids — only the server emits `WorkspaceInfo`.
   */
  id: string
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
   * Codex thread id) — NOT the opaque c3 id. The c3 namespace on the wire is
   * an ADR-0013 deferred phase; `select_session`/`delete_session`/`rename_session`
   * round-trip this id back to the server, which resolves it against the owning
   * vendor's native store.
   */
  sessionId: string
  /** Display title: SDK custom title, summary, or first prompt. */
  title: string
  /** SDK last-modified time, ms since epoch. Sort key within a workspace (desc). */
  lastModified: number
  /**
   * c3-tracked permission mode for this session, as a vendor-native
   * {@link ModeToken} — interpreted against this row's {@link vendor} via that
   * vendor's {@link VendorModeCatalog} (2026-06-07-012; was the Claude-only
   * `PermissionMode`).
   */
  mode: ModeToken
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
   * (ADR-0013 amendment — `work_session_metadata` projection). Drives the
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
 * The media types c3 accepts for prompt images — the ONLY file kind a user
 * message may carry to an agent (2026-06-16). Both vendor adapters can ingest
 * these: Claude as a base64 `image` content block, Codex as a `local_image`
 * path. Any other `mediaType` is rejected at the server boundary (the non-goal
 * is generic file/attachment support).
 */
export const IMAGE_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const
export type ImageMediaType = (typeof IMAGE_MEDIA_TYPES)[number]

/**
 * An image attached to a {@link ClientToServer} `user_prompt`. `data` is the
 * raw base64-encoded image bytes WITHOUT a `data:` URI prefix (the caller strips
 * it); `mediaType` is one of {@link IMAGE_MEDIA_TYPES}. The neutral shape both
 * adapters consume — see {@link isImageMediaType} for the boundary guard.
 */
export interface PromptImage {
  mediaType: string
  data: string
}

/** Narrow an arbitrary media type to an accepted {@link ImageMediaType}. */
export function isImageMediaType(mediaType: string): mediaType is ImageMediaType {
  return (IMAGE_MEDIA_TYPES as readonly string[]).includes(mediaType)
}

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
  /**
   * The agent's position in the user-controlled global ordering — the single
   * sort key every *implicit* "list of agents" consumer reads (the settings list,
   * the default/tool-agent dropdowns, discussion participants, consensus voters,
   * and the default-agent "fall through to the next enabled one" picker). Smaller
   * sorts earlier. The server `normalize` regularizes these to a dense, stable
   * `0..n` sequence on every load/save: the system agent ({@link SYSTEM_AGENT_ID})
   * is pinned to the front, then agents with an explicit `order_seq` in ascending
   * order, then any missing ones appended at the tail in their current array
   * order; duplicates are broken stably. The SettingsPanel drag-reorder writes it
   * back so the order survives a Save.
   *
   * NOT consulted by the *explicit* `degradationChain` (its user-authored id order
   * IS the fallback priority — see {@link SystemSettings.degradationChain}), nor by
   * `resolveSessionLaunch` (a launch target is resolved by id, never by position).
   *
   * Back-compat: a legacy config without this field is filled in by `normalize`
   * using the current array order (insertion order), so existing installs keep
   * their present visual order until the user drags to re-rank.
   */
  order_seq?: number
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
 * The `codex` vendor's config sub-object (2026-06-06-005). The neutral launch
 * overrides (mirroring claude); each empty string ⇒ no override.
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
  /**
   * Which wire protocol the (custom) provider speaks — codex's own `wire_api`
   * term (2026-06-12-006). It declares the upstream's REAL API surface so the
   * driver routes deterministically instead of guessing from `baseUrl`:
   *  - `'responses'` ⇒ the provider natively serves OpenAI Responses
   *    (`/responses`); codex connects DIRECT, no relay translation.
   *  - `'chat'` ⇒ the provider is Chat-Completions-only (most third parties);
   *    codex is pointed at c3's in-process Responses→Chat relay (ADR-0014).
   * Legacy records without the field migrate to `'chat'` (the relay default —
   * preserves the pre-existing third-party-via-relay behaviour). Irrelevant to
   * `system`-mode codex (no provider override ⇒ DIRECT regardless).
   */
  wireApi: 'responses' | 'chat'
}

/**
 * One agent profile under the system-config module: a vendor-agnostic public
 * shell ({@link AgentConfigBase}) plus a `vendor`-discriminated `config`
 * sub-object. A session launches the agent's vendor CLI using its agent (or the
 * default agent when unassigned), routing the `config` per its `vendor` tag.
 *
 * `claude` (ADR-0011 reference) and `codex` (read-only advisor seat, Phase 0
 * 008 NO-GO, 2026-06-06-005) have real adapters and config shapes. The runtime
 * validation/routing lives server-side in `kernel/agent-config/schema.ts` (zod
 * stays out of this zero-runtime, SDK-free wire module — ADR-0009); a type-level
 * assertion there pins the zod schema to this union so the two cannot drift.
 */
export type AgentConfig = AgentConfigBase &
  ({ vendor: 'claude'; config: ClaudeAgentConfig } | { vendor: 'codex'; config: CodexAgentConfig })

/**
 * Resolve the effective `defaultAgentId` for an agent registry, applying the
 * **"fall through to the next enabled agent"** rule (AC-R2/AC-R10/AC-R20,
 * 2026-06-15-001). The chosen id is meant to be **persisted** (rewrite-on-store
 * semantics, not a runtime-only resolution) — both the web SettingsPanel (on
 * disabling/removing an agent) and the server `normalize` (on every save) call
 * this so a disabled default never silently degrades to the synthesized system
 * fallback at launch time.
 *
 * `agents` must be in the user-controlled order (`order_seq` ascending; the
 * server passes the canonicalized registry, the console passes its draft array
 * whose order already is the visual order). Rule:
 *  1. the current default still present **and** enabled ⇒ keep it;
 *  2. otherwise the **next enabled** agent after its position (scanning forward),
 *     wrapping to the first enabled agent overall when nothing follows or the
 *     current default was removed;
 *  3. no enabled agent at all ⇒ {@link SYSTEM_AGENT_ID} (the id `resolveAgent`
 *     synthesizes a fallback for — a session is never locked out).
 *
 * An agent counts as enabled unless `enabled === false` (back-compat with
 * configs predating the field, matching {@link AgentConfigBase.enabled}).
 */
export function resolveDefaultAgentId(agents: AgentConfig[], currentDefaultId: string): string {
  const isEnabled = (a: AgentConfig): boolean => a.enabled !== false
  const current = agents.find((a) => a.id === currentDefaultId)
  if (current && isEnabled(current)) return currentDefaultId
  const idx = agents.findIndex((a) => a.id === currentDefaultId)
  for (let k = idx + 1; idx >= 0 && k < agents.length; k++) {
    if (isEnabled(agents[k])) return agents[k].id
  }
  const firstEnabled = agents.find(isEnabled)
  return firstEnabled ? firstEnabled.id : SYSTEM_AGENT_ID
}

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
  /**
   * Voter-selection mode. Optional; absent/`'all'` keeps the current behaviour
   * (every same-vendor enabled non-self agent votes). `'custom'` restricts the
   * voters to the intersection of {@link agentIds} with that same-vendor enabled
   * non-self set — letting the user exclude irrelevant read-only agents or limit
   * voting to high-trust ones. The vendor-homogeneity rule is unchanged; custom
   * only ever *narrows* within the same-vendor set, never crosses vendors.
   */
  mode?: 'all' | 'custom'
  /**
   * Allowlist of agent ids for `mode: 'custom'`. Ignored when `mode` is absent or
   * `'all'`. Cleaned by `normalizeWorkspaceSetting`: ids that no longer exist or
   * are disabled are dropped (and a disabled agent is also filtered at runtime),
   * so a stale id can never resurrect a voter. Empty (or all-stale) ⇒ no voters
   * ⇒ consensus is skipped and the human is prompted as usual.
   */
  agentIds?: string[]
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
 * One external git repository configured as a skill source (ADR-0016). c3 clones
 * it into a shared `~/.c3/repo/` cache and (mount layer, 2/3) soft-links its
 * skills into EVERY build-link-capable vendor's discovery directory under a flat
 * `_c3_<id>/SKILL.md` layout (spike A: nested dirs are not discovered). The mount
 * is silent — the configured `ref`'s current head is resolved and linked with no
 * trust/vendor knobs and no pre-mount approval (only the one-time `.gitignore`
 * append still asks). Vendors whose skill discovery is not `full` are skipped.
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
}

/**
 * The install-link presence of one configured skill in the two shared public
 * skill dirs (`get_skill_link_status` reply, 2026-06-12). External skills are no
 * longer mounted at launch; the settings panel queries this and triggers an
 * explicit `install_skill`. Both flags report whether `_c3_<id>` is a live
 * symlink under that dir — the dirs are shared across vendors, so we check the
 * directories directly rather than enumerating vendors.
 */
export interface SkillLinkStatus {
  /** The {@link SkillRepoConfig.id} this status is for. */
  id: string
  /** `_c3_<id>` exists as a symlink under `<project>/.claude/skills/`. */
  claudeSkills: boolean
  /** `_c3_<id>` exists as a symlink under `<project>/.agents/skills/`. */
  agentsSkills: boolean
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
 * resolve (mount layer 2/3; the modal UI is rendered by 3/3). External skills now
 * mount silently (the configured `ref`'s head is resolved and linked with no trust
 * check), so the only remaining gate is:
 * - `gitignore` — the one-time confirm to append a `_c3_` + wildcard line to the
 *   project's `.gitignore` before the first mount; acked once, then silent.
 */
export type SkillApprovalKind = 'gitignore'

// ─── Sandbox Config Types ───────────────────────────────────────────────────
// Wire representation of the kernel's SystemSandboxDef / WorkspaceSandboxConfig.
// The kernel maintains its own copies in server/src/kernel/sandbox/types.ts
// (with runtime types like SandboxHandle); these protocol-level interfaces are
// the persistence shape, kept in sync by the normalize layer.

/** Supported container runtime backends for sandbox execution. */
export type SandboxType = 'docker' | 'gvisor' | 'kata' | 'firecracker'

/**
 * Structured resource limits for sandboxed containers.
 *
 * Each field corresponds to a Docker runtime flag. Fields are optional so
 * the admin can set only the limits they care about; unset fields let Docker
 * use its own defaults.
 *
 * Phase 1 (MVP) — basic memory/cpu/timeout.
 * Phase 2 (planned) — pidsLimit, ulimits, diskQuota, oomScoreAdj.
 */
export interface ResourceLimits {
  /** Memory limit in Docker format: "256m", "2g", etc. Maps to --memory. */
  memory?: string
  /** CPU limit in fractional cores (e.g. 2 = 2 CPUs, 0.5 = half a core). Maps to --cpus. */
  cpu?: number
  /**
   * Container stop timeout in milliseconds.
   * Maps to --stop-timeout (converted to seconds for the Docker API).
   * Docker will wait this long for the container to stop gracefully before
   * sending SIGKILL. Defaults to Docker's own default (10 s) when unset.
   */
  stopTimeoutMs?: number
}

/**
 * System-level sandbox definition — a "template" the administrator defines
 * in System Settings. Each has a unique {@link name} that a project-level
 * {@link WorkspaceSandboxConfig.sandbox} references.
 */
export interface SystemSandboxDef {
  /** Unique name for this sandbox definition (e.g. "default", "nodejs"). */
  name: string
  /** Container runtime type. */
  type: SandboxType
  /** Container image (e.g. "node:20-alpine", "python:3.12-slim"). */
  image: string
  /** Seccomp profile name (loaded from the seccomp directory). */
  seccomp?: string
  /** Memory limit in Docker format: "256m", "2g", etc. */
  memoryLimit?: string
  /** CPU limit in fractional cores (e.g. 2 = 2 CPUs, 0.5 = half a core). */
  cpuLimit?: number
  /**
   * Structured resource limits.
   * When set, takes precedence over the flat memoryLimit / cpuLimit fields.
   * Allows also setting stopTimeoutMs (not expressible via the flat fields).
   */
  resourceLimits?: ResourceLimits
  /** Human-readable description shown in the UI. */
  description?: string
  /** Environment variables injected into the container. */
  envVars?: Record<string, string>
  /**
   * Network egress allowlist — CIDR or hostname patterns allowed through.
   * When non-empty, enables limited network egress (overrides the workspace
   * {@link WorkspaceSandboxConfig.networkDisabled} flag).
   *
   * Phase 2 (planned) — MVP throws unsupported if configured.
   *
   * Note: network on/off and read-only rootfs are per-workspace security
   * policies and live on {@link WorkspaceSandboxConfig}, not here.
   */
  networkAllowlist?: string[]
  /** Working directory inside the container. */
  workingDir?: string
  /** Entrypoint override (replaces CMD). */
  entrypoint?: string[]
  /** Additional Docker-specific options (passed verbatim to dockerode). */
  dockerOptions?: Record<string, unknown>
}

/**
 * Workspace-level sandbox configuration — what a project user can configure
 * after an administrator has defined a {@link SystemSandboxDef}.
 *
 * The project **selects** a system def by name and may enable/disable
 * sandboxing. Image/type/seccomp are NOT overridable at the project level
 * (they are security-sensitive and only the admin sets them).
 *
 * Two server-side normalize invariants apply (see `normalizeSandboxConfig`):
 * - **worktree-only**: sandbox is only meaningful when the workspace's
 *   {@link WorkspaceSetting.gitBranchMode} is `worktree`. Under `current-branch`
 *   the container would bind-mount the live project checkout, so the config is
 *   dropped (treated as not configured).
 * - **custom-only**: {@link agentIds} keeps only ids of agents that are both
 *   `enabled` and `configMode: 'custom'`; invalid / system / disabled ids are
 *   silently dropped.
 */
export interface WorkspaceSandboxConfig {
  /** Name of the system sandbox def to use. Required when enabled. */
  sandbox?: string
  /** Master switch — sandboxing is off by default. */
  enabled?: boolean
  /**
   * Custom agents allowed to run inside the sandbox container when enabled.
   * Pool of `enabled && configMode: 'custom'` agent ids (worktree-only +
   * custom-only — see the interface doc). Absent / empty ⇒ empty pool.
   */
  agentIds?: string[]
  /**
   * Per-workspace network policy (deny-by-default).
   * When true or unset, the container has no network access. Set to false to
   * grant network egress (subject to the system def's {@link SystemSandboxDef.networkAllowlist}).
   */
  networkDisabled?: boolean
  /**
   * Per-workspace read-only root filesystem policy (deny-by-default).
   * When true or unset, the container root filesystem is read-only. Set to
   * false when a build/cache needs a writable root.
   */
  readonlyRootfs?: boolean
  /** Override memory limit (Docker format). */
  memoryLimitOverride?: string
  /** Override CPU limit (fractional cores). */
  cpuLimitOverride?: number
  /** Override base image (use with caution — changes the runtime environment). */
  imageOverride?: string
  /** Additional env vars merged on top of the system def's envVars. */
  envVarsOverride?: Record<string, string>
}

/**
 * Git branch strategy for `start_development` in a workspace (2026-06-10).
 * - `current-branch`: the dev agent runs directly in the project checkout on its
 *   current branch — no worktree is created.
 * - `worktree`: the dev agent runs in an isolated git worktree branched from the
 *   workspace's {@link WorkspaceSetting.defaultMainBranch} (existing isolation path).
 */
export const GIT_BRANCH_MODES = ['current-branch', 'worktree'] as const
export type GitBranchMode = (typeof GIT_BRANCH_MODES)[number]

/**
 * Per-project (workspace) configuration, keyed by resolved project path in
 * {@link SystemSettings.projectConfigs}. Each project holds its own copy of the
 * workspace-level knobs (including sandbox and git commit strategy) — independent
 * of every other project's values. Absent or partial entries fall back to the
 * normalized defaults.
 */
export interface WorkspaceSetting {
  /**
   * Per-vendor default permission mode map (2026-06-07-017).
   * Each vendor gets its own {@link ModeToken}, validated against that vendor's
   * {@link VendorModeCatalog} at save time. A vendor absent from the map falls
   * back to that vendor's `defaultToken` at launch. Migrated from the legacy
   * single `ModeToken` (pre-017) on first read.
   */
  /**
   * Per-vendor default permission mode map (2026-06-07-017).
   * For `claude`: value is a {@link ModeToken} validated against
   * that vendor's {@link VendorModeCatalog} at save time.
   * For `codex`: value is either a {@link CodexPolicy} (new dual-policy format)
   * or a {@link ModeToken} (legacy, migrated on read via `gateToCodexPolicy`).
   * A vendor absent from the map falls back to its vendor `defaultToken` at
   * launch. Migrated from the legacy single `ModeToken` (pre-017) on first read.
   */
  defaultMode?: Record<VendorId, ModeToken | CodexPolicy>
  /** Multi-agent consensus voting on permission prompts. Optional; off by default. */
  consensus?: ConsensusConfig
  /** Slash command (leading `/`) prefixed when launching dev for this project. Optional; empty ⇒ no prefix. */
  devSkill?: string
  /** Per-stage round cap for multi-agent discussions in this project. Minimum 8 (clamped up). */
  maxRoundsPerStage?: number
  /** Per-turn character guidance for participant speech in this project. Minimum 300 (clamped up). */
  maxSpeechChars?: number
  /** External git repositories configured as skill sources (ADR-0016). c3 clones
   * each into a shared `~/.c3/repo/` cache and soft-links its skills into every
   * build-link-capable vendor's discovery directory. Validated by `getSkillRepos()`
   * (fail-hard). Absent/empty ⇒ no external skills configured for this project. */
  skillRepos?: SkillRepoConfig[]
  /** Project-level sandbox configuration. References a system sandbox def
   * by name. Absent or undefined ⇒ sandboxing is not configured (equivalent
   * to disabled). The system's sandboxes list is in {@link SystemSettings.sandboxes}. */
  sandbox?: WorkspaceSandboxConfig
  /**
   * Git branch strategy for `start_development` (2026-06-10). See
   * {@link GitBranchMode}. Absent ⇒ `current-branch` (backward compatible with
   * pre-2026-06-10 configs, normalized on read). The legacy on-disk key is still
   * read as a fallback — see `normalizeWorkspaceSetting`.
   */
  gitBranchMode?: GitBranchMode
  /**
   * Base / merge-target branch used when {@link gitBranchMode} is `worktree` —
   * new worktrees branch from it. Optional; absent ⇒ branch from current HEAD.
   * The settings form auto-detects it (origin/HEAD → current HEAD) on open.
   */
  defaultMainBranch?: string
}

// ===========================================================================
// Authentication (ADR-0023) — contract-only, zero runtime.
//
// An extensible auth abstraction so the single-admin `basic` provider this phase
// does not weld one auth method into every layer. The session-token model and
// the login/logout/unauthenticated messages are PROVIDER-NEUTRAL (reused by any
// provider); a future OAuth/SSO provider only appends a `kind` arm to
// {@link AuthProvider}. Runtime (middleware, login page, password hashing, token
// signing/verification) is NOT in this phase. The matching zod schema +
// type-pin lives server-side in `kernel/config/auth-schema.ts` (ADR-0009).
// ===========================================================================

/**
 * Auth provider kinds — the extension point. `none` (no auth — the C-SEC-5
 * localhost-only default), `basic` (single admin) and `oauth` (generic OIDC,
 * contract-only — see {@link OAuthAuthProvider}) are defined; `sso`/multi-user
 * remain reserved (add a `kind` here + an arm to {@link AuthProvider} + a server
 * zod arm; nothing else changes — same shape as the ADR-0011 vendor extension
 * point).
 */
export const AUTH_PROVIDER_KINDS = ['none', 'basic', 'oauth'] as const
export type AuthProviderKind = (typeof AUTH_PROVIDER_KINDS)[number]

/**
 * The `none` provider: no authentication — the first-class expression of the
 * C-SEC-5 localhost-only default (sign-in not required, anyone reaching the
 * server may drive it). Carries no config; `kind` alone is the whole shape.
 * Invariant: `kind:'none' ⇔ AuthConfig.enabled === false` (enforced by
 * `normalizeAuth`), so the dropdown's "no auth" choice and the master switch can
 * never disagree.
 */
export interface NoneAuthProvider {
  kind: 'none'
}

/**
 * The single-admin `basic` provider: a username + a password **hash** (a PHC
 * string such as `$argon2id$...`, encoding its own algorithm/params/salt).
 * The plaintext password is NEVER stored here — only the hash. Multi-user is a
 * deferred capability (this provider models exactly one admin account).
 */
export interface BasicAuthProvider {
  kind: 'basic'
  /** The single admin account's login name. */
  username: string
  /** PHC-format password hash. Never plaintext. */
  passwordHash: string
}

/**
 * Generic OIDC `oauth` provider — **contract-only** (no runtime this phase). The
 * config an admin fills so c3 can later delegate login to an external IdP
 * (Google / Keycloak / any compliant OpenID Connect issuer). Authorization is by
 * email allowlist only (no sub allowlist / roles this phase).
 *
 * Runtime — `/auth/callback`, discovery fetch, PKCE/state, token exchange, JWKS
 * verification, session minting — is ALL deferred to a later OAuth-runtime task.
 * Persisting this block does NOT enable OAuth login; with the runtime absent,
 * turning auth on still only works with `basic` (the UI marks oauth accordingly).
 */
export interface OAuthAuthProvider {
  kind: 'oauth'
  /** OIDC issuer / discovery base URL (its `.well-known/openid-configuration`). */
  issuer: string
  /** OAuth 2.0 client id registered with the IdP. */
  clientId: string
  /**
   * Reference (env var name / keystore id) to the OAuth client secret — NEVER
   * the secret itself. Same secret-by-indirection discipline as
   * {@link AuthSessionPolicy.signingKeyRef}; the runtime resolves the real value.
   */
  clientSecretRef: string
  /** Redirect URI the IdP returns the user to (validated by the future runtime). */
  redirectUri: string
  /** Requested OAuth scopes. Defaults to `['openid', 'profile', 'email']`. */
  scopes: string[]
  /** Whether to use PKCE on the authorization-code flow. Defaults to `true`. */
  usePkce: boolean
  /**
   * Authorization allowlist: only these verified emails may sign in. An empty
   * list means nobody is authorized (the future runtime enforces this).
   */
  allowedEmails: string[]
}

/**
 * The active auth provider — a `kind`-discriminated union. Narrow on `kind`
 * before reading provider-specific fields. `none` is no-auth (the localhost-only
 * default); `basic` is runtime-live; `oauth` is contract-only (config persists,
 * login awaits the OAuth-runtime task).
 */
export type AuthProvider = NoneAuthProvider | BasicAuthProvider | OAuthAuthProvider

/**
 * Session-token policy — provider-neutral. The signing secret itself is NEVER
 * persisted in settings; `signingKeyRef` is a *reference* (an env var name or a
 * keystore id) the runtime resolves the real key from (deferred to a later task).
 */
export interface AuthSessionPolicy {
  /** Session token lifetime in seconds. */
  ttlSeconds: number
  /** Reference (env var name / keystore id) to the signing key — not the key itself. */
  signingKeyRef: string
}

/**
 * Network-exposure / bind-address intent. A non-loopback `bindAddress` signals
 * intent to expose c3 to a network, which (per ADR-0023) requires `enabled`
 * auth — the runtime enforcement of that rule is deferred to a later task.
 */
export interface AuthExposureConfig {
  /**
   * Intended server bind address. Absent ⇒ `127.0.0.1` (the C-SEC-5 default).
   * A non-loopback value (e.g. `0.0.0.0`) expresses network-exposure intent.
   */
  bindAddress?: string
}

/**
 * Authentication configuration (ADR-0023), hung on {@link SystemSettings.auth}.
 * `enabled: false` (or an absent block) ⇒ no auth, the C-SEC-5 localhost-only
 * default. This is the extensible boundary: only `provider` differs across auth
 * methods; everything else (session policy, exposure, the wire messages) is
 * provider-neutral.
 */
export interface AuthConfig {
  /** Master switch. `false` / absent block ⇒ no auth (C-SEC-5 default). A
   *  `none` provider pins this to `false` (see {@link NoneAuthProvider}). */
  enabled: boolean
  /** The active auth provider (`none` ⇒ no auth; `basic` runtime-live; `oauth` contract-only). */
  provider: AuthProvider
  /** Session-token policy (TTL + signing-key reference). */
  session: AuthSessionPolicy
  /** Network-exposure / bind-address intent. Absent ⇒ loopback only. */
  exposure?: AuthExposureConfig
}

/**
 * The issued session-token model — provider-neutral. An opaque, signed token
 * the runtime mints on successful login and verifies on each request (signing/
 * verification is deferred to a later task). All instants are absolute Unix ms.
 */
export interface AuthSessionToken {
  /** Opaque token id (jti). */
  tokenId: string
  /** Subject — the authenticated principal (the admin username under `basic`). */
  subject: string
  /** Issued-at instant (Unix ms). */
  issuedAt: number
  /** Expiry instant (Unix ms) = `issuedAt + ttlSeconds * 1000`. */
  expiresAt: number
}

/**
 * Login request payload — provider-neutral. Shared by the future HTTP
 * `POST /auth/login` endpoint and the WS `login` message. The plaintext
 * `password` exists ONLY in transit: it is verified against the stored hash and
 * never persisted.
 */
export interface AuthLoginRequest {
  username: string
  password: string
}

/**
 * Login failure codes — the structured reasons a login is rejected. Distinct
 * from a successful result so the UI can localize each case.
 */
export const AUTH_FAILURE_CODES = ['invalid_credentials', 'auth_disabled', 'rate_limited'] as const
export type AuthFailureCode = (typeof AUTH_FAILURE_CODES)[number]

/**
 * Login result — `ok` discriminates. On success carries the issued session
 * token (the opaque string the client presents on later requests) plus its
 * absolute expiry; on failure carries a structured {@link AuthFailureCode}.
 */
export type AuthLoginResult =
  | { ok: true; token: string; expiresAt: number }
  | { ok: false; code: AuthFailureCode }

/**
 * Admin-password change failure codes (ADR-0023, runtime slice). `not_authenticated`
 * ⇒ an admin already exists and the supplied `currentPassword` did not verify (the
 * sensitive-operation gate); `invalid` ⇒ the new username/password failed a basic
 * non-empty/length check. A bootstrap change (no admin configured yet) skips the gate.
 */
export const ADMIN_PASSWORD_FAILURE_CODES = ['not_authenticated', 'invalid'] as const
export type AdminPasswordFailureCode = (typeof ADMIN_PASSWORD_FAILURE_CODES)[number]

/**
 * Result of a `set_admin_password` attempt (ADR-0023). `ok` discriminates: on
 * success the server has hashed the new password server-side and persisted it
 * (the plaintext never lands on disk); on failure a structured code the UI localizes.
 */
export type AdminPasswordResult = { ok: true } | { ok: false; code: AdminPasswordFailureCode }

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
   * System-level sandbox definitions. Each definition is a "template" that
   * project-level configs reference by name. Admin-only CRUD via the System
   * Settings panel. Absent or empty ⇒ no sandbox definitions exist; the
   * Project Config panel hides its sandbox section accordingly.
   */
  sandboxes?: SystemSandboxDef[]
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
 * One voter's verdict in a checkpoint consensus round. The voter decides whether
 * the automation orchestrator should continue past a developer checkpoint or wait
 * for human intervention.
 */
export interface CheckpointConsensusVote {
  /** Voting agent's id. */
  agentId: string
  /** Voting agent's display name. */
  agentName: string
  /**
   * Verdict. `continue` ⇒ auto-pass the checkpoint; `wait` ⇒ stop for human;
   * `abstain` ⇒ the agent errored or returned no parseable answer.
   */
  decision: 'continue' | 'wait' | 'abstain'
  /** One-line rationale from the agent. */
  reason: string
}

/**
 * The aggregated result of a checkpoint consensus round in the automation
 * orchestrator. When the orchestrator detects a checkpoint signal (unanswered
 * AskUserQuestion or a `stuck` judge verdict), and the majority toggle is on,
 * it spawns a vote among peer agents to decide whether to skip the checkpoint
 * and continue the automation loop.
 *
 * The outcome is broadcast via `AutomationStatus.checkpointConsensus` so the
 * UI/events can render who voted what and the final decision.
 */
export interface CheckpointConsensusOutcome {
  /** Each voter's verdict + reason. */
  votes: CheckpointConsensusVote[]
  /**
   * The decision the orchestrator should follow:
   * - `'continue'` ⇒ the majority (or, in unanimous mode, all voters) agreed to
   *   pass the checkpoint; the orchestrator should treat this as `in_progress`.
   * - `'wait'` ⇒ the majority (or all) agreed to wait; the orchestrator stops
   *   and exposes the checkpoint to the human.
   * - `null` ⇒ a tie or no clear majority; the orchestrator also stops (the
   *   fail-safe default).
   */
  decision: 'continue' | 'wait' | null
  /**
   * True ⇒ every voter returned the same verdict (no abstain). Reports literal
   * unanimity regardless of the majority toggle.
   */
  unanimous: boolean
  /** Decider-agent (or code-fallback) one-line summary of the opinions. */
  summary: string
  /** The type which triggered the checkpoint consensus. */
  trigger: 'pending_question' | 'judge_stuck'
  /**
   * The judge's reason when the trigger was `judge_stuck`; the pending-question
   * detection reason when the trigger was `pending_question`.
   */
  triggerReason: string
}

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
export type VendorId = 'claude' | 'codex'

// ---------------------------------------------------------------------------
// Neutral permission grid + per-vendor mode catalog (ADR-0011, 2026-06-07-012)
// ---------------------------------------------------------------------------

/**
 * What the run is allowed to *do*, orthogonal to how tools are gated (ADR-0011).
 * `plan` proposes without executing changes; `build` executes. Promoted here from
 * the kernel's `adapters/types.ts` so it is the single, SDK-free SoT both the wire
 * (this file) and the adapters re-export — the same promotion `CanonicalMessage`
 * and `AdapterCapability` already took. Claude's `plan` mode, Codex's read-only
 * `sandboxMode` translate INTO this dimension.
 */
export type ActionMode = 'plan' | 'build'

/**
 * How aggressively tools are gated, orthogonal to {@link ActionMode} (ADR-0011):
 *  - `always-ask`   — every tool prompts the human.
 *  - `on-sensitive` — read-only auto-allow; sensitive tools prompt (the default).
 *  - `trusted-prefix` — a trusted class (e.g. edits) auto-accepts; the rest gate.
 *  - `never-ask`    — auto-execute everything (Claude `bypassPermissions`).
 *
 * Replaces Claude's five-way `PermissionMode` as the *internal* permission truth;
 * each vendor's native mode token(s) translate into this 2-axis grid and back via
 * its {@link VendorModeCatalog}. The grid never round-trips 1:1 — see the catalog.
 */
export type ToolGate = 'always-ask' | 'on-sensitive' | 'trusted-prefix' | 'never-ask'

/** The neutral permission grid cell a mode token resolves to. */
export interface NeutralMode {
  actionMode: ActionMode
  toolGate: ToolGate
}

// ---------------------------------------------------------------------------
// Codex native permission types (2026-06-08 — dual-policy config)
// ---------------------------------------------------------------------------

/**
 * Codex sandbox isolation mode — a 1:1 mapping of `@openai/codex-sdk`'s
 * `SandboxMode`. Controls what filesystem write access the agent has.
 */
export type CodexSandboxMode = 'read-only' | 'workspace-write'

/**
 * Codex approval policy — a 1:1 mapping of `@openai/codex-sdk`'s
 * `ApprovalMode`. Controls when the agent asks the human for approval.
 */
export type CodexApprovalPolicy = 'never' | 'on-failure' | 'on-request'

/**
 * Dual-policy config for Codex sessions, replacing the single `ModeToken`
 * for the `codex` vendor. The two axes are orthogonal: `sandboxMode` gates
 * file-system write access and `approvalPolicy` controls the approval
 * frequency. When persisted in `WorkspaceSetting.defaultMode.codex` or
 * carried on the wire, the object form (this interface) is the new format;
 * the legacy string form (`ModeToken` like `'auto'`) is still accepted for
 * migration and degrades through the catalog + `gateToCodexPolicy`.
 */
export interface CodexPolicy {
  sandboxMode: CodexSandboxMode
  approvalPolicy: CodexApprovalPolicy
}

/**
 * A vendor-native permission mode token (ADR-0011, 2026-06-07-012). The neutral
 * replacement for the Claude-centric `PermissionMode` as the wire/persistence
 * representation of a session's mode: it carries each vendor's OWN token (Claude
 * `plan`, Codex `read-only`), disambiguated by the session's
 * {@link VendorId}. A bare `string` by design — the closed set per vendor lives in
 * that vendor's {@link VendorModeCatalog}, not in this type. `PermissionMode`
 * (still defined above) is now just *Claude's* token set, a subset of this.
 */
export type ModeToken = string

/**
 * One selectable mode in a vendor's catalog: its native {@link token}, the web
 * i18n leaf key {@link labelCode} the console renders it through, and the neutral
 * {@link NeutralMode} grid cell it maps to (the semantic bridge the kernel reasons
 * over). The forward map (token → grid) is total per vendor; the reverse (grid →
 * token) picks the nearest declared token (the catalog has fewer cells than the
 * 2×4 grid), exactly as Claude's `permission-map` did before the generalization.
 */
export interface VendorModeDescriptor {
  /** Vendor-native mode token; round-trips as `SessionInfo.mode`/`set_mode`/etc. */
  token: string
  /** Web i18n leaf key for the label (e.g. `nav.mode.plan.label`). Not translated text. */
  labelCode: string
  /** The neutral grid this mode maps to (the kernel's permission truth). */
  actionMode: ActionMode
  toolGate: ToolGate
}

/**
 * One vendor's full mode catalog (ADR-0011, 2026-06-07-012): the ordered list of
 * modes the console offers for that vendor plus the {@link defaultToken} a new
 * session starts in. The single SoT for token ⇄ grid translation — each adapter
 * declares its catalog, the generic `tokenToGrid`/`gridToToken` helpers operate on
 * it, and the kernel/web both consume it by `vendor` (no `if (vendor === …)`).
 * Travels to the web on the `settings.vendorModes` field for the mode picker.
 */
export interface VendorModeCatalog {
  vendor: VendorId
  /** Selectable modes in display order. */
  modes: VendorModeDescriptor[]
  /** The token a new session defaults to; an invariant: it MUST be one of `modes`. */
  defaultToken: string
}

/**
 * One vendor's host-CLI presence (ADR-0012), surfaced to the web so the
 * new-session agent picker can grey out an agent whose binary is not on PATH and
 * the settings diagnostics panel can list what is/isn't installed — together with
 * the resolved absolute path of each installed binary, so the operator can see
 * exactly which executable c3 will launch.
 */
export interface VendorHostStatus {
  vendor: VendorId
  /** Whether the vendor's host CLI was resolved on PATH (or via its `*_PATH` override). */
  present: boolean
  /** The probed executable name (e.g. `claude`). */
  binary: string
  /** The resolved absolute path of the binary, or `null` when it is not installed. */
  path: string | null
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
 * adapter capability, currently seven: six live-run controls + taskStore).
 * The kernel's `AdapterCapabilities` boolean ledger is keyed by exactly these
 * names; a type-level assertion there pins the two together so they cannot drift. "Required" capabilities (start/messages/abort/
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
  | 'taskStore'

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
 *                  *right now* (for a remote-backed future vendor whose service
 *                  is down). Distinct from `'none'`: the upper layer/UI
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
  /** Enumerate a workspace's sessions. Codex: `'full'` via local JSONL scan. */
  readonly list: CapabilityState
  /** Back-read a session's history as canonical messages. Codex: `'full'` via local JSONL read. */
  readonly read: CapabilityState
  /** Continue an existing session by id (vendor-native resume). */
  readonly resume: CapabilityState
  /** Rename a session. Only the vendors whose store supports it report above `'none'`. */
  readonly rename: CapabilityState
  /** Delete a session. Only the vendors whose store supports it report above `'none'`. */
  readonly delete: CapabilityState
}

/**
 * The only role the canonical model commits to. Codex carries no role on its
 * items and must synthesize one (item-type → role); Claude carries it
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
 * collapses a tool into a single in-place item)
 * more naturally than Claude's two-block split, which the Claude adapter folds
 * inward.
 *
 * The union is the **three-vendor common set** (`text`/`thinking`/`tool_use`).
 * Vendor-unique kinds (Codex `reasoning`, …) are NOT promoted
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
      /** Correlation id (Claude `tool_use.id`, Codex item id). */
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
   * Append-only with **id-upsert**: incremental vendors (Codex item
   * part) revise an earlier block in place rather than stacking a new one, so a
   * consumer keys blocks by {@link CanonicalBlock} id, not array position.
   */
  blocks: CanonicalBlock[]
  /**
   * c3 ingest timestamp (epoch ms), NOT a vendor-authoritative value — only
   * The vendor's own time,
   * if any, goes to {@link vendorExtra}.
   */
  ts: number
  /**
   * Audit marker: this turn's tool call(s) were auto-allowed by the vendor's own
   * permission rule engine WITHOUT a c3/human decision — i.e. c3 observed the
   * vendor reply to its own `permission.asked`
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
 * - `blocked` — interrupted by a dependency rollback, rebase conflict, etc.
 *   May re-enter `todo` once unblocked.
 * - `failed` — CI / build / test failure hit while `in_progress`.
 *   May re-enter `todo` for a retry.
 */
export type IntentStatus =
  | 'draft'
  | 'todo'
  | 'in_progress'
  | 'done'
  | 'cancelled'
  | 'blocked'
  | 'failed'

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

/**
 * PR (Pull Request) lifecycle status for an intent.
 * - `reviewing` — PR created, awaiting review.
 * - `rejected` — review rejected (changes requested).
 * - `failed` — CI / merge check failed.
 * - `merged` — PR merged into target branch.
 * - `null` — no PR has been created yet (or PR status is unknown).
 * Independent of the intent's own `status` — a PR has its own lifecycle.
 */
export type IntentPrStatus = 'reviewing' | 'rejected' | 'failed' | 'merged'

/**
 * Dependency type for an intent_deps edge.
 * - `blocks` — hard dependency: the dependent intent cannot proceed until this dep is done.
 * - `informs` — knowledge dependency: information from the dep informs the dependent, but
 *   does not block it. The dep's content / code provides context or reference.
 * - `soft_after` — soft ordering: the dependent should run after the dep (avoid conflict),
 *   but can proceed without it if needed.
 */
export type DepType = 'blocks' | 'informs' | 'soft_after'

/** One dependency edge in intent_deps, with type metadata. */
export interface DependencyInfo {
  /** The id of the depended-on intent. */
  dependsOnId: string
  /** The type of this dependency relationship. */
  depType: DepType
  /** When this dependency was created (epoch ms). */
  createdAt: number
}

/** One persisted intent, scoped to a project (workspace path). */
export interface Intent {
  /** Stable uuid. */
  id: string
  /** Owning project — the workspace absolute path (resolved). */
  workspaceId: string
  title: string
  content: string
  priority: IntentPriority
  /** Owning module name, inferred by the comm agent from title/content. `''` when historic/unidentified. */
  module: string
  status: IntentStatus
  /** Ids of other intents (same project) this one depends on. */
  dependsOn: string[]
  /** Dep types keyed by depended-on intent id. Absent entries default to 'blocks'. */
  dependsOnTypes?: Record<string, DepType>
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
  /** Git branch name the dev session operates on; `null` when unknown. */
  branchName: string | null
  /** Latest known commit hash on the dev branch; `null` when unknown. */
  latestCommitHash: string | null
  /** PR / Merge Request id (e.g. GitHub PR number); `null` when no PR yet. */
  prId: string | null
  /** PR lifecycle status; `null` when no PR yet or status is unknown. */
  prStatus: IntentPrStatus | null
}

/**
 * One intent communication session, as listed by `list_intent_sessions`.
 * Title is nullable — the client falls back to `'New Intent'` or a first-prompt /
 * timestamp derivation when null. `runStates` on the envelope provides liveness.
 */
export interface IntentSessionInfo {
  /** The SDK session id (may be a `pending:` id before first run binds it). */
  sessionId: string
  /** User-assigned title; null means use client fallback. */
  title: string | null
  /** Last mutation (open, rename, run) timestamp (epoch ms). */
  updatedAt: number
}

/**
 * Exit code for an intent dev session execution.
 * - `success` — the dev session completed normally.
 * - `failure` — the dev session errored / CI failed.
 * - `cancelled` — the dev session was aborted by the user.
 */
export type IntentDevSessionExitCode = 'success' | 'failure' | 'cancelled'

/**
 * One intent dev session execution record (审计追踪).
 * Each time an intent launches a dev session, a new row is appended (never overwritten).
 * The primary key is an auto-increment integer; use `listIntentSessions(intentId)`
 * (ordered by recency) for the per-intent history, and `getIntentSession(id)` for
 * a single record detail.
 */
export interface IntentDevSession {
  /** Auto-increment primary key. */
  id: number
  /** Owning intent id (UUID). */
  intentId: string
  /** The dev session's c3SessionId. */
  sessionId: string
  /** Which vendor executed the session. */
  vendor: VendorId
  /** JSON frontmatter + Markdown summary (nullable until the session completes). */
  summary: string | null
  /** Session start timestamp (epoch ms); null until started. */
  startAt: number | null
  /** Session end timestamp (epoch ms); null until finished. */
  endAt: number | null
  /** Exit code; null while the session is in-flight. */
  exitCode: IntentDevSessionExitCode | null
  /** The agent id that executed this session; null when unknown. */
  agentId: string | null
  /** Record creation timestamp (epoch ms). */
  createdAt: number
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
export type AutomationState =
  | 'idle'
  | 'running'
  | 'awaiting_gate'
  | 'developing'
  | 'fixing'
  | 'done'
  | 'error'

/** A project's automation orchestrator status, broadcast to every connection. */
export interface AutomationStatus {
  /** Owning project — the workspace absolute path (resolved). */
  workspaceId: string
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
  /**
   * The result of the latest checkpoint consensus round, if any. Set when the
   * orchestrator ran a vote over whether to continue past a checkpoint, and
   * cleared when the next dev turn is launched. The UI/events use this to render
   * the consensus process and result.
   */
  checkpointConsensus?: CheckpointConsensusOutcome | null
}

/**
 * One intent proposed by the intent-communication agent via the
 * `save_intents` tool. Rendered in the confirmation prompt; persisted with
 * status `todo` once the user allows.
 */
export interface ProposedIntent {
  /**
   * Optional id of an EXISTING intent to update in place (upsert). When set, the
   * save resolves the id within the same project and patches title/content/priority/
   * module/dependsOn instead of inserting a new row — the path the `refine_intent`
   * flow uses so a refined intent updates its original entry rather than duplicating
   * it. The target must be modifiable: `draft`/`todo` keep their status, `cancelled`
   * is reactivated to `todo`, and `in_progress`/`done` are immutable (the whole batch
   * is rejected). Omit to insert a brand-new intent (status `todo`).
   */
  id?: string
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
  workspaceId: string
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
  /**
   * The agent ids selected at creation to participate — the orchestrator nominates
   * speakers from this set only (the organizer is always included even when absent
   * here). `[]` means "unset" (legacy rows / pre-selection discussions) and the
   * orchestrator falls back to the whole `enabledAgents()` roster for back-compat.
   */
  participantAgentIds: string[]
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

/** How a schedule fires: time-based cron, or a run lifecycle event (2026-06-08). */
export type ScheduleTriggerType = 'cron' | 'event'

/** Run lifecycle topics an event-triggered schedule may subscribe to (2026-06-08). */
export type RunLifecycleTopic = 'run:started' | 'run:settled'

/** Terminal reason a run settled with: clean finish, error, or user abort. */
export type RunEndReason = 'complete' | 'error' | 'aborted'

/**
 * Single source-of-truth taxonomy for what kind of run/agent invocation produced
 * an event or drives a runtime (2026-06-08). One value per distinct origin so
 * listeners can route by source instead of collapsing everything into a two-value
 * `'normal' | 'intent'` (the pre-2026-06-08 `SessionKind`):
 *
 * - `session`     — a general development session: the user console, an
 *   intent→development hand-off, and the automation dev-turn. (Was `'normal'`.)
 * - `intent`      — a read-only intent-communication session (the intent gate +
 *   disallowed-tools lock).
 * - `discussion`  — the discussion orchestrator and its research pass.
 * - `schedule`    — a run **launched by the scheduler with no socket** (e.g. an
 *   `llm` scheduled task). NOTE: `schedule` identifies the *trigger source*, NOT a
 *   run type a user session morphs into — a schedule-*triggered* target session run
 *   is still `session` kind. `schedule` only tags the scheduler's own socket-less run.
 * - `consensus`   — a consensus vote (each voter is a tool-free one-shot).
 * - `tool`        — an internal tool call: completion judging (judge) and title
 *   derivation.
 *
 * Migration from the old `SessionKind`: `'normal' → 'session'`, `'intent' → 'intent'`.
 */
export type RunKind = 'session' | 'intent' | 'discussion' | 'schedule' | 'consensus' | 'tool'

export interface Schedule {
  id: string
  type: ScheduleType
  /**
   * Arbitrary JSON configuration, interpreted by the cron runner per `type`.
   * Holds `config.name` — a display name auto-generated by the server on create.
   * On update the client MAY supply `config.name` to set a manual title: a
   * non-empty value is stored sticky (`config.nameSource === 'user'`, auto-naming
   * never overrides it); an empty value reverts to an auto-derived name. There is
   * no `description` field; any in legacy rows is ignored.
   */
  config: unknown
  /** Owning workspace absolute path (resolved). */
  workspaceId: string
  /** Vendor this schedule belongs to; determines which agent runs it. */
  vendor: VendorId
  /**
   * How this schedule fires: `'cron'` (time-based) or `'event'` (run lifecycle).
   * Defaults to `'cron'` for legacy rows migrated before this field existed.
   */
  triggerType: ScheduleTriggerType
  /** Cron expression for `'cron'` triggers; empty string for `'event'` triggers. */
  cronExpression: string
  /** Unix ms timestamp of the next planned run; null when not scheduled (always null for `'event'`). */
  nextRunAt: number | null
  /** For `'event'` triggers: the run lifecycle topic subscribed to; null for cron. */
  eventTopic: RunLifecycleTopic | null
  /**
   * For `'run:settled'` event triggers: only fire when the run ended with one of
   * these reasons. `null` or `[]` means any reason. Ignored for `'run:started'`.
   */
  eventReasonFilter: RunEndReason[] | null
  status: ScheduleStatus
  mode: ModeToken | CodexPolicy
  toolAllowlist: string[]
  toolDenylist: string[]
  createdAt: number
  updatedAt: number
}

/**
 * Fields the client supplies when creating a schedule.
 *
 * `config` carries the task body (`command` or `prompt`) but NOT a name or
 * description: on create the server auto-generates `config.name` from the task
 * content and strips any client-supplied `name`/`description`. (A manual title
 * is set later via {@link UpdateScheduleInput}, not at create time.)
 */
export interface CreateScheduleInput {
  type: ScheduleType
  config: unknown
  workspaceId: string
  /** Vendor this schedule belongs to; determines which agent runs it. */
  vendor: VendorId
  /** Defaults to `'cron'` when omitted (backward-compatible with legacy clients). */
  triggerType?: ScheduleTriggerType
  /** Required for `'cron'` triggers; empty string for `'event'` triggers. */
  cronExpression: string
  /** Required for `'event'` triggers: the run lifecycle topic to subscribe to. */
  eventTopic?: RunLifecycleTopic | null
  /** Optional reason filter for `'run:settled'` event triggers; null/[] = any. */
  eventReasonFilter?: RunEndReason[] | null
  mode: ModeToken | CodexPolicy
  toolAllowlist?: string[]
  toolDenylist?: string[]
}

/** Fields the client may supply when updating a schedule. All optional. */
export interface UpdateScheduleInput {
  type?: ScheduleType
  /**
   * Task body, plus an OPTIONAL `config.name` to set the display title:
   * a non-empty `name` is stored as a sticky user-set title; an empty `name`
   * reverts to an auto-derived one; omitting `name` keeps the existing title
   * (and its provenance) untouched. `description` is always stripped.
   */
  config?: unknown
  vendor?: VendorId
  triggerType?: ScheduleTriggerType
  cronExpression?: string
  eventTopic?: RunLifecycleTopic | null
  eventReasonFilter?: RunEndReason[] | null
  mode?: ModeToken | CodexPolicy
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

/** One entry in a vendor's tool manifest: tool name + read/write classification. */
export interface ToolManifestEntry {
  /** Tool name as the SDK knows it (e.g. 'Read', 'mcp__c3__find_intents'). */
  name: string
  /** Whether this tool is classified as a write operation. */
  isWrite: boolean
}

// ---- Wait User Involve Events ----

/** Source category of a {@link WaitUserInvolveEvent}. */
export type WaitUserInvolveSource = 'session' | 'intent' | 'discussion' | 'schedule'

/** Lifecycle status of a wait-user-involve event. */
export type WaitUserInvolveStatus = 'todo' | 'done' | 'canceled'

/**
 * An event requiring human attention — the server-side record of a tool call
 * the gateway gated behind a human decision (permission_response) before it
 * could proceed. Created at gate time, resolved when the human decides. The
 * web sidebar's "待处理" badge counts 'todo' entries per project.
 */
export interface WaitUserInvolveEvent {
  id: string
  /** Owning project absolute path (resolved). */
  workspaceId: string
  /** Which kind of run produced this event. */
  source: WaitUserInvolveSource
  /** The run's owning entity id (session / intent / discussion / schedule id). */
  sourceId: string | null
  /** Human-friendly label summarising the gated action. */
  title: string | null
  /** The `permission_request.requestId` this event tracks. */
  requestId: string | null
  /** Which tool was gated. */
  toolName: string | null
  /** The tool call input at the time it was gated (JSON). */
  toolInput: unknown
  /** Current lifecycle status — 'todo' while awaiting human decision. */
  status: WaitUserInvolveStatus
  createdAt: number
  updatedAt: number
}

/** Fields the client may supply when listing events. */
export interface ListWaitUserEventsInput {
  workspaceId: string
  /** Optional status filter; absent = all. */
  status?: WaitUserInvolveStatus
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

/**
 * One workspace's WorkCenter rollup — aggregate counts across the four work
 * surfaces, scoped to an optional time range (see {@link get_timerange_stats}).
 * `running` fields reflect live runtime/execution state (time-range independent);
 * all other counts honour the request's `startTime`/`endTime`.
 */
export interface TimeRangeProjectStats {
  /** Absolute workspace path (the project key). */
  workspaceId: string
  /** Display name — the workspace directory's basename. */
  projectName: string
  /** Work sessions: `total` real projection rows in range; `running` live non-idle runtimes. */
  workSessions: { running: number; total: number }
  /** Intent counts by status, in range. */
  intents: { in_progress: number; todo: number; done: number }
  /** Discussion counts by status, in range. */
  discussions: { in_progress: number; completed: number }
  /** Schedules: `total`/`active` rows in range; `running` schedules with a live execution log. */
  schedules: { running: number; active: number; total: number }
}

// Client → Server
export type ClientToServer =
  /**
   * A user turn. `images` (optional) carries attached images alongside the
   * text — multiple allowed, each a {@link PromptImage} (base64 + media type).
   * The server validates every `mediaType` against {@link IMAGE_MEDIA_TYPES}
   * and rejects the whole turn on any non-image type (`prompt.unsupportedFile`).
   */
  | { type: 'user_prompt'; text: string; images?: PromptImage[] }
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
  /**
   * Change the active session's permission mode (per-session, persisted). `mode`
   * is a vendor-native {@link ModeToken} the server resolves against the session's
   * vendor catalog (2026-06-07-012).
   */
  /**
   * Change the active session's permission mode (per-session, persisted). `mode`
   * is a vendor-native {@link ModeToken} (claude) or a {@link CodexPolicy}
   * (codex) the server resolves against the session's vendor catalog.
   */
  | { type: 'set_mode'; mode: ModeToken | CodexPolicy }
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
  | { type: 'list_sessions'; workspaceId: string }
  /**
   * Create a new (pending) session in a workspace and make it active. The
   * optional `agentId` is the agent the new session should run on (ADR-0015): it
   * is recorded as the pending session's mutable *intent*, so the first run
   * launches with it (and freezes that agent's vendor onto the session). Absent
   * or empty ⇒ **Auto** — no intent is written and the run falls back to the
   * configured `defaultAgentId`.
   */
  | { type: 'create_session'; workspaceId: string; agentId?: string }
  /** Delete a session from disk. */
  | { type: 'delete_session'; workspaceId: string; sessionId: string }
  /** Make a session active; server replies with `session_selected` (history + mode). */
  | { type: 'select_session'; workspaceId: string; sessionId: string }
  /** Rename a session's title. */
  | { type: 'rename_session'; workspaceId: string; sessionId: string; title: string }
  /** Stop the in-flight run of the currently-viewed session (if any). */
  | { type: 'stop_run' }
  /** Rebinding `${conn.viewing}` from a pending id to the real SDK id (ADR-0018 resident subs model). */
  | { type: 'rebind_view'; from: string; to: string }
  /** List slash commands/skills for the active session's cwd (reply: `commands`). */
  | { type: 'list_commands' }
  /** Fetch the system configuration (reply: `settings`). */
  | { type: 'get_settings' }
  /** Replace the system configuration; server normalizes and echoes `settings`. */
  | { type: 'save_settings'; settings: SystemSettings }
  /**
   * Authenticate this connection (ADR-0023). Carries an {@link AuthLoginRequest}
   * (plaintext password in transit only). Server replies with `login_result`.
   * Provider-neutral: the same message logs in under any future provider.
   * Contract-only this phase — no server-side verification exists yet.
   */
  | { type: 'login'; request: AuthLoginRequest }
  /** Invalidate this connection's session token (ADR-0023). No reply required. */
  | { type: 'logout' }
  /**
   * Set (or change) the single admin's `basic` credentials (ADR-0023). The
   * plaintext `password` exists ONLY in transit — the server hashes it and
   * persists the hash; plaintext never lands on disk. `currentPassword` is the
   * sensitive-operation gate: required (and verified against the stored hash)
   * when an admin already exists, omitted on the first (bootstrap) set. Server
   * replies `admin_password_result`, then echoes a fresh `settings` on success.
   */
  | { type: 'set_admin_password'; username: string; password: string; currentPassword?: string }
  /** Load a workspace's setting (reply: `workspace_setting`). */
  | { type: 'load_workspace_setting'; workspaceId: string }
  /** Save a workspace's setting. */
  | { type: 'save_workspace_setting'; workspaceId: string; config: WorkspaceSetting }
  /** List a project's intents (reply: `intents`), optionally filtered by status. */
  | { type: 'list_intents'; workspaceId: string; status?: IntentStatus }
  /**
   * Enter the intent view for a project: open or resume a communication session
   * and return the intent list. `sessionId` is optional — when provided the
   * server opens that specific session (switching to it); when absent it opens
   * the project's current (`is_current`) session (same as before). Replies with
   * a `session_selected` for the comm session plus an `intents` list.
   */
  | { type: 'open_intent_chat'; workspaceId: string; sessionId?: string }
  /**
   * List a project's intent communication sessions (reply: `intent_sessions`).
   * Each session carries id, title (nullable), and updatedAt. The response also
   * carries a `runStates` snapshot of which sessions have a live agent run.
   */
  | { type: 'list_intent_sessions'; workspaceId: string }
  /**
   * Rename an intent communication session (must exist; error otherwise).
   * The server broadcasts the refreshed `intent_sessions` list on success.
   */
  | { type: 'rename_intent_session'; workspaceId: string; sessionId: string; title: string }
  /**
   * Delete an intent communication session: removes the db row, removes the
   * runtime (aborts any active run), and broadcasts the refreshed list. If the
   * deleted session was `is_current`, the most recent remaining session becomes
   * the new default. Error if the session does not exist.
   */
  | { type: 'delete_intent_session'; workspaceId: string; sessionId: string }
  /**
   * Start a brand-new communication session for a project: resets the previous
   * `is_current` comm session to 0, creates a fresh one marked current, and
   * replies with a `session_selected` (empty history) plus the `intents`
   * list. The "+" button in the intent view title bar triggers this.
   */
  | { type: 'new_intent_chat'; workspaceId: string }
  /**
   * Restart the comm session as a fresh one seeded with a intent to refine;
   * the server injects the first prompt with the intent's id and content.
   */
  | { type: 'refine_intent'; workspaceId: string; intentId: string }
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
  | { type: 'start_development'; workspaceId: string; intentId: string }
  /** Manually set a intent's status (e.g. mark done/cancelled). */
  | { type: 'update_intent_status'; intentId: string; status: IntentStatus }
  /** Toggle a intent's automation flag (whether the orchestrator may pick it). */
  | { type: 'set_intent_automate'; intentId: string; automate: boolean }
  /**
   * Update an intent's dependency list with per-edge dep_type.
   * Replaces the entire dependency set — all prior edges are removed.
   * Each edge specifies the depended-on intent id and the dependency type.
   */
  | {
      type: 'update_intent_deps'
      intentId: string
      deps: { dependsOnId: string; depType: DepType }[]
    }
  /**
   * Set git-related info on an intent (branch name, commit hash, PR id, PR status).
   * All fields are optional — only provided fields are updated.
   */
  | {
      type: 'set_intent_git_info'
      intentId: string
      branchName?: string
      latestCommitHash?: string
      prId?: string
      prStatus?: IntentPrStatus
    }
  /** Start the project's automation orchestrator (develops `automate` intents). */
  | { type: 'start_automation'; workspaceId: string }
  /** Stop the project's automation orchestrator (aborts the current dev run). */
  | { type: 'stop_automation'; workspaceId: string }
  /**
   * Create a GitHub Pull Request for a `done` intent that has no PR yet.
   * The server runs `gh pr create`, sets `prId` and `prStatus='reviewing'`
   * on success, or replies with `intent.prCreateFailed` on failure.
   * Rejected if the intent is not `done`, already has a `prId`,
   * or `gh` CLI is unavailable.
   */
  | { type: 'create_pr'; workspaceId: string; intentId: string }
  /** List a project's discussions (reply: `discussions`), optionally filtered by status. */
  | { type: 'list_discussions'; workspaceId: string; status?: DiscussionStatus }
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
      workspaceId: string
      discussionType: string
      goal: string
      context?: string
      /**
       * The agents selected to participate. Persisted to the discussion; the
       * orchestrator nominates speakers from this set only (the organizer/default
       * agent is always folded in). Defaults all-enabled in the UI, with the
       * organizer entry forced on. An empty/omitted array means the legacy
       * "whole roster" fallback.
       */
      participantAgentIds?: string[]
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
  | { type: 'create_schedule'; workspaceId: string; input: CreateScheduleInput }
  /** List schedules in a workspace; server replies with `schedules`. */
  | { type: 'list_schedules'; workspaceId: string }
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
  | { type: 'get_workspace_mcp_config'; workspaceId: string }
  /** Save workspace-level MCP server configuration. */
  | {
      type: 'save_workspace_mcp_config'
      workspaceId: string
      config: WorkspaceMcpConfig
    }
  /**
   * Request a vendor's tool manifest for schedule form tool selection.
   * Server replies with `schedule_tool_manifest`.
   */
  | { type: 'get_schedule_tool_manifest'; vendor: VendorId; workspaceId: string }
  /**
   * Resolve a pending pre-launch skill-load gate (mount layer 2/3). `approve`
   * lets the mount proceed and persists the `.gitignore` ack; `cancel` skips
   * appending the `.gitignore` line (the skill is then not mounted, but the
   * session still launches). Correlated to a {@link SkillLoadApprovalRequest} by
   * `requestId`.
   */
  | { type: 'skill_load_approval_resolve'; requestId: string; decision: 'approve' | 'cancel' }
  /**
   * Query the install-link status of every configured skill repo in a project
   * (2026-06-12). Server replies with {@link skill_link_status}: per `id`, whether
   * `_c3_<id>` is a live symlink under each of the two shared public skill dirs
   * (`.claude/skills`, `.agents/skills`). Read-only, zero network.
   */
  | { type: 'get_skill_link_status'; workspaceId: string }
  /**
   * Explicitly install (or update) one configured skill repo (2026-06-12): clone/
   * pull the configured ref's latest head, then force-relink `_c3_<id>` into the
   * two shared public skill dirs (old link/dir removed first). Keeps the one-time
   * `.gitignore` ack. Server replies with {@link skill_install_result}. This
   * replaces the removed launch-time auto-mount — installs happen on user action.
   */
  | { type: 'install_skill'; workspaceId: string; skillId: string }
  /**
   * Request the project's wait-user-involve events — the server replies with
   * {@link wait_user_events}. An optional `status` filter narrows to one
   * lifecycle state (default: all).
   */
  | { type: 'list_wait_user_events'; workspaceId: string; status?: WaitUserInvolveStatus }
  /**
   * WorkCenter cross-project rollup: aggregate per-project counts (work sessions /
   * intents / discussions / schedules) across **all** registered workspaces in one
   * round-trip. Replies with {@link timerange_stats}. `startTime`/`endTime`
   * (ms since epoch) are optional; absent ⇒ no time filter (count everything).
   * The range filters intents/discussions/schedules by `updated_at` and sessions
   * by `last_modified`; the `running` counts are a live "now" notion and ignore it.
   */
  | { type: 'get_timerange_stats'; startTime?: number; endTime?: number }
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
  /** Full workspace list, sorted by recent access (desc). */
  | { type: 'workspaces'; workspaces: WorkspaceInfo[] }
  /** Session list for one workspace, sorted by last-modified (desc). */
  | { type: 'sessions'; workspaceId: string; sessions: SessionInfo[] }
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
      workspaceId: string
      sessionId: string
      title: string
      /** Vendor-native {@link ModeToken}; interpret via `vendor`'s catalog (2026-06-07-012). */
      mode: ModeToken
      /**
       * Codex dual-policy config (2026-06-08). Present only for codex-vendor sessions
       * that have a stored or default `CodexPolicy`. When absent, the web falls back
       * to deriving the dual-policy from `mode` via the catalog + `gateToCodexPolicy`.
       */
      codexPolicy?: CodexPolicy
      history: TranscriptItem[]
      status: SessionStatus
      /**
       * The session's resolved agent vendor (ADR-0015) — a real session's frozen
       * vendor, a pending session's intent/default vendor, or an intent comm
       * session's bound agent vendor — used to paint the vendor colour dot
       * beside the title.
       */
      vendor?: VendorId
      /**
       * Data for the title-bar same-vendor agent switcher (ADR-0015 / AS-R22): the
       * other **same-vendor, host-binary-present, enabled** agents this session may
       * switch to (cross-vendor never appears — vendor is frozen), plus whether the
       * current agent's host CLI is missing. Present for any session with a bound
       * agent that has switch candidates; absent for sessions without a resolved
       * fact (e.g. brand-new pending with no intent yet).
       */
      agentSwitch?: SessionAgentSwitch
    }
  /** Binds a pending session's `clientId` to its real SDK `sessionId`. */
  | {
      type: 'session_started'
      clientId: string
      sessionId: string
      agentSwitch?: SessionAgentSwitch
    }
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
  /** Confirms the active session's mode change. `mode` is the vendor-native {@link ModeToken}. */
  | { type: 'mode_changed'; mode: ModeToken; codexPolicy?: CodexPolicy }
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
   * The normalized workspace setting (reply to `load_workspace_setting` or
   * `save_workspace_setting`). `detectedMainBranch` is the server-probed default
   * branch (origin/HEAD → current HEAD; undefined when unresolvable) the form
   * uses to pre-fill `defaultMainBranch` — present on the `load` reply only.
   */
  | {
      type: 'workspace_setting'
      workspaceId: string
      config: WorkspaceSetting
      detectedMainBranch?: string
    }
  /**
   * Result of a `login` attempt (ADR-0023). Carries an {@link AuthLoginResult}:
   * on success the issued session token + its absolute expiry, on failure a
   * structured {@link AuthFailureCode}.
   */
  | { type: 'login_result'; result: AuthLoginResult }
  /**
   * Result of a `set_admin_password` attempt (ADR-0023). On success the new
   * credentials are already hashed + persisted (a fresh `settings` frame
   * follows); on failure carries a structured {@link AdminPasswordFailureCode}.
   */
  | { type: 'admin_password_result'; result: AdminPasswordResult }
  /**
   * The connection is not authenticated (ADR-0023) — the WS analogue of HTTP
   * 401. Emitted when an action requires auth but the connection presents no
   * valid session token. `reason` distinguishes a missing / expired / otherwise
   * invalid token so the client can decide whether to re-prompt for login.
   */
  | { type: 'unauthenticated'; reason: 'missing' | 'expired' | 'invalid' }
  /** A project's intent list (reply to `list_intents`/`open_intent_chat`, or a push after a change). */
  | { type: 'intents'; workspaceId: string; items: Intent[] }
  /**
   * A project's intent-communication-session list (reply to `list_intent_sessions`
   * or push after a change). `runStates` is a live snapshot of which listed
   * sessions have an active agent run (id → `'running'`) — absent entries have
   * no live run.  It rides every list send (first fetch / reconnect re-fetch /
   * state-change push), so a refresh or reconnect authoritatively reconciles the
   * run-state of background sessions (decoupled from persisted `status`).
   */
  | {
      type: 'intent_sessions'
      workspaceId: string
      items: IntentSessionInfo[]
      runStates?: Record<string, 'running'>
    }
  /**
   * The project's automation-orchestrator status. Pushed on entering the
   * intent view and on every state change (start/stop/progress/error), so
   * the intent list's automation button reflects the live run.
   */
  | { type: 'automation_status'; status: AutomationStatus }
  /**
   * Reply to a `create_pr` request. Carries the PR id and URL on success.
   * On failure the server sends a generic `error` with code `intent.prCreateFailed`.
   */
  | { type: 'create_pr_response'; prId: string; prUrl?: string }
  /**
   * A project's discussion list (reply to `list_discussions`/`open_discussion` entry, or a push
   * after a change). `runStates` is a live snapshot of which listed discussions have an active
   * orchestration run (id → `running`/`paused`) — only active entries are present. It rides every
   * list send (first fetch / reconnect re-fetch / state-change push), so a refresh or reconnect
   * authoritatively reconciles the run-state of background runs (decoupled from persisted `status`).
   */
  | {
      type: 'discussions'
      workspaceId: string
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
      /**
       * True when this tool is a user-interaction tool (e.g. AskUserQuestion,
       * ExitPlanMode) — a model-initiated prompt that needs the user's attention
       * before the run can continue. The server sets this at emission time so the
       * web can identify interaction tools without a client-side name-based
       * allowlist. Absent/false for tools that execute a side effect or read data
       * without involving the user in a dialogue.
       */
      isUserInteraction?: boolean
    }
  | {
      type: 'tool_result'
      toolUseId: string
      content: string
      isError: boolean
      isUserInteraction?: boolean
    }
  /**
   * Task-list wire path (2026-06-07-009). An independent channel for the dev
   * session's task list (TaskCreate / TaskList / TaskUpdate / TaskGet), so the
   * client fills its task panel from typed messages instead of re-parsing
   * `tool_result.content` text. The server derives the model at the `emit()`
   * fan-out point (Claude: from the task-tool `tool_use`/`tool_result` stream —
   * the SDK has no native task-push event) and on history replay (from the
   * baseline transcript); a full {@link task_list} snapshot is the primary form
   * (idempotent, replay-friendly). The per-task variants exist for vendors that
   * push single-task updates natively (Codex `onUpdate`, wired later per
   * 2026-06-07-008 §6) and future incremental use. {@link TaskItem} carries
   * `order`, so the client consumes it directly into its `taskModel`.
   */
  | { type: 'task_list'; tasks: TaskItem[] }
  | { type: 'task_created'; task: TaskItem }
  | { type: 'task_updated'; task: TaskItem }
  | { type: 'task_deleted'; taskId: string }
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
      /**
       * True when this permission request is for a user-interaction tool
       * (e.g. AskUserQuestion) — a model-initiated prompt that needs the user's
       * attention before the run can continue. Absent/false for tools that execute
       * a side effect or read data without involving the user in a dialogue.
       */
      isUserInteraction?: boolean
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
  | { type: 'schedules'; workspaceId: string; items: Schedule[] }
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
  | { type: 'workspace_mcp_config'; workspaceId: string; config: WorkspaceMcpConfig }
  /** A vendor's tool manifest (reply to `get_schedule_tool_manifest`). */
  | { type: 'schedule_tool_manifest'; vendor: VendorId; tools: ToolManifestEntry[] }
  /**
   * A project's wait-user-involve event list (reply to `list_wait_user_events`).
   * Pushed as a full snapshot every time — the client replaces its local state
   * rather than merging.
   */
  | { type: 'wait_user_events'; items: WaitUserInvolveEvent[] }
  /**
   * A pre-launch skill-load gate awaiting a human decision (mount layer 2/3; the
   * modal is rendered by 3/3). The backend emits one before the first external-skill
   * mount in a project, when the one-time `.gitignore` write needs an ack, then
   * blocks that mount on the matching {@link SkillLoadApprovalRequest}
   * `skill_load_approval_resolve`. `detail` is a human-readable summary of what is
   * about to happen (the `.gitignore` line to append).
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
  /** WorkCenter cross-project rollup (reply to `get_timerange_stats`). One entry per workspace. */
  | { type: 'timerange_stats'; stats: TimeRangeProjectStats[] }
  /**
   * Reply to {@link get_skill_link_status} (2026-06-12): one {@link SkillLinkStatus}
   * per configured skill repo, reporting `_c3_<id>` symlink presence in each of the
   * two shared public skill dirs.
   */
  | { type: 'skill_link_status'; workspaceId: string; statuses: SkillLinkStatus[] }
  /**
   * Reply to {@link install_skill} (2026-06-12). `ok` ⇒ the skill is cloned/pulled
   * to its ref's latest head and (re)linked into both public dirs. On failure,
   * `reason` is a machine token (UI maps it to copy; mirrors `SkippedSkill.reason`)
   * and `detail` carries English debug text (not UI copy).
   */
  | {
      type: 'skill_install_result'
      workspaceId: string
      skillId: string
      ok: boolean
      reason?: 'not-configured' | 'repo-error' | 'gitignore-cancelled'
      detail?: string
    }
  | { type: 'pong' }
