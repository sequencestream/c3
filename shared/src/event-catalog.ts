/**
 * Event catalog (`<category>:<action>` naming).
 *
 * Event types follow `<category>:<action>` — the category groups a domain, the
 * action names the fact that happened; `status` carries that fact's outcome and
 * `metadata` the remaining flat context. The catalog below is the single code
 * source for KNOWN categories/actions/statuses. It is a SUGGESTION registry for
 * the cascade form and docs, NOT a closed enum — the wire contract stays an open
 * string, so an unlisted `custom:thing` type publishes and subscribes fine. A
 * filter `type` of `<category>:*` subscribes every action of that category.
 * Definition catalog + naming spec live in `doc/architecture/event-mechanism.md`.
 *
 * It is derived from the wire contract's value lists rather than restated, so a
 * new PR operation / intent phase can never drift from the catalog.
 */
import { RUN_END_REASONS } from './protocol.js'
import { INTENT_LIFECYCLE_PHASES, PR_OPERATIONS, PR_OPERATION_RESULTS } from './event-model.js'

/** One catalog action: its known status suggestions (empty = no status dimension). */
export interface EventCatalogAction {
  statuses: readonly string[]
}

/** One catalog category: its known actions. */
export interface EventCatalogCategory {
  actions: Readonly<Record<string, EventCatalogAction>>
}

/** Known event categories/actions/statuses — suggestions only (see note above). */
export const EVENT_CATALOG: Readonly<Record<string, EventCatalogCategory>> = {
  run: {
    actions: {
      started: { statuses: [] },
      settled: { statuses: RUN_END_REASONS },
    },
  },
  pr: {
    actions: Object.fromEntries(
      PR_OPERATIONS.map((op) => [op, { statuses: PR_OPERATION_RESULTS }]),
    ),
  },
  intent: {
    actions: Object.assign(
      Object.fromEntries(INTENT_LIFECYCLE_PHASES.map((p) => [p, { statuses: [] }])),
      { spec_approve: { statuses: [] as const } },
    ),
  },
}
