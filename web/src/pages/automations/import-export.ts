/**
 * Automation JSON import/export — pure, side-effect-free codec.
 *
 * Export copies whole `Automation` objects (NO hand-written field whitelist, so a
 * future protocol config field is never silently dropped) into a versioned
 * envelope. Import parses + validates the envelope, then maps each candidate to a
 * `CreateAutomationInput` fault-tolerantly: bad / unknown / missing fields fall
 * back to the same defaults the new-automation form and server apply, instance-only
 * fields (`id` / `workspaceId` / `status` / timestamps / `nextRunAt`) are ignored,
 * and the item is always created `paused` in the current workspace with a fresh id.
 *
 * DOM concerns (file download, file read) live in the dialog components; this
 * module stays unit-testable without a browser.
 */
import type {
  AgentConfig,
  Automation,
  AutomationType,
  CreateAutomationInput,
  IntentLifecycleFilter,
  IntentLifecyclePhase,
  ModeToken,
  CodexPolicy,
  PrOperation,
  PrOperationFilter,
  PrOperationResult,
  RunEndReason,
  ScheduleEventTopic,
  ScheduleTriggerType,
  SessionKind,
  VendorId,
} from '@ccc/shared/protocol'
import {
  INTENT_LIFECYCLE_PHASES,
  PR_OPERATIONS,
  PR_OPERATION_RESULTS,
  SESSION_KINDS,
  isValidAutomationMaxWallClockMs,
  normalizeAutomationMetadata,
  normalizeEventMetadataFilter,
} from '@ccc/shared/protocol'

/** Current export file contract. `version` is validated with a strict `=== 1`. */
export const AUTOMATION_EXPORT_VERSION = 1

/** Base defaults applied when a field is missing / malformed (mirrors the form). */
const DEFAULT_CRON = '*/30 * * * *'
const DEFAULT_MODE: ModeToken = 'read-only'

// Closed value sets used for tolerant field mapping. Kept local (the protocol
// exposes the unions but not runtime arrays for these); SESSION_KINDS and the PR /
// intent enums ARE exported and reused directly.
const AUTOMATION_TYPES: readonly AutomationType[] = ['command', 'llm']
const VENDOR_IDS: readonly VendorId[] = ['claude', 'codex']
const TRIGGER_TYPES: readonly ScheduleTriggerType[] = ['cron', 'event']
const EVENT_TOPICS: readonly ScheduleEventTopic[] = [
  'run:started',
  'run:settled',
  'pr:operation',
  'intent:lifecycle',
]
const RUN_END_REASONS: readonly RunEndReason[] = ['complete', 'error', 'aborted']

/** The versioned export envelope written to / read from disk. */
export interface AutomationExportFile {
  version: typeof AUTOMATION_EXPORT_VERSION
  /** ISO 8601 timestamp of when the export was produced. */
  exportedAt: string
  /** Full `Automation` objects (instance state included for fidelity, ignored on import). */
  automations: Automation[]
}

/** i18n key suffix for a file-level import rejection (under `automation.importExport.error.*`). */
export type ImportErrorKey = 'badJson' | 'badVersion' | 'badStructure'

/** Result of parsing + envelope-validating an import file. */
export type ImportParseResult =
  | { ok: true; automations: Record<string, unknown>[] }
  | { ok: false; errorKey: ImportErrorKey }

/** One mapped import candidate: importable with its create input, or blocked with a reason. */
export type ImportCandidate =
  | { importable: true; name: string; input: CreateAutomationInput }
  | { importable: false; name: string; reasonKey: 'noAgent' }

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function pickEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback
}

function pickStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((x): x is string => typeof x === 'string') : []
}

/** Mode is either a plain vendor token (string) or a CodexPolicy object (`sandboxMode`). */
function pickMode(value: unknown): ModeToken | CodexPolicy {
  if (typeof value === 'string' && value.trim()) return value
  if (isPlainObject(value) && 'sandboxMode' in value) return value as unknown as CodexPolicy
  return DEFAULT_MODE
}

/** Enumerated-array filter: keep only members of `allowed`; `null` when none survive. */
function pickEnumArray<T extends string>(value: unknown, allowed: readonly T[]): T[] | null {
  if (!Array.isArray(value)) return null
  const set = new Set(allowed as readonly string[])
  const out = value.filter((x): x is T => typeof x === 'string' && set.has(x))
  return out.length ? out : null
}

function pickPrFilter(value: unknown): PrOperationFilter | null {
  if (!isPlainObject(value)) return null
  const operations = pickEnumArray<PrOperation>(value.operations, PR_OPERATIONS)
  const results = pickEnumArray<PrOperationResult>(value.results, PR_OPERATION_RESULTS)
  if (!operations && !results) return null
  const out: PrOperationFilter = {}
  if (operations) out.operations = operations
  if (results) out.results = results
  return out
}

function pickIntentFilter(value: unknown): IntentLifecycleFilter | null {
  if (!isPlainObject(value)) return null
  const phases = pickEnumArray<IntentLifecyclePhase>(value.phases, INTENT_LIFECYCLE_PHASES)
  return phases ? { phases } : null
}

/** Read a string `config.name` (the exported display title), else `undefined`. */
function readConfigName(config: unknown): string | undefined {
  if (isPlainObject(config) && typeof config.name === 'string') return config.name
  return undefined
}

/** A short, best-effort label for the candidate list (name → body snippet → type). */
function candidateLabel(config: unknown, type: AutomationType, fallbackName: string): string {
  const name = readConfigName(config)?.trim()
  if (name) return name
  const key = type === 'command' ? 'command' : 'prompt'
  if (isPlainObject(config) && typeof config[key] === 'string') {
    const snippet = (config[key] as string).replace(/\s+/g, ' ').trim().slice(0, 60)
    if (snippet) return snippet
  }
  return fallbackName
}

/**
 * Resolve the LLM execution agent for an imported item. Keeps a still-valid
 * exported `agentId` (exists, enabled, same vendor); otherwise falls back to the
 * current settings' default enabled agent of that vendor. Returns `null` when no
 * compatible agent exists (the item is then non-importable).
 */
function resolveLlmAgentId(
  rawAgentId: unknown,
  vendor: VendorId,
  agents: readonly AgentConfig[],
): string | null {
  const isEnabledVendorAgent = (id: string): boolean =>
    agents.some((a) => a.id === id && a.vendor === vendor && a.enabled !== false)
  if (typeof rawAgentId === 'string' && isEnabledVendorAgent(rawAgentId)) return rawAgentId
  const fallback = agents.find((a) => a.vendor === vendor && a.enabled !== false)
  return fallback ? fallback.id : null
}

/**
 * Build the export envelope from the loaded automations, keeping only the selected
 * ids. Whole objects are deep-copied — no field whitelist — so any config field is
 * preserved verbatim.
 */
export function buildExportFile(
  automations: readonly Automation[],
  selectedIds: ReadonlySet<string> | readonly string[],
  exportedAt: string,
): AutomationExportFile {
  const set = selectedIds instanceof Set ? selectedIds : new Set(selectedIds)
  const chosen = automations.filter((a) => set.has(a.id))
  return {
    version: AUTOMATION_EXPORT_VERSION,
    exportedAt,
    // Deep clone via JSON round-trip: Automation is JSON-serializable and this
    // decouples the file from the live reactive objects.
    automations: chosen.map((a) => JSON.parse(JSON.stringify(a)) as Automation),
  }
}

/** Serialize an export envelope to a pretty-printed JSON string. */
export function serializeExportFile(file: AutomationExportFile): string {
  return JSON.stringify(file, null, 2)
}

/** Sanitize a workspace path's last segment for use inside a filename. */
function workspaceSlug(workspacePath: string): string {
  const last = workspacePath.split(/[\\/]/).filter(Boolean).pop() ?? ''
  const cleaned = last.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
  return cleaned || 'workspace'
}

/** Compact UTC stamp `YYYYMMDDTHHMMSSZ` for a deterministic, sortable filename. */
function utcStamp(date: Date): string {
  const p = (n: number, w = 2): string => String(n).padStart(w, '0')
  return (
    `${date.getUTCFullYear()}${p(date.getUTCMonth() + 1)}${p(date.getUTCDate())}` +
    `T${p(date.getUTCHours())}${p(date.getUTCMinutes())}${p(date.getUTCSeconds())}Z`
  )
}

/** Recognizable download filename, e.g. `c3-automations-<workspace>-20260712T052745Z.json`. */
export function exportFilename(workspacePath: string, date: Date): string {
  return `c3-automations-${workspaceSlug(workspacePath)}-${utcStamp(date)}.json`
}

/**
 * Parse + envelope-validate an import file's text. Fails (no candidates) on invalid
 * JSON, a non-object root, `version !== 1`, a non-array `automations`, or any
 * non-object member. A valid empty `automations` array succeeds with `[]`.
 */
export function parseImportFile(text: string): ImportParseResult {
  let root: unknown
  try {
    root = JSON.parse(text)
  } catch {
    return { ok: false, errorKey: 'badJson' }
  }
  if (!isPlainObject(root)) return { ok: false, errorKey: 'badStructure' }
  if (root.version !== AUTOMATION_EXPORT_VERSION) return { ok: false, errorKey: 'badVersion' }
  if (!Array.isArray(root.automations)) return { ok: false, errorKey: 'badStructure' }
  for (const member of root.automations) {
    if (!isPlainObject(member)) return { ok: false, errorKey: 'badStructure' }
  }
  return { ok: true, automations: root.automations as Record<string, unknown>[] }
}

/**
 * Map one validated file member to an import candidate. Every field is mapped
 * independently with a default fallback; the trigger fields are normalized against
 * the final `triggerType` / `eventTopic` (cron clears event fields, event clears
 * cron, a run-lifecycle trigger with no valid sessionKind filter falls back to
 * `['work']`). An `event` trigger whose topic is missing / unknown demotes to the
 * cron default rather than producing a server-rejected request. The item is always
 * `paused`, owned by `workspaceId`, with `id` / `workspaceId` / `status` /
 * timestamps / `nextRunAt` ignored.
 */
export function mapToCreateInput(
  raw: Record<string, unknown>,
  opts: { workspaceId: string; agents: readonly AgentConfig[] },
): ImportCandidate {
  const type = pickEnum<AutomationType>(raw.type, AUTOMATION_TYPES, 'command')
  const vendor = pickEnum<VendorId>(raw.vendor, VENDOR_IDS, 'claude')
  const config = isPlainObject(raw.config)
    ? (raw.config as Record<string, unknown>)
    : type === 'command'
      ? { command: '' }
      : { prompt: '' }
  const initialName = readConfigName(config)?.trim()
  const label = candidateLabel(config, type, type === 'command' ? 'Command task' : 'LLM task')

  // Trigger resolution: an event trigger needs a valid topic, else it demotes to cron.
  const rawTrigger = pickEnum<ScheduleTriggerType>(raw.triggerType, TRIGGER_TYPES, 'cron')
  const eventTopic: ScheduleEventTopic | null =
    typeof raw.eventTopic === 'string' &&
    (EVENT_TOPICS as readonly string[]).includes(raw.eventTopic)
      ? (raw.eventTopic as ScheduleEventTopic)
      : null
  const isEvent = rawTrigger === 'event' && eventTopic !== null

  const input: CreateAutomationInput = {
    type,
    config,
    vendor,
    mode: pickMode(raw.mode),
    maxWallClockMs: isValidAutomationMaxWallClockMs(raw.maxWallClockMs) ? raw.maxWallClockMs : null,
    workspaceId: opts.workspaceId,
    agentId: null,
    triggerType: isEvent ? 'event' : 'cron',
    cronExpression: isEvent
      ? ''
      : typeof raw.cronExpression === 'string' && raw.cronExpression.trim()
        ? raw.cronExpression
        : DEFAULT_CRON,
    eventTopic: null,
    eventReasonFilter: null,
    eventPrFilter: null,
    eventIntentFilter: null,
    eventSessionKindFilter: null,
    eventMetadataFilter: null,
    metadata: normalizeAutomationMetadata(raw.metadata),
    toolAllowlist: pickStringArray(raw.toolAllowlist),
    toolDenylist: pickStringArray(raw.toolDenylist),
    initialStatus: 'paused',
  }
  if (initialName) input.initialName = initialName

  if (isEvent && eventTopic) {
    input.eventTopic = eventTopic
    if (eventTopic === 'run:started' || eventTopic === 'run:settled') {
      input.eventReasonFilter = pickEnumArray<RunEndReason>(raw.eventReasonFilter, RUN_END_REASONS)
      const skf = pickEnumArray<SessionKind>(raw.eventSessionKindFilter, SESSION_KINDS)
      input.eventSessionKindFilter = skf && skf.length ? skf : ['work']
      input.eventMetadataFilter = normalizeEventMetadataFilter(raw.eventMetadataFilter)
    } else if (eventTopic === 'pr:operation') {
      input.eventPrFilter = pickPrFilter(raw.eventPrFilter)
    } else if (eventTopic === 'intent:lifecycle') {
      input.eventIntentFilter = pickIntentFilter(raw.eventIntentFilter)
    }
  }

  if (type === 'llm') {
    const agentId = resolveLlmAgentId(raw.agentId, vendor, opts.agents)
    if (!agentId) return { importable: false, name: label, reasonKey: 'noAgent' }
    input.agentId = agentId
  }

  return { importable: true, name: label, input }
}

/** Map every validated file member to a candidate, preserving order. */
export function mapImportCandidates(
  members: readonly Record<string, unknown>[],
  opts: { workspaceId: string; agents: readonly AgentConfig[] },
): ImportCandidate[] {
  return members.map((m) => mapToCreateInput(m, opts))
}
