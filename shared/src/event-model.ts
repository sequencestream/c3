/**
 * Vendor-neutral event domain model: the generic event core carried on the bus,
 * its envelope, and the typed projections a consumer reads off it (PR operation,
 * intent lifecycle). These are NOT WebSocket messages — they never appear in
 * `ClientToServer` / `ServerToClient`; they are the payload contract shared by the
 * publishing model (via the `publish_event` MCP tool), the server event layer and
 * the console. Trigger filters live in `event-filter-model.ts`, the known
 * category/action suggestions in `event-catalog.ts`.
 */
import type { IntentStatus, RunLifecycleTopic } from './protocol.js'

// ---- Generic event contract (vendor-neutral) -------------------------------
//
// A single, vendor-neutral shape a model-published event may take BEFORE it is
// carried on the bus. The kernel event layer keeps a `type → normalizer`
// registry; only a registered `type` may publish, and its normalizer performs
// the field-level redaction/truncation. The normalized event is wrapped in a
// {@link GenericEventEnvelope} and carried on the single `'event'` bus topic;
// consumers discriminate on `event.type`. The PR operation event (below) is the
// first registered type. See `doc/architecture/event-mechanism.md`.

/**
 * A JSON-compatible value. Excludes functions, class instances, `undefined`,
 * symbols, non-finite numbers and cycles so an event stays copyable, loggable
 * and transport-safe. Used for the recursive `data` payload of a generic event.
 */
export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

/** A JSON-compatible object — the top-level shape of a generic event's `data`. */
export type JsonObject = { [key: string]: JsonValue }

/**
 * A vendor-neutral generic event core (the untrusted shape a producer supplies).
 *
 * - `type` — REQUIRED, non-empty stable discriminant a normalizer registers
 *   against. It selects the field-level safety rules and must survive
 *   normalization unchanged.
 * - `status` / `description` — OPTIONAL free-text (e.g. an outcome + a summary).
 * - `metadata` — OPTIONAL FLAT `string → string` map (nested values are rejected).
 * - `data` — OPTIONAL JSON-compatible (recursively nested) object.
 */
export interface GenericEvent {
  type: string
  status?: string
  description?: string
  metadata?: Record<string, string>
  data?: JsonObject
}

/**
 * The bus envelope carrying a NORMALIZED {@link GenericEvent}. `workspacePath` +
 * `sessionId` are injected by the per-run binding closure AFTER normalization
 * succeeds — the raw event, its `metadata` and `data` may NOT override them (the
 * model cannot forge another workspace or session).
 */
export interface GenericEventEnvelope {
  workspacePath: string
  sessionId: string
  event: GenericEvent
}

// ---- Vendor-neutral PR operation events (2026-06-20) -----------------------
//
// c3 never executes a PR operation. The model uses its OWN tools (gh CLI, a
// GitHub MCP, …) to create / review / merge / close / comment on a PR, and AFTER
// the operation completes (or fails) it calls the `publish_event` MCP tool with
// `type: 'pr:operation'` to publish ONE vendor-neutral PR operation event. A
// automation can subscribe and trigger its existing follow-up action. The
// contract is NOT bound to GitHub — `repo.provider` keeps room for GitLab.

/**
 * PR operation kinds a model may report (vendor-neutral). `update` means an
 * EXISTING PR was modified by the model and re-submitted / re-opened (e.g. after
 * a rejected review the model pushes a fix), NOT the creation of a new PR.
 */
export const PR_OPERATIONS = ['create', 'review', 'merge', 'close', 'comment', 'update'] as const
export type PrOperation = (typeof PR_OPERATIONS)[number]

/** Outcome of a PR operation the model performed with its own tools. */
export const PR_OPERATION_RESULTS = ['success', 'failure', 'error'] as const
export type PrOperationResult = (typeof PR_OPERATION_RESULTS)[number]

/** PR identity — every field optional and vendor-neutral. */
export interface PrRef {
  number?: number
  id?: string
  url?: string
  title?: string
  state?: string
}

/** Repository context — vendor-neutral. `provider` defaults to `'github'`, may be `'gitlab'` etc. */
export interface PrRepo {
  provider?: string
  host?: string
  owner?: string
  name?: string
}

/** Branch context for the PR. */
export interface PrBranchRef {
  head?: string
  base?: string
}

/** Association linking the event back to a c3 work item so a listener can correlate it. */
export interface PrEventAssociation {
  intentId?: string
  /** Human-readable intent name for self-describing events; normalized server-side (redacted + truncated to 256). */
  intentTitle?: string
}

/**
 * A vendor-neutral PR operation event, published by the model via the
 * `publish_event` MCP tool (`type: 'pr:operation'`) after it performs a PR
 * operation with its own tools. Projected off the normalized generic event by the
 * PR consumers. `errorSummary` is meaningful only when `result === 'failure'` or
 * `result === 'error'` and is safely normalized server-side (never carries
 * tokens or raw CLI output).
 */
export interface PrOperationEvent {
  operation: PrOperation
  result: PrOperationResult
  pr?: PrRef
  repo?: PrRepo
  ref?: PrBranchRef
  association?: PrEventAssociation
  errorSummary?: string
}

/** Intent lifecycle boundaries a automation may subscribe to. */
export const INTENT_LIFECYCLE_PHASES = [
  'created',
  'dev_started',
  'done',
  'failed',
  'cancelled',
] as const
export type IntentLifecyclePhase = (typeof INTENT_LIFECYCLE_PHASES)[number]

/** Safe, stable context emitted at an intent lifecycle boundary. */
export interface IntentLifecycleEvent {
  phase: IntentLifecyclePhase
  intentId: string
  title: string
  module: string | null
  toStatus: IntentStatus
}

/**
 * Topics an event-triggered automation may subscribe to: the run lifecycle topics
 * plus the model-published `pr:operation` event (2026-06-20).
 */
export type ScheduleEventTopic = RunLifecycleTopic | 'pr:operation' | 'intent:lifecycle'

/**
 * Filter for `pr:operation` event triggers: a automation fires only when the
 * event's operation is in `operations` AND its result is in `results`. An empty
 * (or absent) list for either dimension matches any value of that dimension.
 */
export interface PrOperationFilter {
  operations?: PrOperation[]
  results?: PrOperationResult[]
}

/** Optional phase filter for `intent:lifecycle`; absent or empty matches every phase. */
export interface IntentLifecycleFilter {
  phases?: IntentLifecyclePhase[]
}
