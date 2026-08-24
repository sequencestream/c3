/**
 * The PR event normalizer + the server-side PR-create constructor — the
 * feature-side pieces that plug into the vendor-neutral `publish_event` pipeline.
 *
 * The model-facing tool surface itself is generic and framing-free (schema +
 * description + core handler live in `../events/tool-defs.ts`); this module owns
 * the PR event types `pr:<operation>` (create/review/merge/close/comment/update —
 * `<category>:<action>` naming, plus the retired `pr:operation` as a transitional
 * alias). It provides the field-level safety normalization (strip tokens / raw CLI
 * output / absolute paths) registered against those types, the deterministic
 * consumer-side projection back to a {@link PrOperationEvent}, and the shared
 * server-side `create/success` constructor.
 *
 * The model uses its OWN tools to create / review / merge / close / comment on a
 * PR — or update it (modify + re-submit / re-open) — and then calls `publish_event`
 * with the matching `pr:<operation>` type to publish ONE generic event; a
 * automation may subscribe and trigger its follow-up action. A `pr:update/success`
 * event additionally lets the intent domain reset a rejected/failed/closed PR back
 * to `reviewing`. The server-side PR creation paths (dev-cleanup / automation /
 * manual create_pr) also publish a `pr:create` event after successfully creating a
 * PR on the model's behalf.
 */
import {
  PR_BASE_TARGETS,
  PR_OPERATIONS,
  PR_OPERATION_RESULTS,
  type GenericEvent,
  type JsonObject,
  type PrBaseTarget,
  type PrBranchRef,
  type PrEventAssociation,
  type PrOperation,
  type PrOperationEvent,
  type PrOperationResult,
  type PrRef,
  type PrRepo,
} from '@ccc/shared'
import type { EventNormalizer, NormalizeResult } from '../../kernel/events/generic-event.js'
import { redactSecrets } from '../../kernel/security/index.js'

/** Internal args shape the PR normalizer reconstructs from an untrusted generic core. */
type PublishPrEventArgs = {
  operation: PrOperation
  result: PrOperationResult
  pr?: PrRef
  repo?: PrRepo
  ref?: PrBranchRef
  association?: PrEventAssociation
  errorSummary?: string
}

// ---- Safety normalization (strip tokens / raw CLI output / absolute paths) ----

const REDACTED = '[redacted]'
const MAX_ERROR_SUMMARY_LEN = 500
const MAX_FIELD_LEN = 256

/** Absolute-path patterns stripped from the error summary (POSIX home + Windows). */
const ABS_PATH_PATTERNS: RegExp[] = [
  /(?:\/Users\/|\/home\/|\/root\/|\/var\/folders\/)\S+/g,
  /[A-Za-z]:\\[^\s]+/g,
]

/** Normalize a short structural field: redact secrets + cap length. */
function normalizeField(s: string | undefined): string | undefined {
  if (s === undefined) return undefined
  const redacted = redactSecrets(s).trim()
  return redacted.length > MAX_FIELD_LEN ? redacted.slice(0, MAX_FIELD_LEN) : redacted
}

/**
 * Normalize a failure summary so it never leaks sensitive data: redact tokens,
 * strip absolute paths, collapse whitespace (defuses pasted raw stdout/stderr),
 * and cap length. Returns `undefined` for empty input.
 */
export function normalizeErrorSummary(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined
  let out = redactSecrets(raw)
  for (const re of ABS_PATH_PATTERNS) out = out.replace(re, REDACTED)
  out = out.replace(/\s+/g, ' ').trim()
  if (!out) return undefined
  return out.length > MAX_ERROR_SUMMARY_LEN ? `${out.slice(0, MAX_ERROR_SUMMARY_LEN)}…` : out
}

/**
 * Build the safely-normalized {@link PrOperationEvent} from validated args. Every
 * string field is passed through the secret redactor; `errorSummary` additionally
 * has absolute paths stripped and whitespace collapsed. Nested objects are dropped
 * when they hold no surviving field, so the event payload stays compact.
 */
export function normalizePrEvent(args: PublishPrEventArgs): PrOperationEvent {
  const event: PrOperationEvent = {
    operation: args.operation,
    result: args.result,
  }

  if (args.pr) {
    const pr = {
      ...(args.pr.number !== undefined ? { number: args.pr.number } : {}),
      ...(normalizeField(args.pr.id) ? { id: normalizeField(args.pr.id)! } : {}),
      ...(normalizeField(args.pr.url) ? { url: normalizeField(args.pr.url)! } : {}),
      ...(normalizeField(args.pr.title) ? { title: normalizeField(args.pr.title)! } : {}),
      ...(normalizeField(args.pr.state) ? { state: normalizeField(args.pr.state)! } : {}),
    }
    if (Object.keys(pr).length) event.pr = pr
  }

  if (args.repo) {
    const repo = {
      ...(normalizeField(args.repo.provider)
        ? { provider: normalizeField(args.repo.provider)! }
        : {}),
      ...(normalizeField(args.repo.host) ? { host: normalizeField(args.repo.host)! } : {}),
      ...(normalizeField(args.repo.owner) ? { owner: normalizeField(args.repo.owner)! } : {}),
      ...(normalizeField(args.repo.name) ? { name: normalizeField(args.repo.name)! } : {}),
    }
    if (Object.keys(repo).length) event.repo = repo
  }

  if (args.ref) {
    const ref = {
      ...(normalizeField(args.ref.head) ? { head: normalizeField(args.ref.head)! } : {}),
      ...(normalizeField(args.ref.base) ? { base: normalizeField(args.ref.base)! } : {}),
      ...(normalizeField(args.ref.baseBranch)
        ? { baseBranch: normalizeField(args.ref.baseBranch)! }
        : {}),
      // An unknown `baseTarget` is DROPPED rather than passed through: a
      // subscriber branching on it must never see a value outside the union.
      ...(args.ref.baseTarget && PR_BASE_TARGETS.includes(args.ref.baseTarget)
        ? { baseTarget: args.ref.baseTarget }
        : {}),
    }
    if (Object.keys(ref).length) event.ref = ref
  }

  if (args.association) {
    const intentId = normalizeField(args.association.intentId)
    const intentTitle = normalizeField(args.association.intentTitle)
    const deliveryId = normalizeField(args.association.deliveryId)
    if (intentId || intentTitle || deliveryId) {
      event.association = {}
      if (intentId) event.association.intentId = intentId
      if (intentTitle) event.association.intentTitle = intentTitle
      if (deliveryId) event.association.deliveryId = deliveryId
    }
  }

  const errorSummary = normalizeErrorSummary(args.errorSummary)
  if (errorSummary) event.errorSummary = errorSummary

  return event
}

// ---- PR ⇄ generic-event mapping (the `pr:operation` registry entry) ----------
//
// The PR event is the first registered generic-event `type`. Its normalizer
// (`normalizePrGenericEvent`) is the SINGLE field-level normalization used by
// both the model publish path and the three server-side PR-create paths.
// `prArgsToGenericEvent` encodes server-side create args into the untrusted core;
// `projectPrOperationEvent` is the deterministic CONSUMER-side projection that
// recovers a {@link PrOperationEvent} from a NORMALIZED generic event so the
// Automation dispatch bridge + intent PR-status reset consumer can read the PR
// fields — it does NOT re-clean (normalization already happened) and is NOT a
// publish-path bridge: the bus carries the generic envelope, not a typed payload.

/**
 * The stable discriminants the PR normalizer registers against: one
 * `pr:<operation>` type per operation (`<category>:<action>` naming), PLUS the
 * retired `pr:operation` kept as a TRANSITIONAL ALIAS — an in-flight model
 * session briefed on the old contract still publishes, and the normalizer
 * rewrites its core to the `pr:<operation>` type. Remove the alias one release
 * after the rename ships.
 */
export const PR_EVENT_TYPES = PR_OPERATIONS.map((op) => `pr:${op}`)
export const PR_LEGACY_EVENT_TYPE = 'pr:operation'

/** The `pr:<operation>` type string for one operation. */
export function prEventType(operation: PrOperation): string {
  return `pr:${operation}`
}

const readStr = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
const readNum = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined)
const asObject = (v: unknown): Record<string, unknown> | undefined =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined

/** Read the known {@link PrRef} fields from an untrusted `data.pr`; `undefined` if empty. */
function readPr(v: unknown): PrRef | undefined {
  const o = asObject(v)
  if (!o) return undefined
  const pr: PrRef = {}
  if (readNum(o.number) !== undefined) pr.number = readNum(o.number)
  if (readStr(o.id) !== undefined) pr.id = readStr(o.id)
  if (readStr(o.url) !== undefined) pr.url = readStr(o.url)
  if (readStr(o.title) !== undefined) pr.title = readStr(o.title)
  if (readStr(o.state) !== undefined) pr.state = readStr(o.state)
  return Object.keys(pr).length ? pr : undefined
}

/** Read the known {@link PrRepo} fields from an untrusted `data.repo`; `undefined` if empty. */
function readRepo(v: unknown): PrRepo | undefined {
  const o = asObject(v)
  if (!o) return undefined
  const repo: PrRepo = {}
  if (readStr(o.provider) !== undefined) repo.provider = readStr(o.provider)
  if (readStr(o.host) !== undefined) repo.host = readStr(o.host)
  if (readStr(o.owner) !== undefined) repo.owner = readStr(o.owner)
  if (readStr(o.name) !== undefined) repo.name = readStr(o.name)
  return Object.keys(repo).length ? repo : undefined
}

/** Read the known {@link PrBranchRef} fields from an untrusted `data.ref`; `undefined` if empty. */
function readRef(v: unknown): PrBranchRef | undefined {
  const o = asObject(v)
  if (!o) return undefined
  const ref: PrBranchRef = {}
  if (readStr(o.head) !== undefined) ref.head = readStr(o.head)
  if (readStr(o.base) !== undefined) ref.base = readStr(o.base)
  if (readStr(o.baseBranch) !== undefined) ref.baseBranch = readStr(o.baseBranch)
  const target = readStr(o.baseTarget)
  if (target !== undefined && (PR_BASE_TARGETS as readonly string[]).includes(target)) {
    ref.baseTarget = target as PrBaseTarget
  }
  return Object.keys(ref).length ? ref : undefined
}

/** Read the known {@link PrEventAssociation} fields from an untrusted `data.association`. */
function readAssociation(v: unknown): PrEventAssociation | undefined {
  const o = asObject(v)
  if (!o) return undefined
  const assoc: PrEventAssociation = {}
  if (readStr(o.intentId) !== undefined) assoc.intentId = readStr(o.intentId)
  if (readStr(o.intentTitle) !== undefined) assoc.intentTitle = readStr(o.intentTitle)
  if (readStr(o.deliveryId) !== undefined) assoc.deliveryId = readStr(o.deliveryId)
  return Object.keys(assoc).length ? assoc : undefined
}

/** Drop `undefined`-valued keys so the resulting object is a valid JSON object. */
function compact(o: object): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(o)) if (v !== undefined) out[k] = v
  return out
}

/**
 * Encode PR tool args into an (un-normalized) {@link GenericEvent} core:
 * `status = result`, `metadata.operation = operation`, `description = errorSummary`,
 * `data` carries `pr` / `repo` / `ref` / `association`. Empty structural objects
 * are omitted so the core stays a valid JSON object (no `undefined` values).
 */
export function prArgsToGenericEvent(args: PublishPrEventArgs): GenericEvent {
  const data: Record<string, unknown> = {}
  if (args.pr) {
    const pr = compact(args.pr)
    if (Object.keys(pr).length) data.pr = pr
  }
  if (args.repo) {
    const repo = compact(args.repo)
    if (Object.keys(repo).length) data.repo = repo
  }
  if (args.ref) {
    const ref = compact(args.ref)
    if (Object.keys(ref).length) data.ref = ref
  }
  if (args.association) {
    const assoc = compact(args.association)
    if (Object.keys(assoc).length) data.association = assoc
  }
  const core: GenericEvent = {
    type: prEventType(args.operation),
    status: args.result,
    // The operation also stays in metadata (redundant with the type's action
    // segment) so existing metadata-condition filters keep matching.
    metadata: { operation: args.operation },
  }
  if (args.errorSummary !== undefined) core.description = args.errorSummary
  if (Object.keys(data).length) core.data = data as JsonObject
  return core
}

/**
 * Encode a normalized {@link PrOperationEvent} back into a normalized generic event.
 * `originalType` is the type the normalizer was registered under (either
 * `pr:<operation>` for new-format cores, or `pr:operation` for the legacy alias):
 * the output keeps this type so the kernel registry's type-change guard passes.
 */
function prOperationToGenericEvent(event: PrOperationEvent, originalType: string): GenericEvent {
  const data: Record<string, unknown> = {}
  if (event.pr) data.pr = { ...event.pr }
  if (event.repo) data.repo = { ...event.repo }
  if (event.ref) data.ref = { ...event.ref }
  if (event.association) data.association = { ...event.association }
  const core: GenericEvent = {
    type: originalType,
    status: event.result,
    metadata: {
      // The operation stays in metadata for legacy `pr:operation` format (where
      // consumers read it from there) and for backward-compatible metadata filters.
      operation: event.operation,
    },
  }
  if (event.errorSummary !== undefined) core.description = event.errorSummary
  if (Object.keys(data).length) core.data = data as JsonObject
  return core
}

/**
 * The registered normalizer for the PR event types. The operation comes from the
 * type's action segment (`pr:<operation>`); a legacy `pr:operation` core reads it
 * from `metadata.operation` instead and is REWRITTEN to the `pr:<operation>` type
 * on the way out (the alias conversion). Validates the operation + result enums
 * (throws on an unknown value so the generic layer rejects the publish),
 * reconstructs the tool args from the untrusted core (ignoring any unknown `data`
 * keys), runs the field-level {@link normalizePrEvent} redaction, and re-encodes
 * the clean event as a generic event.
 */
export const normalizePrGenericEvent: EventNormalizer = (core) => {
  const operation =
    core.type === PR_LEGACY_EVENT_TYPE ? core.metadata?.operation : core.type.slice('pr:'.length)
  const result = core.status
  if (operation === undefined || !PR_OPERATIONS.includes(operation as PrOperation)) {
    throw new Error('unknown pr operation')
  }
  if (
    core.metadata?.operation !== undefined &&
    core.metadata.operation !== operation &&
    core.type !== PR_LEGACY_EVENT_TYPE
  ) {
    // A `pr:<op>` core whose metadata.operation contradicts the type is ambiguous
    // — reject rather than guessing which segment the model meant.
    throw new Error('pr operation mismatch between type and metadata')
  }
  if (result === undefined || !PR_OPERATION_RESULTS.includes(result as PrOperationResult)) {
    throw new Error('unknown pr result')
  }
  const data = core.data ?? {}
  const args: PublishPrEventArgs = {
    operation: operation as PrOperation,
    result: result as PrOperationResult,
    pr: readPr(data.pr),
    repo: readRepo(data.repo),
    ref: readRef(data.ref),
    association: readAssociation(data.association),
    errorSummary: core.description,
  }
  return prOperationToGenericEvent(normalizePrEvent(args), core.type)
}

/**
 * Deterministic CONSUMER-side projection: recover a {@link PrOperationEvent} from a
 * NORMALIZED generic PR event (`event.type === 'pr:operation'`). Used by the
 * Automation dispatch bridge and the intent PR-status reset consumer to read the
 * PR fields off the generic envelope. It does NOT re-clean — normalization already
 * happened — and preserves the empty-drop + optional-field semantics. Returns
 * `null` when the projected operation / result are not valid enum members (a
 * defensive guard; a normalized PR event always satisfies them).
 */
export function projectPrOperationEvent(event: GenericEvent): PrOperationEvent | null {
  const operation = event.metadata?.operation
  const result = event.status
  if (operation === undefined || !PR_OPERATIONS.includes(operation as PrOperation)) return null
  if (result === undefined || !PR_OPERATION_RESULTS.includes(result as PrOperationResult)) {
    return null
  }
  const data = event.data ?? {}
  const out: PrOperationEvent = {
    operation: operation as PrOperation,
    result: result as PrOperationResult,
  }
  const pr = readPr(data.pr)
  if (pr) out.pr = pr
  const repo = readRepo(data.repo)
  if (repo) out.repo = repo
  const ref = readRef(data.ref)
  if (ref) out.ref = ref
  const assoc = readAssociation(data.association)
  if (assoc) out.association = assoc
  if (event.description !== undefined) out.errorSummary = event.description
  return out
}

// ---- Server-side PR create event builder (shared by dev-cleanup / automation / create_pr) ----

/** Inputs for building a server-side `pr:operation create` event. */
export interface ServerSidePrCreateInput {
  prId: string
  prUrl: string | null
  headBranch: string | undefined
  baseBranch: string | undefined
  intentId: string
  /**
   * Delivery this PR belongs to; `null`/omitted for a mainline PR. Carried on the
   * event's association so a subscriber sees the same `(intent, delivery)` key
   * the ledger row was written under.
   */
  deliveryId?: string | null
}

/**
 * Publish a `pr:operation create/success` event for the server-side PR creation
 * paths (dev-cleanup, automation, manual create_pr). The three call-sites share
 * this single entry so their mapping never drifts, and — like the model path —
 * they route through the SAME generic pipeline: `normalize` runs the registered
 * PR normalizer (a missing registration is a publish failure, NOT a bypass), and
 * `publish` receives the NORMALIZED {@link GenericEvent} to wrap with the bus
 * envelope. Returns the {@link NormalizeResult} for optional logging.
 */
export function runServerSidePrCreate(
  input: ServerSidePrCreateInput,
  normalize: (core: GenericEvent) => NormalizeResult,
  publish: (event: GenericEvent) => void,
): NormalizeResult {
  const args: PublishPrEventArgs = {
    operation: 'create',
    result: 'success',
    pr: { url: input.prUrl ?? undefined },
    ref: {
      head: input.headBranch,
      base: input.baseBranch,
      baseBranch: input.baseBranch,
      // The delivery binding IS the answer: a PR carrying an intent toward a
      // delivery targets that delivery's branch; without one it targets mainline.
      baseTarget: input.deliveryId ? 'delivery-branch' : 'mainline',
    },
    association: { intentId: input.intentId, deliveryId: input.deliveryId ?? undefined },
  }
  const res = normalize(prArgsToGenericEvent(args))
  if (res.ok) publish(res.event)
  return res
}
