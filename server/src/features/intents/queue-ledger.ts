/**
 * The queue control layer's bridge to durable state: facts in, decisions out.
 *
 * Everything the pure kernel reads is projected HERE — the ledger row, the
 * liveness of the sessions it points at, the spec file's fingerprint — because
 * `kernel/queue` must stay a pure function of its input. Everything the kernel
 * concluded is written back here, deduplicated so a queue that repeats itself
 * does not grow the decision log.
 *
 * This is control-layer code, not an action executor: nothing here starts a run,
 * touches an intent's status or decides anything. It only reads the world and
 * records verdicts.
 */
import type { Intent } from '@ccc/shared/protocol'
import { deriveIntentPrAggregate } from '@ccc/shared'
import type {
  QueueIntentFact,
  QueueReconcileOutput,
  QueueRunFact,
  QueueSpecRunFact,
} from '../../kernel/queue/index.js'
import type { WorkflowHooks } from './queue-action-context.js'
import { readSpecFingerprint } from './spec-review.js'
import { appendQueueDecisions, latestQueueDecisionByIntent } from './queue-store.js'
import { isSpecOccupancyAlive } from './spec-occupancy.js'

// ---------------------------------------------------------------------------
// Facts in
// ---------------------------------------------------------------------------

/**
 * Project one ledger row onto the kernel's fact shape.
 *
 * `specFingerprint` is read from disk HERE rather than in the kernel, which must
 * stay pure. Reading it every pass is what makes an edited spec invalidate its
 * conclusion by itself: the kernel just compares two strings, so there is no
 * invalidation pass to forget to run. An unreadable spec yields `null`, which the
 * kernel treats as "cannot review", never as changed content.
 */
export function toFact(r: Intent, workspacePath: string, sddEnabled: boolean): QueueIntentFact {
  return {
    id: r.id,
    title: r.title,
    status: r.status,
    priority: r.priority,
    automate: r.automate,
    dependsOn: r.dependsOn,
    specStatus: r.specStatus,
    // The kernel gates on ONE status per intent, so the PR list is reduced HERE,
    // at the assembly boundary, with the same rule the UI uses.
    prStatus: deriveIntentPrAggregate(r.prs),
    branchName: r.branchName,
    // The delivery dimension the shared criterion reads: which deliveries this
    // intent belongs to, and its PR status toward each. Reduced HERE, from the
    // same rows the delivery detail renders, so the kernel stays pure and the
    // gate can never be told a different story than the page shows.
    deliveryIds: r.linkedDeliveries.map((d) => d.id),
    prStatusByDelivery: Object.fromEntries(
      r.prs
        .filter((pr) => pr.deliveryId !== null)
        .map((pr) => [pr.deliveryId as string, pr.status]),
    ),
    lastWorkSessionId: r.lastWorkSessionId,
    createdAt: r.createdAt,
    specPath: r.specPath,
    specSessionId: r.specSessionId,
    specReviewSessionId: r.specReviewSessionId,
    // Only SDD workspaces run the spec phase, so a non-SDD workspace never pays
    // the per-intent file read.
    specFingerprint: sddEnabled ? readSpecFingerprint(workspacePath, r.specPath) : null,
    specReviewVerdict: r.specReviewVerdict,
    specReviewFingerprint: r.specReviewFingerprint,
    specReviewReworkRounds: r.specReviewReworkRounds,
    specReviewMachineApprovalBlocked: r.specReviewMachineApprovalBlocked,
  }
}

/**
 * Probe every work session the ledger points at. A session that is not alive
 * releases `awaiting_gate` by construction — the kernel simply never sees it in
 * the live set, so a dead blocking session can no longer wedge the queue.
 *
 * `awaitingSince` is the controller's own memory of when a permission wait was
 * FIRST observed, and is updated in place: the wait window must be measured from
 * the first sighting, not re-armed on every pass.
 */
export function probeRunFacts(
  intents: readonly Intent[],
  now: number,
  hooks: Pick<WorkflowHooks, 'isRunning' | 'sessionStatus'>,
  awaitingSince: Map<string, number>,
): QueueRunFact[] {
  const facts: QueueRunFact[] = []
  const seen = new Set<string>()
  for (const r of intents) {
    const sid = r.lastWorkSessionId
    if (!sid || seen.has(sid)) continue
    seen.add(sid)
    const alive = hooks.isRunning(sid)
    if (!alive) {
      awaitingSince.delete(sid)
      facts.push({ sessionId: sid, alive: false, awaitingPermissionSince: null })
      continue
    }
    const waiting = hooks.sessionStatus(sid) === 'awaiting_permission'
    if (!waiting) awaitingSince.delete(sid)
    else if (!awaitingSince.has(sid)) awaitingSince.set(sid, now)
    facts.push({
      sessionId: sid,
      alive: true,
      awaitingPermissionSince: waiting ? (awaitingSince.get(sid) ?? now) : null,
    })
  }
  return facts
}

/**
 * Probe the spec-authoring and spec-review sessions the ledger points at. Kept
 * separate from {@link probeRunFacts} on purpose: a spec session is not a work
 * session, so it must never enter the work-liveness set — that set drives the
 * workspace-global concurrency gate, and a spec session running there would
 * wedge the whole development queue behind a document being written.
 *
 * A session counts as "alive" when its run is live OR it is a `pending:`
 * occupancy that has not aged past the grace window. The pending case is what
 * closes the bind gap: from the moment a spec session is launched (its pending
 * id written into `spec_session_id` / `spec_review_session_id`) until the
 * `run:bound` event replaces it, the queue must keep seeing the spec phase as
 * occupied — and after a restart, for the bounded grace window, so a dead
 * launch does not immediately start a duplicate one.
 */
export function probeSpecRunFacts(
  intents: readonly Intent[],
  hooks: Pick<WorkflowHooks, 'isRunning'>,
  now: number,
): QueueSpecRunFact[] {
  const facts: QueueSpecRunFact[] = []
  const seen = new Set<string>()
  for (const r of intents) {
    for (const sid of [r.specSessionId, r.specReviewSessionId]) {
      if (!sid || seen.has(sid)) continue
      seen.add(sid)
      facts.push({ sessionId: sid, alive: isSpecOccupancyAlive(sid, hooks.isRunning, now) })
    }
  }
  return facts
}

// ---------------------------------------------------------------------------
// Decisions out
// ---------------------------------------------------------------------------

/**
 * Persist decisions that actually say something new. A tick that repeats the
 * previous verdict verbatim writes nothing, so a queue parked on one blocked
 * intent does not grow the log by six rows a minute; anything carrying an
 * action, or any change of action/reason/detail, is always written.
 */
export function persistNewDecisions(
  workspacePath: string,
  output: QueueReconcileOutput,
  now: number,
): void {
  const previous = latestQueueDecisionByIntent(workspacePath)
  const actionable = new Set(
    output.actions.filter((a) => 'intentId' in a).map((a) => (a as { intentId: string }).intentId),
  )
  const rows = output.decisions
    .filter((d) => {
      if (actionable.has(d.intentId)) return true
      const prev = previous[d.intentId]
      if (!prev) return true
      return (
        prev.action !== d.action || prev.blockedGate !== d.reason || prev.rejectReason !== d.detail
      )
    })
    .map((d) => ({
      tickId: output.tickId,
      workspacePath,
      intentId: d.intentId,
      decidedAt: now,
      action: d.action,
      blockedGate: d.reason,
      rejectReason: d.detail || null,
      attemptCount: d.attemptCount,
      backoffCount: d.backoffCount,
      nextWakeupAt: d.nextWakeupAt,
    }))
  appendQueueDecisions(rows)
}
