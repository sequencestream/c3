/**
 * Generic event-filter matching (kernel).
 *
 * The server-side decision rules behind "does this event trigger this
 * automation": the `<category>:*` type wildcard, the metadata condition check,
 * and the per-filter / OR-over-filters matcher. Matching reads only the trusted
 * minimal view a `GenericEventEnvelope` already provides (`workspacePath` +
 * `event`) — a new event type never requires a new protocol field or dispatch
 * branch. See `doc/architecture/event-mechanism.md`.
 *
 * The automation store (candidate narrowing) and the trigger evaluator (final
 * verdict) both read this module, so the two can never diverge on what a filter
 * `type` accepts. Filter shapes and their normalization stay in `@ccc/shared`;
 * only the decision lives here.
 */
import type {
  EventMetadataFilter,
  EventMetadataFilterCondition,
  GenericEventFilter,
} from '@ccc/shared/protocol'
import type { GenericEvent } from '@ccc/shared'
import { EVENT_ACTION_WILDCARD } from '@ccc/shared/protocol'

/**
 * Does a filter `type` accept an event `type`? Exact match, or the filter is a
 * `<category>:*` category wildcard whose category equals the event's. Only the
 * action segment may be wildcarded — no `*:action`, prefix or regex forms.
 */
export function eventTypeMatches(filterType: string, eventType: string): boolean {
  if (filterType === eventType) return true
  if (!filterType.endsWith(`:${EVENT_ACTION_WILDCARD}`)) return false
  const category = filterType.slice(0, -2)
  return category.length > 0 && eventType.startsWith(`${category}:`)
}

/**
 * Whether an event's metadata satisfies a metadata filter. A `null`/empty filter
 * matches any metadata. `AND` requires every condition to match exactly; `OR`
 * requires at least one. Comparison is exact string equality.
 */
export function metadataFilterMatches(
  filter: EventMetadataFilter | null | undefined,
  metadata: Record<string, string>,
): boolean {
  if (!filter || !filter.conditions.length) return true
  const hit = (c: EventMetadataFilterCondition): boolean => metadata[c.key] === c.value
  return filter.combinator === 'OR' ? filter.conditions.some(hit) : filter.conditions.every(hit)
}

/** One dimension's pass/fail in a generic event-filter match breakdown. */
export interface GenericEventFilterBreakdownItem {
  name: 'workspace' | 'type' | 'status' | 'metadata'
  passed: boolean
}

/** The full result of a generic event-filter match: verdict + per-dimension breakdown. */
export interface GenericEventFilterMatchResult {
  matched: boolean
  breakdown: GenericEventFilterBreakdownItem[]
}

/** The trusted minimal view a matcher reads — directly satisfied by a `GenericEventEnvelope`. */
export interface GenericEventView {
  workspacePath: string
  event: GenericEvent
}

/**
 * Pure matcher: does `view` (an event on some workspace) satisfy `filter` for an
 * automation whose resolved workspace root is `automationWorkspacePath`? Checks,
 * in fixed order, workspace equality, `type` (exact, or the filter's
 * `<category>:*` wildcard via {@link eventTypeMatches}), `status` (absent/empty
 * `statuses` = any; else exact case-sensitive membership; an event with no
 * `status` fails a non-empty `statuses` filter), then `metadata` (exact
 * case-sensitive key/value match via {@link metadataFilterMatches}; absent/empty
 * = no filter). A `null` filter never matches (fails closed) — `type` fails and
 * `status`/`metadata` degrade to "no filter" so the breakdown stays meaningful.
 */
export function genericEventFilterMatches(
  automationWorkspacePath: string,
  filter: GenericEventFilter | null,
  view: GenericEventView,
): GenericEventFilterMatchResult {
  const breakdown: GenericEventFilterBreakdownItem[] = [
    { name: 'workspace', passed: automationWorkspacePath === view.workspacePath },
    { name: 'type', passed: !!filter && eventTypeMatches(filter.type, view.event.type) },
    {
      name: 'status',
      passed:
        !filter?.statuses?.length ||
        (view.event.status !== undefined && filter.statuses.includes(view.event.status)),
    },
    {
      name: 'metadata',
      passed: metadataFilterMatches(filter?.metadata ?? null, view.event.metadata ?? {}),
    },
  ]
  return { matched: breakdown.every((b) => b.passed), breakdown }
}

/**
 * OR wrapper over an automation's subscription rows: matched when ANY filter of
 * the list matches. The returned breakdown is the first matching filter's (on
 * success) or the last evaluated one's (on failure) so callers keep a meaningful
 * per-dimension trace; an empty/`null` list fails closed like a `null` filter.
 */
export function genericEventFiltersMatch(
  automationWorkspacePath: string,
  filters: readonly GenericEventFilter[] | null | undefined,
  view: GenericEventView,
): GenericEventFilterMatchResult {
  if (!filters?.length) {
    return genericEventFilterMatches(automationWorkspacePath, null, view)
  }
  let last: GenericEventFilterMatchResult | null = null
  for (const filter of filters) {
    last = genericEventFilterMatches(automationWorkspacePath, filter, view)
    if (last.matched) return last
  }
  return last as GenericEventFilterMatchResult
}
