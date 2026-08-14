/**
 * Intent-domain consumer for model-published `pr:operation` events, carried on the
 * single generic `'event'` bus topic as a {@link GenericEventEnvelope}.
 *
 * This is a resident consumer registered alongside the run-lifecycle domain
 * subscriptions — INDEPENDENT of the Automation dispatch path
 * (`dispatchEventTriggers`). `prStatus` is part of the intent ledger state
 * machine, so its reset must work even when no automation is configured, the
 * Automation store is unavailable, or an in-flight gate skips the automation.
 * The two are separate side-effects of the SAME bus event; neither blocks the
 * other.
 *
 * Behaviour: it first discriminates `event.type === 'pr:operation'`, then projects
 * the PR fields off the normalized generic event. Only an `update/success` event
 * that carries `data.association.intentId` and belongs to the event's workspace can
 * reset a PR whose current status is `rejected`, `failed` or `closed` back to
 * `reviewing`. `merged` (a real terminal state) and every other status are left
 * untouched. All other cases — a non-PR type, missing intentId, unknown intent,
 * cross-workspace intentId, non-success or non-update operation — are silently
 * ignored (the publish itself already succeeded, so there is nothing to error on).
 *
 * WHICH PR it resets: the event's two locators — `data.association.deliveryId`
 * (the ledger key `(intent_id, delivery_id)`) and `data.pr.number`. Either one
 * addresses exactly one row; carrying both is allowed only when they agree.
 * Carrying NEITHER is tolerated for backward compatibility and only while the
 * intent owns exactly one ACTIVE PR. Anything else — an unresolvable locator,
 * two locators pointing at different rows, no locator with several (or zero)
 * active PRs — is REFUSED: nothing reset, nothing logged to the ledger, nothing
 * broadcast, and an `error` line written. Resetting a guessed row would corrupt
 * a real PR's status, which is strictly worse than not resetting at all.
 *
 * The refusal has nowhere else to go: `pr:update` is a broadcast event published
 * by the model through `publish_event`, and the consumer has no requester to
 * answer. So "reporting the error" is the error log plus the tool description
 * that requires publishers to carry a locator.
 */
import type { IntentPr, IntentPrStatus } from '@ccc/shared/protocol'
import type { GenericEventEnvelope } from '@ccc/shared'
import { activeIntentPrs } from '@ccc/shared'
import { projectPrOperationEvent } from '../pr-events/tool-defs.js'

/** PR statuses that an `update/success` event may reset back to `reviewing`. */
const RESETTABLE_PR_STATUSES: readonly IntentPrStatus[] = ['rejected', 'failed', 'closed']

/** Either the single addressed PR row, or why the event could not address one. */
type LocateResult = { ok: true; target: IntentPr } | { ok: false; reason: string }

/**
 * Which of the intent's PRs this event is about — see the module note. Never
 * returns a best guess: every path that cannot name exactly one row comes back
 * with the reason instead.
 */
function locateResetTarget(
  prs: IntentPr[],
  deliveryId: string | undefined,
  number: number | undefined,
): LocateResult {
  const byDelivery =
    deliveryId !== undefined ? prs.find((pr) => pr.deliveryId === deliveryId) : undefined
  const byNumber = number !== undefined ? prs.find((pr) => pr.number === String(number)) : undefined

  if (deliveryId !== undefined && number !== undefined) {
    if (!byDelivery) return { ok: false, reason: `没有面向交付 ${deliveryId} 的 PR 行` }
    if (!byNumber) return { ok: false, reason: `没有编号为 #${number} 的 PR 行` }
    if (byDelivery.id !== byNumber.id) {
      return { ok: false, reason: `deliveryId ${deliveryId} 与 PR #${number} 指向不同的 PR 行` }
    }
    return { ok: true, target: byDelivery }
  }
  if (deliveryId !== undefined) {
    return byDelivery
      ? { ok: true, target: byDelivery }
      : { ok: false, reason: `没有面向交付 ${deliveryId} 的 PR 行` }
  }
  if (number !== undefined) {
    return byNumber
      ? { ok: true, target: byNumber }
      : { ok: false, reason: `没有编号为 #${number} 的 PR 行` }
  }
  // No locator at all: the legacy event form. Tolerated only while it is
  // unambiguous — `closed` counts as terminal here (the shared active
  // definition), so an intent left with only closed rows is refused too.
  const active = activeIntentPrs(prs)
  if (active.length === 1) return { ok: true, target: active[0] }
  return {
    ok: false,
    reason: `事件未携带 deliveryId 或 PR 编号,而该意图有 ${active.length} 条活跃 PR`,
  }
}

/** Injected intent-store + broadcast capabilities, so the handler stays unit-testable. */
export interface PrUpdateConsumerDeps {
  /** Look up an intent by id; returns null when it does not exist. */
  getIntent: (id: string) => { id: string; workspaceName: string; prs: IntentPr[] } | null
  /** Stable workspace name for a workspace path (null when the path is unknown). */
  pathToName: (path: string) => string | null
  /** Persist one PR row's new status through the store's single write entry point. */
  upsertIntentPr: (input: {
    intentId: string
    deliveryId: string | null
    forge: IntentPr['forge']
    repo: string | null
    number: string
    status: IntentPrStatus
  }) => void
  /** Best-effort lifecycle log write (never throws). */
  safeInsertIntentLog: (
    intentId: string,
    operationType: 'pr_updated',
    summary: string,
    actor?: string | null,
  ) => void
  /** Fan the refreshed intent list for a workspace to every connection. */
  broadcastIntents: (workspacePath: string) => void
}

/**
 * Consume one generic `'event'` bus envelope and reset the associated intent's PR
 * status when applicable. Discriminates the PR type, then projects operation /
 * result / association off the normalized event. Returns `true` when a reset
 * actually happened (state changed + log written + broadcast fired), `false` for
 * every ignored case. Never throws: intent lookup / write exceptions are caught
 * and warned so a bad event cannot destabilize the bus or the parallel Automation
 * dispatch.
 */
export function handlePrUpdateEvent(
  envelope: GenericEventEnvelope,
  deps: PrUpdateConsumerDeps,
): boolean {
  if (!envelope.event.type.startsWith('pr:')) return false
  const pr = projectPrOperationEvent(envelope.event)
  if (!pr) return false
  if (pr.operation !== 'update' || pr.result !== 'success') return false

  const intentId = pr.association?.intentId
  if (!intentId) return false

  try {
    const intent = deps.getIntent(intentId)
    if (!intent) return false

    // Reject a cross-workspace intentId: the event's workspace must own the intent.
    if (intent.workspaceName !== deps.pathToName(envelope.workspacePath)) return false

    const located = locateResetTarget(intent.prs, pr.association?.deliveryId, pr.pr?.number)
    if (!located.ok) {
      console.error(
        `[c3:intents] pr:update event for intent ${intentId} 无法定位目标 PR: ${located.reason} — 拒绝复位`,
      )
      return false
    }
    const target = located.target

    // Only rejected/failed/closed are resettable; merged is terminal, and
    // reviewing/other statuses are already correct — no log, no broadcast.
    if (!RESETTABLE_PR_STATUSES.includes(target.status)) return false

    const from = target.status
    deps.upsertIntentPr({
      intentId: intent.id,
      deliveryId: target.deliveryId,
      forge: target.forge,
      repo: target.repo,
      number: target.number,
      status: 'reviewing',
    })
    // Best-effort log: a write failure only warns, it must not roll back the reset.
    deps.safeInsertIntentLog(
      intent.id,
      'pr_updated',
      `PR #${target.number} 已更新并重新提交,状态由 ${from} 复位为 reviewing`,
      'automation',
    )
    // Broadcast only after a real state change.
    deps.broadcastIntents(envelope.workspacePath)
    return true
  } catch (err) {
    console.warn(
      `[c3:intents] pr:update consumer failed for intent ${intentId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    )
    return false
  }
}
