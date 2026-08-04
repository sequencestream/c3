/**
 * Automations, their generic event trigger contract, MCP tool manifest and
 * wait-user-involve events.
 *
 * Part of the `@ccc/shared/protocol` contract; re-exported by `../protocol.ts`.
 */

import type { AnyConsensusOutcome } from './consensus.js'
import type { SessionKind } from './session.js'
import type { CodexPolicy, ModeToken, VendorId } from './vendor.js'

// ---- Automations ----

export type AutomationType = 'command' | 'llm'

/**
 * The vendors that have an automation **execution path** in the dispatcher.
 *
 * A structural fact about c3, not runtime state, so it does not travel on the
 * wire: the dispatcher gates on it before launching, and the automation form
 * greys out the same set — one list, so the form can never offer a vendor the
 * dispatcher would refuse. A vendor absent here still shows in existing
 * automation records (they stay viewable) but cannot be chosen as an executor.
 */
export const AUTOMATION_VENDORS = [
  'claude',
  'codex',
  'cursor',
] as const satisfies readonly VendorId[]

/**
 * Whether a vendor can execute automations. Routing this through a predicate,
 * rather than a hard-coded `=== 'claude'`, is what keeps the dispatcher's
 * hard-fail and the form's greying provably the same rule.
 */
export function vendorSupportsAutomation(vendor: VendorId): boolean {
  return (AUTOMATION_VENDORS as readonly VendorId[]).includes(vendor)
}

/** Smallest accepted automation execution wall-clock limit (one second). */
export const MIN_AUTOMATION_MAX_WALL_CLOCK_MS = 1_000

/** Largest accepted automation execution wall-clock limit (twenty-four hours). */
export const MAX_AUTOMATION_MAX_WALL_CLOCK_MS = 24 * 60 * 60 * 1_000

export type McpMode = 'read-only' | 'sandboxed' | 'full-access'

export type AutomationStatus = 'active' | 'paused' | 'error' | 'archived'

/** How a automation fires: time-based cron, or a run lifecycle event (2026-06-08). */
export type ScheduleTriggerType = 'cron' | 'event'

/** Run lifecycle topics an event-triggered automation may subscribe to (2026-06-08). */
export type RunLifecycleTopic = 'run:started' | 'run:settled'

/** Terminal reason a run settled with: clean finish, error, or user abort. */
export const RUN_END_REASONS = ['complete', 'error', 'aborted'] as const
export type RunEndReason = (typeof RUN_END_REASONS)[number]

/** One metadata condition: an event's `metadata[key]` must equal `value` (exact string match). */
export interface EventMetadataFilterCondition {
  key: string
  value: string
}

/**
 * Metadata condition filter for run-lifecycle event triggers (2026-07-04). An
 * automation carrying this filter fires only when the event payload's metadata
 * satisfies the conditions: `AND` requires every condition, `OR` at least one.
 * `null` or an empty `conditions` list means "no metadata filter" (matches any).
 * Matching is exact string equality — no case folding, regex, or substring.
 */
export interface EventMetadataFilter {
  conditions: EventMetadataFilterCondition[]
  combinator: 'AND' | 'OR'
}

/** Upper bounds for automation metadata / metadata-filter hygiene (server + client agree). */
export const MAX_AUTOMATION_METADATA_ENTRIES = 32
export const MAX_AUTOMATION_METADATA_KEY_LEN = 64
export const MAX_AUTOMATION_METADATA_VALUE_LEN = 256

// ---- Generic event filter (Automation trigger contract, 2026-07-13) --------
//
// A single, vendor-neutral trigger filter every event-triggered automation
// carries, in place of one bespoke `eventXxxFilter` field per topic. Matching
// reads only the trusted minimal view a {@link GenericEventEnvelope} already
// provides (`workspacePath` + `event`) — a new event type never requires a new
// protocol field, dispatch branch, or form panel. See
// `doc/architecture/event-mechanism.md` §7.

/**
 * An automation's generic event-trigger filter. `type` is the single stable
 * event type this automation subscribes to (required, non-empty — "one
 * automation subscribes to one event type", mirroring the retired
 * `ScheduleEventTopic` single-topic model). `statuses` is an optional set of
 * accepted `event.status` values (absent/empty = any status); it losslessly
 * captures the old `run:settled` reason list, PR result list, and intent phase
 * list as one dimension. `metadata` reuses {@link EventMetadataFilter} verbatim
 * (absent/empty = no metadata filter) — a PR operation multi-select migrates to
 * an `OR` of `{key:'operation', value}` conditions.
 */
export interface GenericEventFilter {
  type: string
  statuses?: string[]
  metadata?: EventMetadataFilter | null
}

/**
 * The run-lifecycle event types (the former `RunLifecycleTopic` values). An
 * event trigger whose filter `type` is one of these (or the `run:*` category
 * wildcard, which covers both) is a "run-lifecycle" trigger: it carries the
 * optional `eventSessionKindFilter` (absent/empty = every session kind) and its
 * `status` dimension is the run's terminal reason. Kept as a runtime array so
 * save-boundary / dispatch checks stay data-driven, not string-literal.
 */
export const RUN_LIFECYCLE_EVENT_TYPES = ['run:started', 'run:settled'] as const

// ---- Event type naming (category:action, 2026-07-14) -----------------------
//
// Event types follow `<category>:<action>` — the category groups a domain, the
// action names the fact that happened; `status` carries that fact's outcome and
// `metadata` the remaining flat context. The wire contract stays an OPEN string,
// so an unlisted `custom:thing` type publishes and subscribes fine; the known
// categories/actions/statuses are suggestions listed in `event-catalog.ts`. A
// filter `type` of `<category>:*` subscribes every action of that category.
// Definition catalog + naming spec live in `doc/architecture/event-mechanism.md`.

/** The category-wildcard action segment: `<category>:*` matches every action. */
export const EVENT_ACTION_WILDCARD = '*'

/** Upper bounds for a generic event filter — reuses the metadata hygiene bounds. */
export const MAX_EVENT_FILTER_TYPE_LEN = MAX_AUTOMATION_METADATA_KEY_LEN
export const MAX_EVENT_FILTER_STATUSES = MAX_AUTOMATION_METADATA_ENTRIES
export const MAX_EVENT_FILTER_STATUS_LEN = MAX_AUTOMATION_METADATA_VALUE_LEN
/** Upper bound on subscription rows (filters) one event automation may carry. */
export const MAX_EVENT_FILTERS = 16

export interface Automation {
  id: string
  type: AutomationType
  /**
   * Arbitrary JSON configuration, interpreted by the cron runner per `type`.
   * Holds `config.name` — a display name auto-generated by the server on create.
   * On update the client MAY supply `config.name` to set a manual title: a
   * non-empty value is stored sticky (`config.nameSource === 'user'`, auto-naming
   * never overrides it); an empty value reverts to an auto-derived name. There is
   * no `description` field; any in legacy rows is ignored.
   */
  config: unknown
  /**
   * Maximum wall-clock duration for one execution, in milliseconds. `null` uses
   * the task-type default (30 seconds for command, 60 seconds for LLM).
   */
  maxWallClockMs: number | null
  /** Owning workspace absolute path (resolved). */
  workspaceId: string
  /** Vendor this automation belongs to; determines which agent runs it. */
  vendor: VendorId
  /** Explicit agent profile for an LLM automation; null for commands and legacy rows. */
  agentId?: string | null
  /**
   * How this automation fires: `'cron'` (time-based) or `'event'` (run lifecycle).
   * Defaults to `'cron'` for legacy rows migrated before this field existed.
   */
  triggerType: ScheduleTriggerType
  /** Cron expression for `'cron'` triggers; empty string for `'event'` triggers. */
  cronExpression: string
  /** Unix ms timestamp of the next planned run; null when not scheduled (always null for `'event'`). */
  nextRunAt: number | null
  /**
   * For `'event'` triggers: the subscription rows (2026-07-14). Each row is one
   * {@link GenericEventFilter} (`type` = `<category>:<action>` or `<category>:*`,
   * plus optional `statuses` / `metadata`); the automation fires when ANY row
   * matches (OR). Non-empty for event triggers, `null` for cron. Replaces the
   * former single `eventFilter` (v12), itself the successor of `eventTopic` /
   * the per-topic filter fields.
   */
  eventFilters: GenericEventFilter[] | null
  /**
   * Free-form user annotations on this automation (2026-07-04). Carried into the
   * event payload so other automations can filter chains by it: the scheduler's own
   * `run:started` / `run:settled` for this automation, plus any event this
   * automation emits via the c3 `publish_event` tool (seeded as that event's
   * metadata base; the model's own `metadata` wins on key conflicts). Absent/missing
   * means `{}`.
   */
  metadata?: Record<string, string>
  /**
   * For run-lifecycle event triggers (any `eventFilters` row of a run-lifecycle
   * `type`): an OPTIONAL set of {@link SessionKind} origins that may fire this
   * automation (2026-07-04). Absent, `null` and `[]` are equivalent and mean
   * "every session kind" — the sessionKind dimension is skipped entirely; a
   * non-empty list stays an exact whitelist (only the listed kinds match, and an
   * event with no session origin never does). `null` for cron and
   * non-run-lifecycle event triggers. Legacy run-lifecycle rows migrated to
   * explicit `['work']` keep that behaviour. Kept independent of `eventFilters`
   * because it applies only to the run-lifecycle event types.
   */
  eventSessionKindFilter?: SessionKind[] | null
  /**
   * Server-derived, client-read-only: the agent session id of the run currently
   * executing this automation, or `null` when none is. Not a stored column —
   * computed on every read by joining `automation_execution_logs`, so it is
   * consistent across `listAutomations` / `getAutomation` and the `automations` /
   * `automation_detail` messages built from them.
   *
   * Non-null ONLY when the automation is `type='llm'` AND it has a log row with
   * `status='running'` AND a non-empty `session_id` (the real agent session, bound
   * shortly after the run starts). A command run, a run whose session id is not
   * bound yet, and any terminal log all yield `null`. When several candidate rows
   * exist (abnormal data), the one with the newest `started_at` wins, ties broken
   * by log id so the choice is deterministic.
   *
   * Liveness is not inferred: a `running` log left behind by a crashed process
   * keeps reporting its session id until the log is settled.
   */
  runningSessionId: string | null
  status: AutomationStatus
  mode: ModeToken | CodexPolicy
  toolAllowlist: string[]
  toolDenylist: string[]
  createdAt: number
  updatedAt: number
}

/**
 * Fields the client supplies when creating a automation.
 *
 * `config` carries the task body (`command` or `prompt`) but NOT a name or
 * description: on create the server auto-generates `config.name` from the task
 * content and strips any client-supplied `name`/`description`. (A manual title
 * is set later via {@link UpdateAutomationInput}, not at create time.)
 */
export interface CreateAutomationInput {
  type: AutomationType
  config: unknown
  /** Optional execution wall-clock limit; null selects the task-type default. */
  maxWallClockMs?: number | null
  workspaceId: string
  /** Vendor this automation belongs to; determines which agent runs it. */
  vendor: VendorId
  /** Explicit LLM execution agent. Required by the server for new LLM automations. */
  agentId?: string | null
  /** Defaults to `'cron'` when omitted (backward-compatible with legacy clients). */
  triggerType?: ScheduleTriggerType
  /** Required for `'cron'` triggers; empty string for `'event'` triggers. */
  cronExpression: string
  /**
   * Required for `'event'` triggers: the subscription rows (any-match OR). At
   * least one row with a valid `type` is mandatory; the server rejects an event
   * trigger whose list normalizes to empty. Ignored for cron triggers.
   */
  eventFilters?: GenericEventFilter[] | null
  /** Free-form annotations for the automation; sanitized server-side. Absent = `{}`. */
  metadata?: Record<string, string>
  /**
   * Optional for run-lifecycle event triggers (any `eventFilters` row of a
   * run-lifecycle `type`): the set of SessionKind origins that may fire it.
   * Absent / `null` / `[]` all mean "every session kind" (accepted, no
   * sessionKind filtering); a non-empty list is an exact whitelist. Ignored for
   * cron and non-run-lifecycle event triggers.
   */
  eventSessionKindFilter?: SessionKind[] | null
  mode: ModeToken | CodexPolicy
  toolAllowlist?: string[]
  toolDenylist?: string[]
  /**
   * Optional initial lifecycle status. Only `'paused'` is accepted — the server
   * rejects any other explicit value, so a client cannot bypass the normal
   * create-then-active flow. Used by JSON import to land a automation paused in the
   * SAME insert (no active→pause window a cron tick / event bus could exploit).
   * Omitted ⇒ the automation is created `'active'` as before.
   */
  initialStatus?: 'paused'
  /**
   * Optional initial display name. When a non-empty value is supplied the server
   * skips auto-naming and stores it as a sticky user-set `config.name`
   * (`nameSource === 'user'`), preserving an exported title across workspaces.
   * Omitted ⇒ the server auto-generates the name from the task content as before.
   */
  initialName?: string
}

/** Fields the client may supply when updating a automation. All optional. */
export interface UpdateAutomationInput {
  type?: AutomationType
  /**
   * Task body, plus an OPTIONAL `config.name` to set the display title:
   * a non-empty `name` is stored as a sticky user-set title; an empty `name`
   * reverts to an auto-derived one; omitting `name` keeps the existing title
   * (and its provenance) untouched. `description` is always stripped.
   */
  config?: unknown
  /** Optional execution wall-clock limit; null selects the task-type default. */
  maxWallClockMs?: number | null
  vendor?: VendorId
  /** Replace the explicit LLM execution agent. */
  agentId?: string | null
  triggerType?: ScheduleTriggerType
  cronExpression?: string
  /** Replace the subscription rows; at least one valid row required for an event trigger. */
  eventFilters?: GenericEventFilter[] | null
  /** Replace the free-form annotations; sanitized server-side. */
  metadata?: Record<string, string>
  /** Replace the run-lifecycle SessionKind filter; absent/null/empty = every session kind. */
  eventSessionKindFilter?: SessionKind[] | null
  mode?: ModeToken | CodexPolicy
  toolAllowlist?: string[]
  toolDenylist?: string[]
  status?: AutomationStatus
}

export interface AutomationExecutionLog {
  id: string
  automationId: string
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

// ---- Automation MCP Security ----

/** One entry in a vendor's tool manifest: tool name + read/write classification. */
export interface ToolManifestEntry {
  /** Tool name as the SDK knows it (e.g. 'Read', 'mcp__c3__find_intents'). */
  name: string
  /** Whether this tool is classified as a write operation. */
  isWrite: boolean
}

/**
 * Reserved pseudo-entry an automation may carry in its `toolAllowlist` to toggle
 * raw network access for a codex `workspace-write` sandbox (which denies network
 * by default). It is NOT a real tool: it never enters `freezeTools()` or the
 * permission grid, is stripped before the real tool allowlist is computed, and is
 * silently ignored for the claude vendor. Shared so server (strip + passthrough)
 * and web (form toggle) agree on the exact marker.
 */
export const AUTOMATION_NETWORK_ACCESS_TOOL = 'network-access'

// ---- Wait User Involve Events ----

/**
 * Sentinel `toolName` for the workbench todo a failed manual Start-work Git/PR
 * cleanup pushes. Not a real gated tool call (no `requestId`): the event's
 * `toolInput` carries a {@link UiError} `{code, params}` so the web localizes the
 * failure reason instead of showing a tool name. Shared so server (create) and
 * web (render) agree on the marker.
 */
export const GIT_CLEANUP_EVENT_TOOL = '__c3_git_cleanup__'

/**
 * Lifecycle status of a wait-user-involve event.
 *  - `'todo'`     — awaiting a human decision (drives the pending-items badge).
 *  - `'done'`     — the human allowed / answered the gated action.
 *  - `'canceled'` — the human denied it, or the owning run ended unanswered.
 *  - `'auto'`     — resolved by multi-agent consensus with NO human involved.
 *                   A non-blocking, audit-only record (never counted in the
 *                   badge); carries the {@link WaitUserInvolveEvent.outcome} that
 *                   decided it so the automatic decision stays traceable.
 */
export type WaitUserInvolveStatus = 'todo' | 'done' | 'canceled' | 'auto'

/**
 * An event requiring human attention — the server-side record of a tool call
 * the gateway gated behind a human decision (permission_response) before it
 * could proceed. Created at gate time, resolved when the human decides. The
 * web sidebar's "待处理" badge counts 'todo' entries per project.
 */
export interface WaitUserInvolveEvent {
  id: string
  /**
   * Owning workspace's **opaque id** (not a path). The store persists the absolute
   * `workspace_path` but maps it through `pathToId` on read, so this matches the id
   * the web's `currentWorkspace` holds and every jump entry (`select_session` /
   * `open_intent_session` / `open_spec_session` / discussion / automation) expects. A row
   * whose workspace is no longer registered is dropped on read rather than emitting
   * a broken id the web could not route.
   */
  workspaceId: string
  /**
   * The full {@link SessionKind} of the run that produced this event (work / intent /
   * discussion / automation / consensus / tool / spec). Stored verbatim — no longer
   * folded to a traceable-jump subset — so WorkCenter's "溯源跳转" can route off the
   * real session identity. Typed as `string` (not the `SessionKind` union) so the
   * protocol stays decoupled from the kind enum; the web's jump switch accepts a
   * string and falls back to the console for any unhandled value.
   */
  sessionKind: string
  /**
   * The id of the actual session that produced this event — a real, resolvable
   * session id (work/intent/spec session id, discussion id, automation id). The web's
   * `jumpToSource` routes off `sessionKind + sessionId` directly; the server derives
   * {@link intentId} / {@link intentTitle} from it on read. `null` when the producer
   * had no session to reference (e.g. a Start-work cleanup todo) — the web degrades to
   * the tab's list without selecting anything.
   *
   * Legacy note: rows written before 2026-06-26 may carry an intent OBJECT id here
   * (not a session id); those reverse-lookups simply return null and the event still
   * renders — historical rows degrade rather than mis-route.
   */
  sessionId: string | null
  /**
   * Owning intent id, **derived on read** by reverse-looking-up {@link sessionId}
   * against the intent-session bindings. Read-only (never supplied to `createEvent`);
   * `null` when the session is not bound to any intent (e.g. a plain work session) or
   * the row predates the session-id contract.
   */
  intentId?: string | null
  /**
   * Owning intent's title, **derived on read** alongside {@link intentId}. Reflects
   * the intent's current title (a rename shows up immediately, since it is not
   * persisted on the event). `null` whenever {@link intentId} is null.
   */
  intentTitle?: string | null
  /**
   * When true, this event lives at the intent level with no real session behind
   * {@link sessionId} — the session id is actually the owning intent's object id.
   * Jumping to this event should open the intent detail page, not a session page.
   * Derived on read in `toEvent` (never persisted); absent/false for events that
   * originated from a real producing session.
   */
  intentLevel?: boolean
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
  /**
   * The multi-agent consensus that auto-resolved this event, present ONLY on
   * `status: 'auto'` records (the gateway's `consensus_auto` outcome — votes,
   * decision, summary). Absent / null for human-decided events. Stored so an
   * automatic decision is auditable in WorkCenter without a blocking todo.
   */
  outcome?: AnyConsensusOutcome | null
  createdAt: number
  updatedAt: number
}

/** Fields the client may supply when listing events. */
export interface ListWaitUserEventsInput {
  workspaceId: string
  /** Optional status filter; absent = all. */
  status?: WaitUserInvolveStatus
  /** Page cursor: request events strictly older than this createdAt timestamp. */
  cursorTime?: number
  /** Tie-breaker for rows with the same createdAt as cursorTime. */
  cursorExcludeId?: string
  /** Page size; server defaults to 20. */
  limit?: number
}
