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

/** A Claude session inside a workspace, as surfaced to the sidebar. */
export interface SessionInfo {
  /** SDK session UUID. */
  sessionId: string
  /** Display title: SDK custom title, summary, or first prompt. */
  title: string
  /** SDK last-modified time, ms since epoch. Sort key within a workspace (desc). */
  lastModified: number
  /** c3-tracked permission mode for this session. */
  mode: PermissionMode
  /** Whether this session was created by a tool (not the user). */
  isToolSession: boolean
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

/**
 * The system configuration, persisted at `~/.c3/settings.json`. Always contains
 * the system agent; `defaultAgentId` references an existing agent's id.
 */
export interface SystemSettings {
  agents: AgentConfig[]
  /** Id of the agent new/unassigned sessions launch with. */
  defaultAgentId: string
  /** Permission mode new sessions start in. Optional; `default` when unset. */
  defaultMode?: PermissionMode
  /** Multi-agent consensus voting on permission prompts. Optional; off by default. */
  consensus?: ConsensusConfig
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
  /** Slash command (leading `/`) prefixed to the requirement content when launching
   * development. Optional; empty/unset ⇒ no skill prefix. */
  devSkill?: string
  /** Per-stage round cap for multi-agent discussions. Minimum 8 (lower values are
   * clamped up); an unset/invalid value falls back to a sane default (≥ 8). */
  maxRoundsPerStage?: number
  /**
   * Per-turn character limit for participant speech in discussions. This is a
   * prompt-level guidance — participants are asked to keep replies within this
   * budget, but over-long replies are accepted verbatim (no hard truncation).
   * Minimum 300 (lower values are clamped up); an unset/invalid value falls
   * back to the default (≥ 300).
   */
  maxSpeechChars?: number
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

// ---- Requirement management ----

/** Requirement priority. `P0` highest … `P3` lowest. */
export type RequirementPriority = 'P0' | 'P1' | 'P2' | 'P3'

/**
 * Requirement lifecycle status.
 * - `draft` — captured but not yet finalized (optional).
 * - `todo` — finalized, not started (the state save-to-db produces).
 * - `in_progress` — development launched (dev session running).
 * - `done` / `cancelled` — terminal, set by the user (never auto-set).
 */
export type RequirementStatus = 'draft' | 'todo' | 'in_progress' | 'done' | 'cancelled'

/**
 * Derived run-state of an in_progress requirement, computed by reconciling the
 * requirement's lastDevSessionId liveness against the process table.
 * - `running` — the dev session's process is still alive (tracking in-flight).
 * - `dangling` — the dev process is dead but the requirement is still in_progress
 *   (service restart / crash); a completion judge found the requirement not done.
 * - `idle` — not in_progress, or the dev process ended and the judge confirmed done
 *   (just done, or never started).
 */
export type RequirementRunStatus = 'running' | 'dangling' | 'idle'

/** One persisted requirement, scoped to a project (workspace path). */
export interface Requirement {
  /** Stable uuid. */
  id: string
  /** Owning project — the workspace absolute path (resolved). */
  projectPath: string
  title: string
  content: string
  priority: RequirementPriority
  /** Owning module name, inferred by the comm agent from title/content. `''` when historic/unidentified. */
  module: string
  status: RequirementStatus
  /** Ids of other requirements (same project) this one depends on. */
  dependsOn: string[]
  /** The last dev session launched for this requirement, for the detail back-link. */
  lastDevSessionId: string | null
  /**
   * Whether the automation orchestrator may pick this requirement up. User-toggled
   * (a checkbox per requirement); `false` by default. Only `automate` requirements
   * are developed by `start_automation`.
   */
  automate: boolean
  createdAt: number
  updatedAt: number
  /** When the requirement entered `done`; `null` until completed, cleared if it leaves `done`. */
  completedAt: number | null
  /**
   * Derived run-state of an `in_progress` requirement, computed at list-time by
   * the server's reconcile logic. `'idle'` for other statuses. Clients use this
   * to render a "tracking" badge or a "dangling" warning next to an in_progress item.
   */
  runStatus: RequirementRunStatus
}

/**
 * Lifecycle of the per-project automation orchestrator (a single background loop
 * that develops `automate` requirements one by one, by priority + dependencies).
 * - `idle` — not running (never started, or stopped by the user).
 * - `running` — actively developing requirements.
 * - `done` — finished: no more eligible requirements remain.
 * - `error` — stopped abnormally (a dev run errored, blocked on a permission, a
 *   completion check failed, or commit/push failed). `error` text says why.
 */
export type AutomationState = 'idle' | 'running' | 'done' | 'error'

/** A project's automation orchestrator status, broadcast to every connection. */
export interface AutomationStatus {
  /** Owning project — the workspace absolute path (resolved). */
  projectPath: string
  state: AutomationState
  /** The requirement currently being developed (null when not running). */
  currentRequirementId: string | null
  /** The dev session of the current requirement, for a back-link (null when none). */
  currentSessionId: string | null
  /**
   * True while the current dev turn is paused on a permission prompt awaiting a
   * human answer (automation mirrors manual: it does NOT abort, it waits for the
   * watching human to answer in the browser). Cleared once the turn settles.
   */
  awaitingPermission: boolean
  /** Why the orchestrator stopped abnormally; null unless `state === 'error'`. */
  error: string | null
  /** Requirement ids completed (committed + pushed) in this run. */
  completedIds: string[]
  /** When the orchestrator was started, ms since epoch; null when never started. */
  startedAt: number | null
}

/**
 * One requirement proposed by the requirement-communication agent via the
 * `save_requirements` tool. Rendered in the confirmation prompt; persisted with
 * status `todo` once the user allows.
 */
export interface ProposedRequirement {
  title: string
  content: string
  priority: RequirementPriority
  /** Module name the comm agent inferred from title/content; persisted as `''` when omitted. */
  module?: string
  /** Optional ids of existing requirements (same project) it depends on. */
  dependsOn?: string[]
  /**
   * Optional 0-based indexes into THIS batch's `requirements` array, naming
   * sibling proposed requirements this item depends on. Sibling ids don't exist
   * yet at proposal time, so intra-batch ordering can only be expressed by index;
   * `insertRequirements` resolves each index to the sibling's freshly-minted id and
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
  /** Make a session active; server replies with `session_selected` (history + mode). */
  | { type: 'select_session'; workspacePath: string; sessionId: string }
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
  /** List a project's requirements (reply: `requirements`), optionally filtered by status. */
  | { type: 'list_requirements'; projectPath: string; status?: RequirementStatus }
  /**
   * Enter the requirement view for a project: open or resume its (persisted)
   * communication session and return the requirement list. Replies with a
   * `session_selected` for the comm session plus a `requirements` list.
   */
  | { type: 'open_requirement_chat'; projectPath: string }
  /**
   * Start a brand-new communication session for a project: resets the previous
   * `is_current` comm session to 0, creates a fresh one marked current, and
   * replies with a `session_selected` (empty history) plus the `requirements`
   * list. The "+" button in the requirement view title bar triggers this.
   */
  | { type: 'new_requirement_chat'; projectPath: string }
  /**
   * Restart the comm session as a fresh one seeded with a requirement to refine;
   * the server injects the first prompt with the requirement's id and content.
   */
  | { type: 'refine_requirement'; projectPath: string; requirementId: string }
  /**
   * Bridge a completed discussion's conclusion into the requirement domain: a
   * `refine_requirement` variant whose seed is the discussion's conclusion rather
   * than an existing requirement. The server resolves the project from the
   * discussion, restarts the comm session as a fresh one, injects a first prompt
   * carrying the discussion title + conclusion, and replies with a
   * `session_selected` (empty history) plus the `requirements` list. Rejected if
   * the discussion is missing, not `completed`, or has no conclusion. The agent
   * then splits it into requirements via the unchanged `save_requirements` flow.
   */
  | { type: 'discussion_to_requirement'; discussionId: string }
  /** Launch a background dev session for a `todo` requirement via the configurable development skill. */
  | { type: 'start_development'; projectPath: string; requirementId: string }
  /** Manually set a requirement's status (e.g. mark done/cancelled). */
  | { type: 'update_requirement_status'; requirementId: string; status: RequirementStatus }
  /** Toggle a requirement's automation flag (whether the orchestrator may pick it). */
  | { type: 'set_requirement_automate'; requirementId: string; automate: boolean }
  /** Start the project's automation orchestrator (develops `automate` requirements). */
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
   * human's follow-up question/requirement as a `human` message, flips the
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
       * vendor colour dot beside the title. Absent for comm/requirement sessions
       * (no agent dot there).
       */
      vendor?: VendorId
    }
  /** Binds a pending session's `clientId` to its real SDK `sessionId`. */
  | { type: 'session_started'; clientId: string; sessionId: string }
  /** Confirms the active session's mode change. */
  | { type: 'mode_changed'; mode: PermissionMode }
  /** Available slash commands/skills for the active session (reply to `list_commands`). */
  | { type: 'commands'; commands: SlashCommandInfo[] }
  /**
   * The (normalized) system configuration, in reply to `get_settings`/`save_settings`.
   * Carries two runtime-derived companions the config object itself does not hold:
   * `hostStatus` — each vendor's host-CLI presence (ADR-0012), so the console can
   * grey out an agent whose binary is not on PATH; and `bindingStats` — the
   * session→agent binding counts (ADR-0015), so the console can explain that a
   * default-agent change is not retroactive.
   */
  | {
      type: 'settings'
      settings: SystemSettings
      hostStatus: VendorHostStatus[]
      bindingStats: SessionBindingStats
    }
  /** A project's requirement list (reply to `list_requirements`/`open_requirement_chat`, or a push after a change). */
  | { type: 'requirements'; projectPath: string; items: Requirement[] }
  /**
   * The project's automation-orchestrator status. Pushed on entering the
   * requirement view and on every state change (start/stop/progress/error), so
   * the requirement list's automation button reflects the live run.
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
  | { type: 'pong' }
