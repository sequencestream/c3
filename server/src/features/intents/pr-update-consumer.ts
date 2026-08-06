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
 * WHICH PR it resets: the event's `data.pr.number` when it carries one. Without a
 * number it falls back to the intent's single non-terminal PR; if the intent has
 * several, the event cannot say which one was re-submitted, so nothing is reset
 * and a warning is logged. A batch reset would be a guess written to the ledger.
 */
import type { IntentPr, IntentPrStatus } from '@ccc/shared/protocol'
import type { GenericEventEnvelope } from '@ccc/shared'
import { projectPrOperationEvent } from '../pr-events/tool-defs.js'

/** PR statuses that an `update/success` event may reset back to `reviewing`. */
const RESETTABLE_PR_STATUSES: readonly IntentPrStatus[] = ['rejected', 'failed', 'closed']

/**
 * Which of the intent's PRs this event is about.
 *
 * An event that names a number addresses exactly that row. One that does not
 * falls back to the intent's single non-`merged` PR — unambiguous while an intent
 * owns at most one live PR — and gives up when there are several: a re-submission
 * event without a number cannot say WHICH PR was re-submitted, and resetting all
 * of them would write a guess into the ledger.
 */
function locateResetTarget(prs: IntentPr[], number: number | undefined): IntentPr | null {
  if (number !== undefined) {
    return prs.find((pr) => pr.number === String(number)) ?? null
  }
  const candidates = prs.filter((pr) => pr.status !== 'merged')
  if (candidates.length === 1) return candidates[0]
  if (candidates.length > 1) {
    console.warn(
      `[c3:intents] pr:update event carries no PR number and intent ${candidates[0].intentId} ` +
        `has ${candidates.length} unmerged PRs — cannot locate the target, ignoring`,
    )
  }
  return null
}

/** Injected intent-store + broadcast capabilities, so the handler stays unit-testable. */
export interface PrUpdateConsumerDeps {
  /** Look up an intent by id; returns null when it does not exist. */
  getIntent: (id: string) => { id: string; workspaceId: string; prs: IntentPr[] } | null
  /** Stable workspace id for a workspace path (null when the path is unknown). */
  pathToId: (path: string) => string | null
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
    if (intent.workspaceId !== deps.pathToId(envelope.workspacePath)) return false

    const target = locateResetTarget(intent.prs, pr.pr?.number)
    if (!target) return false

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
