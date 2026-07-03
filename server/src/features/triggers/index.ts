/**
 * Event trigger — dispatches event-triggered automations in response to a run
 * lifecycle event (2026-06-08), a model-published PR operation event (2026-06-20),
 * or an intent lifecycle event.
 *
 * Wired to the kernel event bus in the composition root: the event arrives, and
 * every active event-trigger automation that matches is executed via the SAME
 * path as a cron run (the shared execution engine's `dispatchAndTrack`), reusing
 * the three-tier MCP security model and the write-approval queue.
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
import { resolveWorkspaceRoot } from '../../state.js'
import { dispatchAndTrack, getStore, inFlight } from '../automations/engine.js'

/**
 * Explicit SessionKind whitelist for event-triggered automations — a business-source
 * judgement. Only `work` runs (user/dev sessions, incl. the automation dev-turn)
 * trigger automations; every other SessionKind (intent comm, discussion, consensus,
 * internal tool, the engine's own runs) is internal and never triggers an
 * automation. Defined as a const array so it is both testable and impossible to
 * accidentally widen via a loose comparison.
 */
const AUTOMATION_TRIGGER_KINDS: readonly SessionKind[] = ['work']

/** Run-lifecycle dispatch payload (`run:started` / `run:settled`). */
type RunDispatchPayload = {
  sessionId: string
  workspacePath: string
  reason?: RunEndReason
  sessionKind: SessionKind
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

/**
 * Dispatch event-triggered automations for an incoming event.
 *
 * Filters, in order:
 *  - `sessionKind` (run topics only): only `work` runs fire user automations; every
 *    other SessionKind is internal. PR events carry no SessionKind — they are
 *    published by the model inside a work session and are never SessionKind-filtered.
 *  - workspace: the event's workspace must equal the automation's workspace.
 *  - reason (run:settled) / PR filter (pr:operation): topic-specific match.
 *  - in-flight: SCH-R7 serial execution doubles as event-storm throttling — an
 *    automation already running skips the new event rather than stacking.
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
  // Explicit SessionKind whitelist: only `work` runs (user/dev) fire user
  // automations; every other SessionKind is internal. PR events carry no SessionKind
  // (the whitelist is run-lifecycle-specific), so they bypass this gate by design.
  if (topic !== 'pr:operation' && topic !== 'intent:lifecycle') {
    const sessionKind = (payload as RunDispatchPayload).sessionKind
    if (!AUTOMATION_TRIGGER_KINDS.includes(sessionKind)) return
  }

  let candidates: Automation[]
  try {
    candidates = store.getEventAutomations(topic)
  } catch (err) {
    console.error('[scheduler] getEventAutomations failed for %s:', topic, err)
    return
  }

  const eventWorkspace = resolve(payload.workspacePath)
  for (const automation of candidates) {
    if (automation.status !== 'active') continue
    // Workspace filter: both sides are resolved to compare canonical paths.
    if (resolveWorkspaceRoot(automation.workspaceId)! !== eventWorkspace) continue
    // Topic-specific filter.
    if (topic === 'pr:operation') {
      const e = payload as PrDispatchPayload
      if (!prFilterMatches(automation.eventPrFilter, e.operation, e.result)) continue
    } else if (topic === 'intent:lifecycle') {
      if (
        !intentFilterMatches(
          automation.eventIntentFilter ?? null,
          (payload as IntentDispatchPayload).phase,
        )
      )
        continue
    } else {
      // Reason filter (run:settled only — run:started carries no reason).
      const reason = (payload as RunDispatchPayload).reason
      const filter = automation.eventReasonFilter
      if (filter && filter.length && reason && !filter.includes(reason)) continue
    }
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
