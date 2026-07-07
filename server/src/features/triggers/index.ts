/**
 * Event trigger — dispatches event-triggered automations in response to a run
 * lifecycle event (2026-06-08), a model-published PR operation event (2026-06-20),
 * or an intent lifecycle event.
 *
 * Wired to the kernel event bus in the composition root: the event arrives, and
 * every active event-trigger automation that matches is executed via the SAME
 * path as a cron run (the shared execution engine's `dispatchAndTrack`), reusing
 * the three-tier MCP security model and the write-approval queue.
 *
 * The per-automation match decision lives in the pure {@link evaluateAutomationTriggerMatch}
 * evaluator, keeping the match semantics isolated from the dispatch plumbing.
 */

import { resolve } from 'node:path'
import type {
  IntentLifecycleEvent,
  IntentLifecycleFilter,
  PrOperation,
  PrOperationEvent,
  PrOperationFilter,
  PrOperationResult,
  RunEndReason,
  RunLifecycleTopic,
  Automation,
  ScheduleEventTopic,
  SessionKind,
} from '@ccc/shared/protocol'
import { metadataFilterMatches } from '@ccc/shared/protocol'
import { resolveWorkspaceRoot } from '../../state.js'
import { dispatchAndTrack, getStore, inFlight } from '../automations/engine.js'

/** Run-lifecycle dispatch payload (`run:started` / `run:settled`). */
type RunDispatchPayload = {
  sessionId: string
  workspacePath: string
  reason?: RunEndReason
  sessionKind: SessionKind
  metadata?: Record<string, string> | null
}

/** PR-event dispatch payload (`pr:operation`) — the validated, normalized event. */
type PrDispatchPayload = { sessionId: string; workspacePath: string } & PrOperationEvent
type IntentDispatchPayload = { workspacePath: string } & IntentLifecycleEvent

/**
 * Whether a `pr:operation` event matches an automation's PR filter. A null filter,
 * or an empty dimension, matches any value of that dimension (2026-06-20).
 */
function prFilterMatches(
  filter: PrOperationFilter | null,
  operation: PrOperation,
  result: PrOperationResult,
): boolean {
  if (!filter) return true
  if (filter.operations && filter.operations.length && !filter.operations.includes(operation)) {
    return false
  }
  if (filter.results && filter.results.length && !filter.results.includes(result)) {
    return false
  }
  return true
}

export function intentFilterMatches(
  filter: IntentLifecycleFilter | null,
  phase: IntentLifecycleEvent['phase'],
): boolean {
  return !filter?.phases?.length || filter.phases.includes(phase)
}

/** One dimension's pass/fail in a trigger-match breakdown. */
export interface TriggerMatchBreakdownItem {
  name: string
  passed: boolean
}

/** The full result of a trigger match: overall verdict + per-dimension breakdown. */
export interface TriggerMatchResult {
  matched: boolean
  breakdown: TriggerMatchBreakdownItem[]
}

/** Normalized synthetic/real event fields the evaluator reads, per topic. */
export interface TriggerEventInput {
  workspacePath: string
  sessionKind?: SessionKind
  reason?: RunEndReason
  metadata?: Record<string, string>
  operation?: PrOperation
  result?: PrOperationResult
  phase?: IntentLifecycleEvent['phase']
}

/**
 * Pure evaluator: does `event` (on `topic`) match `automation`'s trigger filters?
 * Returns the overall verdict plus a stable per-dimension breakdown covering only
 * the dimensions that participate for this topic (topic + workspace always; then
 * sessionKind/reason/metadata for run-lifecycle, pr for `pr:operation`, intentPhase
 * for `intent:lifecycle`).
 */
export function evaluateAutomationTriggerMatch(
  automation: Automation,
  topic: ScheduleEventTopic,
  event: TriggerEventInput,
): TriggerMatchResult {
  const breakdown: TriggerMatchBreakdownItem[] = []
  const add = (name: string, passed: boolean): void => {
    breakdown.push({ name, passed })
  }

  add('topic', automation.eventTopic === topic)
  add('workspace', resolveWorkspaceRoot(automation.workspaceId)! === resolve(event.workspacePath))

  if (topic === 'run:started' || topic === 'run:settled') {
    // sessionKind filter is mandatory for run-lifecycle triggers: an absent/empty
    // filter fails closed (a stored run-lifecycle automation always has one, via
    // migration + save validation).
    const filter = automation.eventSessionKindFilter
    add(
      'sessionKind',
      !!filter && filter.length > 0 && !!event.sessionKind && filter.includes(event.sessionKind),
    )
    if (topic === 'run:settled') {
      const reasonFilter = automation.eventReasonFilter
      add(
        'reason',
        !reasonFilter ||
          reasonFilter.length === 0 ||
          (!!event.reason && reasonFilter.includes(event.reason)),
      )
    }
    if (automation.eventMetadataFilter) {
      add('metadata', metadataFilterMatches(automation.eventMetadataFilter, event.metadata ?? {}))
    }
  } else if (topic === 'pr:operation') {
    add(
      'pr',
      !!event.operation &&
        !!event.result &&
        prFilterMatches(automation.eventPrFilter, event.operation, event.result),
    )
  } else if (topic === 'intent:lifecycle') {
    add(
      'intentPhase',
      !!event.phase && intentFilterMatches(automation.eventIntentFilter ?? null, event.phase),
    )
  }

  return { matched: breakdown.every((b) => b.passed), breakdown }
}

/** Project a real dispatch payload onto the evaluator's normalized event input. */
function toTriggerEventInput(
  topic: ScheduleEventTopic,
  payload: RunDispatchPayload | PrDispatchPayload | IntentDispatchPayload,
): TriggerEventInput {
  if (topic === 'pr:operation') {
    const e = payload as PrDispatchPayload
    return { workspacePath: e.workspacePath, operation: e.operation, result: e.result }
  }
  if (topic === 'intent:lifecycle') {
    const e = payload as IntentDispatchPayload
    return { workspacePath: e.workspacePath, phase: e.phase }
  }
  const e = payload as RunDispatchPayload
  return {
    workspacePath: e.workspacePath,
    sessionKind: e.sessionKind,
    reason: e.reason,
    metadata: e.metadata ?? undefined,
  }
}

/**
 * Dispatch event-triggered automations for an incoming event.
 *
 * Each active automation subscribed to the topic is matched via the shared
 * {@link evaluateAutomationTriggerMatch} evaluator (workspace, per-automation
 * `eventSessionKindFilter`, reason, PR filter, intent phase, metadata filter). A
 * matched automation with no in-flight execution is dispatched; SCH-R7 serial
 * execution doubles as event-storm throttling.
 */
export function dispatchEventTriggers(topic: RunLifecycleTopic, payload: RunDispatchPayload): void
export function dispatchEventTriggers(topic: 'pr:operation', payload: PrDispatchPayload): void
export function dispatchEventTriggers(
  topic: 'intent:lifecycle',
  payload: IntentDispatchPayload,
): void
export function dispatchEventTriggers(
  topic: ScheduleEventTopic,
  payload: RunDispatchPayload | PrDispatchPayload | IntentDispatchPayload,
): void {
  const store = getStore()
  if (!store) return

  let candidates: Automation[]
  try {
    candidates = store.getEventAutomations(topic)
  } catch (err) {
    console.error('[scheduler] getEventAutomations failed for %s:', topic, err)
    return
  }

  const event = toTriggerEventInput(topic, payload)
  for (const automation of candidates) {
    if (automation.status !== 'active') continue
    if (!evaluateAutomationTriggerMatch(automation, topic, event).matched) continue
    // SCH-R7 / event-storm throttle: one in-flight execution per automation.
    if (inFlight.has(automation.id)) {
      console.warn(
        '[scheduler] event %s: automation %s already in flight, skipping',
        topic,
        automation.id,
      )
      continue
    }
    dispatchAndTrack(automation)
  }
}
