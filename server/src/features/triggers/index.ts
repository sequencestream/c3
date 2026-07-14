/**
 * Event trigger — dispatches event-triggered automations in response to any
 * generic event: a run lifecycle event (2026-06-08), a model-published PR
 * operation event (2026-06-20), an intent lifecycle event, or a future event
 * type that no code here mentions by name.
 *
 * Wired to the kernel event bus in the composition root: an event arrives already
 * projected onto the trusted minimal {@link TriggerEventView}, and every active
 * event-trigger automation that matches is executed via the SAME path as a cron
 * run (the shared execution engine's `dispatchAndTrack`), reusing the three-tier
 * MCP security model and the write-approval queue.
 *
 * The per-automation match decision is a single generic filter (type + statuses +
 * metadata) evaluated by the pure {@link evaluateAutomationTriggerMatch}, which
 * layers the run-lifecycle `eventSessionKindFilter` SECURITY boundary on top of
 * the shared `genericEventFilterMatches`. There are no per-type branches: a new
 * event type triggers automations by publishing a registered generic event and
 * configuring string filter values — no protocol enum, dispatch branch, or form
 * panel required.
 *
 * A workspace-level automation gate (`WorkspaceSetting.automationEnabled`) is
 * checked first: when the event's target workspace has the gate closed, the whole
 * dispatch returns before any candidate matching or execution, and the event is
 * dropped (not queued).
 */

import { resolve } from 'node:path'
import type {
  GenericEvent,
  GenericEventFilterBreakdownItem,
  Automation,
  SessionKind,
} from '@ccc/shared/protocol'
import { genericEventFiltersMatch, hasRunLifecycleEventFilter } from '@ccc/shared/protocol'
import { getAutomationEnabled } from '../../kernel/config/index.js'
import { resolveWorkspaceRoot } from '../../state.js'
import { dispatchAndTrack, getStore, inFlight } from '../automations/engine.js'

/**
 * The trusted minimal view a matcher reads for one incoming event. `workspacePath`
 * + `event` come straight off the bus envelope (the model cannot forge another
 * workspace). `sessionKind` is present ONLY for run-lifecycle events — it is the
 * mandatory security-boundary input for `eventSessionKindFilter` and is absent for
 * PR / intent / any other event type (which carry no session origin).
 */
export interface TriggerEventView {
  workspacePath: string
  event: GenericEvent
  sessionKind?: SessionKind
}

/** One dimension's pass/fail in a trigger-match breakdown. */
export type TriggerMatchBreakdownItem =
  | { name: 'sessionKind'; passed: boolean }
  | GenericEventFilterBreakdownItem

/** The full result of a trigger match: overall verdict + per-dimension breakdown. */
export interface TriggerMatchResult {
  matched: boolean
  breakdown: TriggerMatchBreakdownItem[]
}

/**
 * Pure evaluator: does `view` match any of `automation`'s subscription rows? When
 * any row subscribes a run-lifecycle type (`run:started` / `run:settled` /
 * `run:*`) it FIRST applies the mandatory `eventSessionKindFilter` security
 * boundary — an absent/empty filter, or an event whose `sessionKind` is not in
 * it, fails closed — then the shared generic match (any row: workspace + type +
 * status + metadata). For every other type only the generic match runs (a PR /
 * intent event carries no sessionKind). The breakdown reports the sessionKind
 * dimension (when applicable) followed by the generic dimensions of the matching
 * (or last evaluated) row under their vendor-neutral names.
 */
export function evaluateAutomationTriggerMatch(
  automation: Automation,
  view: TriggerEventView,
): TriggerMatchResult {
  const filters = automation.eventFilters ?? null
  const breakdown: TriggerMatchBreakdownItem[] = []

  if (hasRunLifecycleEventFilter(filters) && view.event.type.startsWith('run:')) {
    // sessionKind boundary is mandatory for run-lifecycle triggers: an absent/empty
    // filter fails closed (a stored run-lifecycle automation always has one, via
    // migration + save validation). It runs BEFORE the generic match so a generic
    // metadata filter can never widen the run-source scope. With multi-row
    // subscriptions the gate applies exactly to incoming RUN events on an
    // automation that subscribes run lifecycle — a pr/intent event on the same
    // automation is matched by its own non-run row and carries no sessionKind.
    const skf = automation.eventSessionKindFilter
    breakdown.push({
      name: 'sessionKind',
      passed: !!skf && skf.length > 0 && !!view.sessionKind && skf.includes(view.sessionKind),
    })
  }

  const generic = genericEventFiltersMatch(resolveWorkspaceRoot(automation.workspaceId)!, filters, {
    workspacePath: resolve(view.workspacePath),
    event: view.event,
  })
  breakdown.push(...generic.breakdown)

  return { matched: breakdown.every((b) => b.passed), breakdown }
}

/**
 * Dispatch event-triggered automations for one incoming event.
 *
 * The workspace automation gate is checked first (a closed gate drops the whole
 * dispatch, no queueing). Every active event-trigger automation is then matched
 * via the shared {@link evaluateAutomationTriggerMatch}; a single candidate whose
 * evaluation throws fails closed (logged by id, skipped) without affecting the
 * others. A matched automation with no in-flight execution is dispatched; SCH-R7
 * serial execution doubles as event-storm throttling.
 */
export function dispatchEventTriggers(view: TriggerEventView): void {
  const store = getStore()
  if (!store) return

  // Workspace automation gate: resolve the event's target workspace and, when the
  // gate is closed, drop the whole dispatch before any candidate matching, in-flight
  // warning, or execution log. Suppressed events are not queued — a re-open only
  // acts on newly arriving events, never a backlog.
  const workspacePath = resolve(view.workspacePath)
  if (!getAutomationEnabled(workspacePath)) return

  let candidates: Automation[]
  try {
    candidates = store.getEventAutomations(view.event.type)
  } catch (err) {
    console.error('[scheduler] getEventAutomations failed for %s:', view.event.type, err)
    return
  }

  for (const automation of candidates) {
    if (automation.status !== 'active') continue
    let matched: boolean
    try {
      matched = evaluateAutomationTriggerMatch(automation, view).matched
    } catch (err) {
      // Fail closed on a single bad candidate — never let it block other candidates
      // for the same event. Log the automation id (never the raw event) for triage.
      console.error('[scheduler] trigger match failed for automation %s:', automation.id, err)
      continue
    }
    if (!matched) continue
    // SCH-R7 / event-storm throttle: one in-flight execution per automation.
    if (inFlight.has(automation.id)) {
      console.warn(
        '[scheduler] event %s: automation %s already in flight, skipping',
        view.event.type,
        automation.id,
      )
      continue
    }
    dispatchAndTrack(automation)
  }
}
