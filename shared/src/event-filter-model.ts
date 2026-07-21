/**
 * Event-trigger filter rules shared by the server save boundary / schema backfill
 * and the web console (cascade form + automation import): untrusted-payload
 * normalization, the run-lifecycle subscription predicate, and the v12 → typed
 * filter upgrade. Filter types and their bounds stay in the wire contract; the
 * matching decision itself is a server-side rule and lives there.
 */
import type {
  EventMetadataFilter,
  EventMetadataFilterCondition,
  GenericEventFilter,
} from './protocol.js'
import {
  MAX_AUTOMATION_METADATA_ENTRIES,
  MAX_AUTOMATION_METADATA_KEY_LEN,
  MAX_AUTOMATION_METADATA_VALUE_LEN,
  MAX_EVENT_FILTERS,
  MAX_EVENT_FILTER_STATUSES,
  MAX_EVENT_FILTER_STATUS_LEN,
  MAX_EVENT_FILTER_TYPE_LEN,
} from './protocol.js'

/**
 * Normalize an untrusted metadata-filter payload to a clean {@link EventMetadataFilter}
 * or `null` (= no filter). Drops malformed / empty / over-long conditions and caps
 * their count; an unknown combinator defaults to `AND`. Returns `null` when no
 * valid condition survives so an empty filter never gates matching.
 */
export function normalizeEventMetadataFilter(input: unknown): EventMetadataFilter | null {
  if (!input || typeof input !== 'object') return null
  const obj = input as { conditions?: unknown; combinator?: unknown }
  const combinator: 'AND' | 'OR' = obj.combinator === 'OR' ? 'OR' : 'AND'
  const rawConditions = Array.isArray(obj.conditions) ? obj.conditions : []
  const conditions: EventMetadataFilterCondition[] = []
  for (const raw of rawConditions) {
    if (conditions.length >= MAX_AUTOMATION_METADATA_ENTRIES) break
    if (!raw || typeof raw !== 'object') continue
    const rec = raw as { key?: unknown; value?: unknown }
    const key = typeof rec.key === 'string' ? rec.key.trim() : ''
    const value = typeof rec.value === 'string' ? rec.value.trim() : ''
    if (!key || key.length > MAX_AUTOMATION_METADATA_KEY_LEN) continue
    if (!value || value.length > MAX_AUTOMATION_METADATA_VALUE_LEN) continue
    conditions.push({ key, value })
  }
  return conditions.length ? { conditions, combinator } : null
}

/** True when a filter `type` subscribes run-lifecycle events (sessionKind boundary applies). */
export function isRunLifecycleEventType(type: string | null | undefined): boolean {
  return type === 'run:started' || type === 'run:settled' || type === 'run:*'
}

/** True when any filter of the list subscribes run-lifecycle events. */
export function hasRunLifecycleEventFilter(
  filters: readonly GenericEventFilter[] | null | undefined,
): boolean {
  return !!filters?.some((f) => isRunLifecycleEventType(f.type))
}

/**
 * Normalize an untrusted event-filter payload to a clean {@link GenericEventFilter}
 * or `null`. `null` means "no valid filter" — a trigger without a valid `type`
 * MUST NOT be saved as "matches every type"; the caller (server save boundary)
 * rejects the create/update instead of silently widening the trigger. `statuses`
 * is trimmed, deduplicated, capped in count/length, and dropped entirely (→
 * `undefined`, meaning "any status") when nothing valid survives.
 */
export function normalizeGenericEventFilter(input: unknown): GenericEventFilter | null {
  if (!input || typeof input !== 'object') return null
  const obj = input as { type?: unknown; statuses?: unknown; metadata?: unknown }
  const type = typeof obj.type === 'string' ? obj.type.trim() : ''
  if (!type || type.length > MAX_EVENT_FILTER_TYPE_LEN) return null

  const statuses: string[] = []
  const seen = new Set<string>()
  if (Array.isArray(obj.statuses)) {
    for (const raw of obj.statuses) {
      if (statuses.length >= MAX_EVENT_FILTER_STATUSES) break
      const status = typeof raw === 'string' ? raw.trim() : ''
      if (!status || status.length > MAX_EVENT_FILTER_STATUS_LEN || seen.has(status)) continue
      seen.add(status)
      statuses.push(status)
    }
  }

  const filter: GenericEventFilter = { type }
  if (statuses.length) filter.statuses = statuses
  const metadata = normalizeEventMetadataFilter(obj.metadata)
  if (metadata) filter.metadata = metadata
  return filter
}

/**
 * Normalize an untrusted list of event filters to a clean non-empty array or
 * `null`. Each entry runs through {@link normalizeGenericEventFilter}; invalid
 * entries are dropped, the list is capped at {@link MAX_EVENT_FILTERS}. `null`
 * means "no valid subscription" — the save boundary rejects the event trigger
 * rather than storing an empty (match-nothing or match-everything) list.
 */
export function normalizeGenericEventFilters(input: unknown): GenericEventFilter[] | null {
  if (!Array.isArray(input)) return null
  const filters: GenericEventFilter[] = []
  for (const raw of input) {
    if (filters.length >= MAX_EVENT_FILTERS) break
    const filter = normalizeGenericEventFilter(raw)
    if (filter) filters.push(filter)
  }
  return filters.length ? filters : null
}

/**
 * Upgrade one pre-rename single filter (the v12 shape, where the action lived in
 * `status`/`metadata` for pr/intent) to the equivalent subscription rows under
 * `<category>:<action>` types, preserving its exact hit set. Shared by the server
 * store's schema backfill and the client-side automation import (old export files
 * carry the single-filter shape):
 *
 * - `run:*` types and unknown custom types pass through as a one-row list;
 * - `pr:operation`: an `OR` metadata filter of pure `operation` conditions (the
 *   shape the old UI and migrations produced) becomes one `pr:<op>` row per
 *   operation; any other metadata shape falls back to one `pr:*` row carrying
 *   statuses + metadata verbatim — semantics-preserving, because the renamed PR
 *   events still carry `metadata.operation`;
 * - `intent:lifecycle`: each `statuses` phase becomes its own `intent:<phase>`
 *   row (the phase moved from status into the type); no statuses = any phase =
 *   one `intent:*` row. Metadata carries over.
 */
export function upgradeV12EventFilter(filter: GenericEventFilter): GenericEventFilter[] {
  if (filter.type === 'pr:operation') {
    const conditions = filter.metadata?.conditions ?? []
    const pureOperationOr =
      conditions.length > 0 &&
      filter.metadata?.combinator === 'OR' &&
      conditions.every((c) => c.key === 'operation')
    if (pureOperationOr) {
      return conditions.map((c) => ({
        type: `pr:${c.value}`,
        ...(filter.statuses?.length ? { statuses: filter.statuses } : {}),
      }))
    }
    const row: GenericEventFilter = { type: 'pr:*' }
    if (filter.statuses?.length) row.statuses = filter.statuses
    if (filter.metadata) row.metadata = filter.metadata
    return [row]
  }
  if (filter.type === 'intent:lifecycle') {
    const phases = filter.statuses ?? []
    const base = (type: string): GenericEventFilter => ({
      type,
      ...(filter.metadata ? { metadata: filter.metadata } : {}),
    })
    return phases.length ? phases.map((p) => base(`intent:${p}`)) : [base('intent:*')]
  }
  return [filter]
}
