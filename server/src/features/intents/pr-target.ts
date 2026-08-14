/**
 * Where ONE create-PR run points: the delivery it belongs to and the branch the
 * PR is opened against.
 *
 * Extracted out of `write-cores.ts` so all THREE create-PR entry points share a
 * single resolution instead of growing their own: the human / advisor
 * `create_pr` (write-cores), the automation queue's done path
 * (`queue-dev-actions`), and the manual session-end cleanup (`dev-cleanup`,
 * which takes it injected). A separate module rather than an export off
 * write-cores because the automatic paths need the resolver, not write-cores'
 * whole commit/close/status surface.
 *
 * The resolution itself is target-only, and all three entry points now file
 * against the base it returns — including the unlinked case, where that base is
 * the intent's persisted `baseBranch`. What stays each entry point's own policy
 * is WHEN it runs and what a failed resolution costs: the automatic paths file
 * only once the intent reads back as `done` and turn an unusable target into a
 * workbench todo, while the human path is status-independent and surfaces the
 * bare code as a UI error. Neither invents a base the resolver did not return.
 */
import type { Intent } from '@ccc/shared/protocol'
import { getDelivery } from '../deliveries/store.js'
import { pathToName } from '../../state.js'
import { normalizeBranchName } from './dependency-gate.js'

/**
 * Resolved ONCE per run and threaded through the diff gate, the forge create,
 * the ledger row and the `pr:create` event. `deliveryId: null` = no delivery
 * binding (the pre-delivery mainline behaviour).
 */
export type PrTargetResolution =
  { ok: true; deliveryId: string | null; baseBranch: string } | { ok: false; code: string }

/**
 * Resolve which delivery this create targets, and the base branch that follows
 * from it.
 *
 * An explicit `deliveryId` wins. Without one, the intent's association edges
 * decide: none → the mainline (a workspace that never adopted deliveries keeps
 * working exactly as before), exactly one → that delivery, several → refused.
 * "Several" is the one case where a choice exists and only the user can make it;
 * picking the first edge would silently file the PR against a delivery the user
 * never chose. The same resolution serves the human, the advisor and the two
 * automatic entry points, so neither an agent nor the queue can reach a target a
 * human could not.
 *
 * A named delivery must exist, belong to THIS workspace, and already be linked
 * to the intent — the link check keeps `intent_prs.delivery_id` from pointing at
 * a delivery `intent_deliveries` knows nothing about, which would file the PR row
 * under a group the intent detail never renders. Only then does branch readiness
 * apply, so an unusable id never surfaces as "branch not ready".
 *
 * The base branch comes from `intent.baseBranch` — the persisted snapshot the
 * worktree baseline reads too, so the branch a PR targets and the branch the
 * work was developed on are the same recorded fact rather than two live
 * derivations that drifted. The ONE exception is an explicitly REQUESTED
 * delivery: with several links the snapshot holds the first one, and the whole
 * point of asking the user which delivery to file against is that their answer
 * decides the base.
 */
export function resolvePrTarget(
  workspacePath: string,
  intent: Intent,
  requestedDeliveryId: string | undefined,
): PrTargetResolution {
  const linked = intent.linkedDeliveries
  let deliveryId: string | null
  if (requestedDeliveryId) {
    deliveryId = requestedDeliveryId
  } else if (linked.length === 0) {
    deliveryId = null
  } else if (linked.length === 1) {
    deliveryId = linked[0].id
  } else {
    return { ok: false, code: 'delivery.prCreateAmbiguous' }
  }

  if (deliveryId === null) {
    return { ok: true, deliveryId: null, baseBranch: intent.baseBranch }
  }

  const delivery = getDelivery(deliveryId)
  if (!delivery || delivery.workspaceName !== pathToName(workspacePath)) {
    return { ok: false, code: 'delivery.prCreateDeliveryUnknown' }
  }
  if (!linked.some((d) => d.id === deliveryId)) {
    return { ok: false, code: 'delivery.prCreateNotLinked' }
  }
  const branchName = normalizeBranchName(delivery.branchName)
  if (!delivery.branchReady || branchName === null) {
    return { ok: false, code: 'delivery.guard.branchNotReady' }
  }
  return {
    ok: true,
    deliveryId,
    baseBranch: requestedDeliveryId ? branchName : intent.baseBranch,
  }
}

/**
 * Readable reason for a failed resolution, for the todo an AUTOMATIC path
 * raises. The human paths surface the bare code through the UI error table
 * instead; this exists because a queue / workbench todo carries free text, not a
 * UiError key, and "delivery.guard.branchNotReady" is not a sentence. The code
 * is kept alongside the sentence so a report stays greppable by it.
 */
export function prTargetFailureText(code: string): string {
  return `${prTargetFailureReason(code)}(${code})`
}

function prTargetFailureReason(code: string): string {
  switch (code) {
    case 'delivery.guard.branchNotReady':
      return '关联交付的分支尚未就绪,未创建 PR'
    case 'delivery.prCreateAmbiguous':
      return '关联了多个交付,需人工选定目标,未创建 PR'
    case 'delivery.prCreateDeliveryUnknown':
      return '关联的交付不存在或不属于本工作区,未创建 PR'
    case 'delivery.prCreateNotLinked':
      return '意图未关联该交付,未创建 PR'
    default:
      return 'PR 目标不可用,未创建 PR'
  }
}
