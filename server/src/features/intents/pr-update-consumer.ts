/**
 * Intent-domain consumer for model-published `pr:operation` events.
 *
 * This is a resident consumer registered alongside the run-lifecycle domain
 * subscriptions — INDEPENDENT of the Automation dispatch path
 * (`dispatchEventTriggers`). `prStatus` is part of the intent ledger state
 * machine, so its reset must work even when no automation is configured, the
 * Automation store is unavailable, or an in-flight gate skips the automation.
 * The two are separate side-effects of the SAME bus event; neither blocks the
 * other.
 *
 * Behaviour: only an `update/success` event that carries `association.intentId`
 * and belongs to the event's workspace can reset a PR whose current status is
 * `rejected`, `failed` or `closed` back to `reviewing`. `merged` (a real
 * terminal state) and every other status are left untouched. All other cases —
 * missing intentId, unknown intent, cross-workspace intentId, non-success or
 * non-update operation — are silently ignored (the publish itself already
 * succeeded, so there is nothing to error on).
 */
import type { IntentPrStatus, PrOperationEvent } from '@ccc/shared/protocol'

/** The bus payload shape for a `pr:operation` event (envelope + normalized event). */
export type PrOperationBusPayload = { workspacePath: string; sessionId: string } & PrOperationEvent

/** PR statuses that an `update/success` event may reset back to `reviewing`. */
const RESETTABLE_PR_STATUSES: readonly IntentPrStatus[] = ['rejected', 'failed', 'closed']

/** Injected intent-store + broadcast capabilities, so the handler stays unit-testable. */
export interface PrUpdateConsumerDeps {
  /** Look up an intent by id; returns null when it does not exist. */
  getIntent: (
    id: string,
  ) => { id: string; workspaceId: string; prStatus: IntentPrStatus | null } | null
  /** Stable workspace id for a workspace path (null when the path is unknown). */
  pathToId: (path: string) => string | null
  /** Persist the intent's new PR status. */
  setPrStatus: (id: string, prStatus: IntentPrStatus) => void
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
 * Consume one `pr:operation` bus payload and reset the associated intent's PR
 * status when applicable. Returns `true` when a reset actually happened (state
 * changed + log written + broadcast fired), `false` for every ignored case.
 * Never throws: intent lookup / write exceptions are caught and warned so a bad
 * event cannot destabilize the bus or the parallel Automation dispatch.
 */
export function handlePrUpdateEvent(
  payload: PrOperationBusPayload,
  deps: PrUpdateConsumerDeps,
): boolean {
  if (payload.operation !== 'update' || payload.result !== 'success') return false

  const intentId = payload.association?.intentId
  if (!intentId) return false

  try {
    const intent = deps.getIntent(intentId)
    if (!intent) return false

    // Reject a cross-workspace intentId: the event's workspace must own the intent.
    if (intent.workspaceId !== deps.pathToId(payload.workspacePath)) return false

    // Only rejected/failed/closed are resettable; merged is terminal, and
    // reviewing/null/other statuses are already correct — no log, no broadcast.
    if (!intent.prStatus || !RESETTABLE_PR_STATUSES.includes(intent.prStatus)) return false

    const from = intent.prStatus
    deps.setPrStatus(intent.id, 'reviewing')
    // Best-effort log: a write failure only warns, it must not roll back the reset.
    deps.safeInsertIntentLog(
      intent.id,
      'pr_updated',
      `PR 已更新并重新提交,状态由 ${from} 复位为 reviewing`,
      'automation',
    )
    // Broadcast only after a real state change.
    deps.broadcastIntents(payload.workspacePath)
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
