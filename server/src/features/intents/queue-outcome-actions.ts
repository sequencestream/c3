/**
 * Queue action family: waiting, parking, and the per-intent outcome ledger.
 *
 * Executes the kernel actions that do not start a run — `park`,
 * `wait_user_involve` and `sync_dependency_prs` — plus the success / failure /
 * park transitions the spec and development families both go through, so there
 * is exactly ONE place that decides what a failed attempt costs an intent.
 *
 * The ladder: a failure backs the intent off exponentially; the third
 * consecutive failure parks it. A parked intent is never auto-launched again,
 * but it is NOT `done` — its downstream stays blocked by the dependency gate,
 * and every unrelated intent keeps flowing. The queue as a whole never stops.
 *
 * Deliberately not here: any gate re-evaluation. Whether an intent may run is
 * the kernel's call; this module only records what happened afterwards.
 */
import type { Intent } from '@ccc/shared/protocol'
import type { QueueAction, QueueReasonCode } from '../../kernel/queue/index.js'
import { QUEUE_MAX_ATTEMPTS, backoffDelayMs } from '../../kernel/queue/index.js'
import type { QueueActionContext } from './queue-action-context.js'
import { getIntent } from './store.js'
import { appendQueueDecisions, getQueueIntentMetaById, putQueueIntentMeta } from './queue-store.js'
import { publishIntentLifecycle } from './lifecycle-events.js'
import { syncUnconfirmedDependencyPrsInBackground } from './pr-status-sync.js'

// ---------------------------------------------------------------------------
// Kernel actions
// ---------------------------------------------------------------------------

/** The kernel asked for a park (rework cap, permission wait timeout, …). */
export function executePark(
  ctx: QueueActionContext,
  action: Extract<QueueAction, { kind: 'park' }>,
): void {
  applyPark(ctx, action.intentId, action.reason, action.detail)
}

/**
 * Raise the human todo the kernel asked for. Dedup is structural: the kernel
 * only emits this alongside a park, and a parked intent is never re-parked.
 */
export function executeWaitUserInvolve(
  ctx: QueueActionContext,
  action: Extract<QueueAction, { kind: 'wait_user_involve' }>,
): void {
  const req = getIntent(action.intentId)
  ctx.hooks.createUserTodo({
    workspacePath: ctx.workspacePath,
    intentId: action.intentId,
    sessionId: req?.lastWorkSessionId ?? null,
    title: `「${req?.title ?? action.intentId}」${action.detail}`,
    reasonCode: action.reason,
  })
}

/**
 * Refresh the PR state of dependencies the queue could not confirm as merged.
 * Runs in the background and only marks the queue dirty when it finishes: the
 * dependency gate itself is re-evaluated by the next pass, never here.
 */
export function executeSyncDependencyPrs(
  ctx: QueueActionContext,
  action: Extract<QueueAction, { kind: 'sync_dependency_prs' }>,
): void {
  syncUnconfirmedDependencyPrsInBackground({
    ctx: { broadcastIntents: ctx.hooks.broadcastIntents },
    workspacePath: ctx.workspacePath,
    dependsOn: action.intentIds,
    onComplete: () => ctx.requestPass(),
  })
}

// ---------------------------------------------------------------------------
// Scheduling metadata transitions (shared by every action family)
// ---------------------------------------------------------------------------

/**
 * One failed attempt for ONE intent. Exponential backoff first; the third
 * consecutive failure parks it. The queue itself never stops — other intents
 * that do not depend on this one keep being selected, while its downstream
 * stays blocked by the dependency gate because a parked intent is not `done`.
 */
export function recordFailure(
  ctx: QueueActionContext,
  intentId: string,
  reason: QueueReasonCode,
  detail: string,
): void {
  const now = Date.now()
  const prev = getQueueIntentMetaById(intentId)
  const failureCount = prev.failureCount + 1
  const park = failureCount >= QUEUE_MAX_ATTEMPTS
  putQueueIntentMeta(ctx.workspacePath, {
    ...prev,
    intentId,
    failureCount,
    backoffCount: park ? prev.backoffCount : prev.backoffCount + 1,
    backoffUntil: park ? null : now + backoffDelayMs(failureCount),
    parked: park,
    parkReason: park ? reason : prev.parkReason,
    parkDetail: park ? detail : prev.parkDetail,
    updatedAt: now,
  })
  appendQueueDecisions([
    {
      tickId: ctx.tickId() || 'run',
      workspacePath: ctx.workspacePath,
      intentId,
      decidedAt: now,
      action: park ? 'park' : 'block',
      blockedGate: park ? 'max_attempts_reached' : reason,
      rejectReason: detail,
      attemptCount: failureCount,
      backoffCount: park ? prev.backoffCount : prev.backoffCount + 1,
      nextWakeupAt: park ? null : now + backoffDelayMs(failureCount),
    },
  ])
  const req = getIntent(intentId)
  if (req) publishIntentLifecycle(ctx.workspacePath, req, 'failed')
  console.warn(
    `[c3:queue]「${req?.title ?? intentId}」第 ${failureCount} 次失败(${reason}): ${detail}` +
      (park ? ' → 已 park,队列继续处理其他意图' : ` → 退避 ${backoffDelayMs(failureCount)}ms`),
  )
  ctx.hooks.broadcastQueueDetail(ctx.workspacePath)
}

/** Real progress wipes the consecutive-failure and backoff state. */
export function recordSuccess(ctx: QueueActionContext, intentId: string): void {
  const prev = getQueueIntentMetaById(intentId)
  if (prev.failureCount === 0 && prev.backoffUntil === null) return
  putQueueIntentMeta(ctx.workspacePath, {
    ...prev,
    intentId,
    failureCount: 0,
    backoffUntil: null,
    updatedAt: Date.now(),
  })
}

/** Park an intent that needs a human, and raise exactly one todo for it. */
export function parkForHuman(
  ctx: QueueActionContext,
  req: Intent,
  reason: QueueReasonCode,
  detail: string,
): void {
  applyPark(ctx, req.id, reason, detail)
  ctx.hooks.createUserTodo({
    workspacePath: ctx.workspacePath,
    intentId: req.id,
    sessionId: req.lastWorkSessionId,
    title: `「${req.title}」${detail}`,
    reasonCode: reason,
  })
  publishIntentLifecycle(ctx.workspacePath, req, 'failed')
  console.warn(`[c3:queue]「${req.title}」已 park(${reason}): ${detail}`)
}

export function applyPark(
  ctx: QueueActionContext,
  intentId: string,
  reason: QueueReasonCode,
  detail: string,
): void {
  const prev = getQueueIntentMetaById(intentId)
  if (prev.parked) return
  putQueueIntentMeta(ctx.workspacePath, {
    ...prev,
    intentId,
    parked: true,
    parkReason: reason,
    parkDetail: detail,
    backoffUntil: null,
    updatedAt: Date.now(),
  })
  ctx.hooks.broadcastQueueDetail(ctx.workspacePath)
}

// ---------------------------------------------------------------------------
// Human rulings over the same metadata
// ---------------------------------------------------------------------------
//
// A human ruling arrives from a request handler rather than from a pass, so
// these take the workspace path directly instead of an execution context. They
// live beside the automatic transitions on purpose: park is written in exactly
// one vocabulary, whoever writes it.

/**
 * Clear an intent's park mark so the next pass re-evaluates it from scratch;
 * `false` when there was nothing to clear.
 *
 * The consecutive-failure counter is reset too: an unpark is an explicit human
 * "try this again", and leaving the counter at the cap would re-park the intent
 * on its very first hiccup. Every hard gate is still re-checked next pass.
 */
export function clearPark(workspacePath: string, intentId: string): boolean {
  const prev = getQueueIntentMetaById(intentId)
  if (!prev.parked) return false
  putQueueIntentMeta(workspacePath, {
    ...prev,
    intentId,
    parked: false,
    parkReason: null,
    parkDetail: null,
    failureCount: 0,
    backoffUntil: null,
    updatedAt: Date.now(),
  })
  return true
}

/**
 * Record an explicit human ruling over the queue's latest automatic verdict:
 * `continue` clears the park so the intent is re-evaluated, `block` parks it.
 * Neither marks the intent `done`, and neither bypasses a permission, spec,
 * dependency, concurrency, continuation-budget or commit/push gate — the next
 * pass re-checks all of them. `false` when there was no verdict to override.
 */
export function applyHumanOverride(
  workspacePath: string,
  intentId: string,
  decision: 'continue' | 'block',
  actor: string,
  tickId: string,
): boolean {
  const now = Date.now()
  const prev = getQueueIntentMetaById(intentId)
  if (decision === 'continue' && !prev.parked && prev.backoffUntil === null) return false
  putQueueIntentMeta(workspacePath, {
    ...prev,
    intentId,
    parked: decision === 'block',
    parkReason: decision === 'block' ? 'needs_human_decision' : null,
    parkDetail: decision === 'block' ? `人工裁决停止(${actor})` : null,
    failureCount: decision === 'continue' ? 0 : prev.failureCount,
    backoffUntil: null,
    updatedAt: now,
  })
  appendQueueDecisions([
    {
      tickId,
      workspacePath,
      intentId,
      decidedAt: now,
      action: decision === 'continue' ? 'launch' : 'park',
      blockedGate: 'needs_human_decision',
      rejectReason: `人工覆盖结论:${decision} by ${actor}`,
      attemptCount: prev.failureCount,
      backoffCount: prev.backoffCount,
      nextWakeupAt: null,
    },
  ])
  return true
}
