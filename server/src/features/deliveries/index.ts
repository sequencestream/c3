/**
 * `deliveries` feature handlers — slice 1/3 (ADR-0009).
 *
 * Pure local data actions (create / list / detail / update / cancel / status
 * transition) — this phase never touches git, the forge or the network, and
 * changes NO existing create-PR behaviour. All status writes funnel through the
 * delivery domain's pure `canTransitionDelivery`, so the client can never relax
 * reachability or guards; the transition plan + gaps the page renders come from
 * `computeTransitionPlan`, recomputed on every read and write.
 */
import type { DeliveryStatus } from '@ccc/shared/protocol'
import { getDefaultMainBranch } from '../../kernel/config/index.js'
import { resolveWorkspaceRoot } from '../../state.js'
import type { Handler } from '../../transport/handler-registry.js'
import {
  canTransitionDelivery,
  computeTransitionPlan,
  countDeliveriesNeedingAction,
} from './state-machine.js'
import {
  createDelivery,
  getDelivery,
  isStoreAvailable,
  listDeliveries,
  setDeliveryStatus,
  updateDelivery,
  type UpdateDeliveryInput,
} from './store.js'

export const listDeliveriesHandler: Handler<'list_deliveries'> = (ctx, conn, msg) => {
  if (!isStoreAvailable()) {
    conn.send({ type: 'error', error: { code: 'delivery.dbUnavailable' } })
    return
  }
  const abs = resolveWorkspaceRoot(msg.workspaceId)
  if (!abs) {
    conn.send({
      type: 'error',
      error: { code: 'workspace.unknown', params: { id: msg.workspaceId } },
    })
    return
  }
  const items = listDeliveries(abs)
  conn.send({
    type: 'deliveries',
    workspaceId: msg.workspaceId,
    items,
    needsActionCount: countDeliveriesNeedingAction(items),
  })
}

export const createDeliveryHandler: Handler<'create_delivery'> = (ctx, conn, msg) => {
  if (!isStoreAvailable()) {
    conn.send({ type: 'error', error: { code: 'delivery.dbUnavailable' } })
    return
  }
  const abs = resolveWorkspaceRoot(msg.workspaceId)
  if (!abs) {
    conn.send({
      type: 'error',
      error: { code: 'workspace.unknown', params: { id: msg.workspaceId } },
    })
    return
  }
  const title = msg.title.trim()
  if (!title) {
    conn.send({ type: 'error', error: { code: 'delivery.titleRequired' } })
    return
  }
  // `base_branch` is snapshotted ONCE at create time from the workspace's
  // current effective main branch; a later config change never re-points an
  // existing delivery (it may have been based on the old branch).
  const baseBranch = getDefaultMainBranch(abs) ?? 'main'
  try {
    const { delivery, prMergeNotice } = createDelivery({
      workspacePath: abs,
      title,
      description: msg.description ?? '',
      startDate: msg.startDate ?? null,
      endDate: msg.endDate ?? null,
      baseBranch,
    })
    conn.send({
      type: 'create_delivery_result',
      workspaceId: msg.workspaceId,
      delivery,
      prMergeNotice,
    })
    ctx.broadcastDeliveries(abs)
  } catch (err) {
    conn.send({
      type: 'error',
      error: { code: 'delivery.createFailed', params: { detail: String(err) } },
    })
  }
}

export const getDeliveryDetailHandler: Handler<'get_delivery_detail'> = (_ctx, conn, msg) => {
  if (!isStoreAvailable()) {
    conn.send({ type: 'error', error: { code: 'delivery.dbUnavailable' } })
    return
  }
  const delivery = getDelivery(msg.deliveryId)
  if (!delivery) {
    conn.send({ type: 'error', error: { code: 'delivery.notFound' } })
    return
  }
  conn.send({ type: 'delivery_detail', delivery, transitionPlan: computeTransitionPlan(delivery) })
}

export const updateDeliveryHandler: Handler<'update_delivery'> = (ctx, conn, msg) => {
  if (!isStoreAvailable()) {
    conn.send({ type: 'error', error: { code: 'delivery.dbUnavailable' } })
    return
  }
  const abs = resolveWorkspaceRoot(msg.workspaceId)
  if (!abs) {
    conn.send({
      type: 'error',
      error: { code: 'workspace.unknown', params: { id: msg.workspaceId } },
    })
    return
  }
  const delivery = getDelivery(msg.deliveryId)
  if (!delivery || delivery.workspaceId !== msg.workspaceId) {
    conn.send({ type: 'error', error: { code: 'delivery.notFound' } })
    return
  }
  if (msg.title !== undefined && !msg.title.trim()) {
    conn.send({ type: 'error', error: { code: 'delivery.titleRequired' } })
    return
  }
  const input: UpdateDeliveryInput = {}
  if (msg.title !== undefined) input.title = msg.title.trim()
  if (msg.description !== undefined) input.description = msg.description
  if (msg.startDate !== undefined) input.startDate = msg.startDate
  if (msg.endDate !== undefined) input.endDate = msg.endDate
  try {
    const updated = updateDelivery(msg.deliveryId, input)
    if (!updated) {
      conn.send({ type: 'error', error: { code: 'delivery.notFound' } })
      return
    }
    conn.send({
      type: 'delivery_detail',
      delivery: updated,
      transitionPlan: computeTransitionPlan(updated),
    })
    ctx.broadcastDeliveries(abs)
  } catch (err) {
    conn.send({
      type: 'error',
      error: { code: 'delivery.updateFailed', params: { detail: String(err) } },
    })
  }
}

/**
 * The one status-write core shared by `transition_delivery` and
 * `cancel_delivery`. Re-evaluates `canTransitionDelivery` from CURRENT facts
 * (a stale client plan is refused) and re-computes the plan on success.
 */
function applyTransition(
  ctx: Parameters<Handler<'transition_delivery'>>[0],
  conn: Parameters<Handler<'transition_delivery'>>[1],
  workspaceId: string,
  deliveryId: string,
  to: DeliveryStatus,
  confirmVerified: boolean,
): void {
  const abs = resolveWorkspaceRoot(workspaceId)
  if (!abs) {
    conn.send({ type: 'error', error: { code: 'workspace.unknown', params: { id: workspaceId } } })
    return
  }
  const delivery = getDelivery(deliveryId)
  if (!delivery || delivery.workspaceId !== workspaceId) {
    conn.send({ type: 'error', error: { code: 'delivery.notFound' } })
    return
  }
  const verdict = canTransitionDelivery({
    from: delivery.status,
    to,
    role: 'human',
    branchReady: delivery.branchReady,
    integration: delivery.integration,
    confirmVerified,
  })
  if (!verdict.ok) {
    conn.send({
      type: 'delivery_transition_failed',
      deliveryId,
      code: verdict.code,
      reasons: verdict.reasons,
      currentStatus: delivery.status,
      to,
    })
    return
  }
  const updated = setDeliveryStatus(deliveryId, to)
  if (!updated) {
    conn.send({ type: 'error', error: { code: 'delivery.notFound' } })
    return
  }
  conn.send({
    type: 'delivery_detail',
    delivery: updated,
    transitionPlan: computeTransitionPlan(updated),
  })
  ctx.broadcastDeliveries(abs)
}

export const transitionDeliveryHandler: Handler<'transition_delivery'> = (ctx, conn, msg) => {
  if (!isStoreAvailable()) {
    conn.send({ type: 'error', error: { code: 'delivery.dbUnavailable' } })
    return
  }
  applyTransition(ctx, conn, msg.workspaceId, msg.deliveryId, msg.to, msg.confirmVerified === true)
}

export const cancelDeliveryHandler: Handler<'cancel_delivery'> = (ctx, conn, msg) => {
  if (!isStoreAvailable()) {
    conn.send({ type: 'error', error: { code: 'delivery.dbUnavailable' } })
    return
  }
  applyTransition(ctx, conn, msg.workspaceId, msg.deliveryId, 'cancelled', false)
}
