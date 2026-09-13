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
import { activeIntentPrs, deriveIntentPrAggregate, specGateBlocks } from '@ccc/shared'
import type {
  QueueIntentFact,
  QueueRelayRunFact,
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
  // Whether the spec gate currently holds this intent back — the same judgement
  // the kernel applies later. Computing it here drives the fingerprint read: an
  // intent that is not held back never needs its spec content probed, and a
  // high-impact intent is held back even under a switched-off workspace.
  const gateBlocked = specGateBlocks({
    impactLevel: r.impactLevel,
    effectiveSpecMode: r.effectiveSpecMode,
    sddEnabled,
    specStatus: r.specStatus,
    specApproveUser: r.specApproveUser,
  })
  return {
    id: r.id,
    title: r.title,
    status: r.status,
    priority: r.priority,
    automate: r.automate,
    dependsOn: r.dependsOn,
    specStatus: r.specStatus,
    // Already resolved on the read model (persisted override + workspace switch +
    // impact level), so the kernel gate and the manual admission gate read the
    // very same value.
    effectiveSpecMode: r.effectiveSpecMode,
    // The grade and the approval identity ride along so the PURE kernel can apply
    // the high-impact gate (L1/L2 must be human-approved) without touching the
    // store — the assembly boundary reads live state, the kernel stays a pure
    // function of its input.
    impactLevel: r.impactLevel,
    specApproveUser: r.specApproveUser,
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
    // Only intents the spec gate holds back pay the per-intent file read: `fast`
    // and spec-less-workspace intents never enter the spec phase and never need
    // their content probed.
    specFingerprint: gateBlocked ? readSpecFingerprint(workspacePath, r.specPath) : null,
    specReviewVerdict: r.specReviewVerdict,
    specReviewFingerprint: r.specReviewFingerprint,
    specReviewReworkRounds: r.specReviewReworkRounds,
    specReviewMachineApprovalBlocked: r.specReviewMachineApprovalBlocked,
    // The relay only ever acts on a PR that is still live. Reduced HERE with the
    // shared `activeIntentPrs` rule, so the kernel cannot be told a merged or
    // closed PR is still waiting for an AI review — and so a forge `rejected` row
    // can never be mistaken for the AI review's own `rejected` conclusion.
    hasActivePr: activeIntentPrs(r.prs).length > 0,
    reviewSessionId: r.reviewSessionId,
    reviewStatus: r.reviewStatus,
    reviewFixRounds: r.reviewFixRounds,
    fixSessionId: r.fixSessionId,
    fixStatus: r.fixStatus,
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

/**
 * Probe the PR review / fix sessions the ledger points at. Kept apart from both
 * {@link probeRunFacts} and {@link probeSpecRunFacts} for the same reason those
 * are apart from each other: a relay session is neither development nor a spec
 * phase, and letting it into either set would make it read as the wrong kind of
 * work to the gates that consume them.
 *
 * A session counts as "alive" under exactly the rule the spec phase uses
 * ({@link isSpecOccupancyAlive}): a live run, or a `pending:` placeholder whose
 * projection row has not aged past the grace window. That is what closes the bind
 * gap — from the moment a Review / Fix session is claimed until its real session
 * id replaces the placeholder, the phase must read as occupied, including for a
 * bounded window after a restart.
 */
export function probeRelayRunFacts(
  intents: readonly Intent[],
  hooks: Pick<WorkflowHooks, 'isRunning'>,
  now: number,
): QueueRelayRunFact[] {
  const facts: QueueRelayRunFact[] = []
  const seen = new Set<string>()
  for (const r of intents) {
    for (const sid of [r.reviewSessionId, r.fixSessionId]) {
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
