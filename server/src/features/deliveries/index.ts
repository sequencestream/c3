/**
 * `deliveries` feature handlers — slice 2/3 (ADR-0036).
 *
 * Slice 1: pure local data actions (create / list / detail / update / cancel /
 * status transition) — no git, no forge, no network. Slice 2 adds the EXPLICIT,
 * retryable branch-init action (`init_delivery_branch`) and the manual terminal
 * cleanup (`cleanup_delivery_branch`): the delivery's real integration branch is
 * created on / bound to the remote, guarded by the multi-repo gate and the
 * orphan-defense (a push success whose DB write failed is recovered idempotently
 * on retry, and a mismatched remote branch is NEVER overwritten).
 *
 * All status writes funnel through the delivery domain's pure
 * `canTransitionDelivery`, so the client can never relax reachability or guards;
 * the transition plan + gaps the page renders come from `computeTransitionPlan`,
 * recomputed on every read and write.
 */
import type { DeliveryStatus } from '@ccc/shared/protocol'
import {
  createDeliveryBranch,
  deleteLocalBranch,
  fetchRemoteBaseAsync,
  isMultiRepoWorkspace,
  remoteBranchHead,
  resolveRefHead,
} from '../../git.js'
import { getDefaultMainBranch } from '../../kernel/config/index.js'
import { resolveWorkspaceRoot } from '../../state.js'
import type { Handler } from '../../transport/handler-registry.js'
import {
  canTransitionDelivery,
  computeTransitionPlan,
  countDeliveriesNeedingAction,
} from './state-machine.js'
import {
  activeDeliveryHoldsBranch,
  clearDeliveryBranch,
  createDelivery,
  getDelivery,
  isStoreAvailable,
  listDeliveries,
  setDeliveryBranch,
  setDeliveryStatus,
  updateDelivery,
  type UpdateDeliveryInput,
} from './store.js'

/** Branch-init progress phases (mirrors the wire union, kept local to the partition). */
type DeliveryBranchPhase = 'fetching' | 'creating' | 'pushing' | 'binding'

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
  // Multi-repo gate BEFORE the transaction opens: a delivery needs one real
  // remote branch, which a non-repo root with sub-repos cannot host (a single
  // branch there would fake "partially delivered"). Pure local directory walk —
  // create_delivery still never touches the network. Also re-checked at branch
  // init, so the same verdict guards both halves of the lifecycle.
  if (isMultiRepoWorkspace(abs)) {
    conn.send({ type: 'error', error: { code: 'delivery.multiRepoUnsupported' } })
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

/**
 * Initialize the delivery's remote branch — the explicit, retryable Git action
 * split out of delivery creation (a create never touches the network, so a
 * network failure cannot leave the delivery half-initialized). Flow:
 *
 * 1. Multi-repo gate → `delivery.multiRepoUnsupported` (before any git command).
 * 2. `fetch origin <base_branch>` → the expected start is the JUST-FETCHED
 *    `origin/<base_branch>` HEAD — never a local ref (a stale local ref would
 *    root the delivery behind the team's mainline).
 * 3. Probe the remote for the branch.
 * 4. `create`: absent → `createDeliveryBranch` (fetch → branch → push), then
 *    write the DB ONLY on success. Present + head matches the expected start →
 *    orphan from a failed DB write after a successful push → idempotent bind (no
 *    re-push). Present + head differs → `delivery.branchConflict`, never
 *    overwritten.
 * 5. `bind`: the remote branch must exist (`delivery.branchNotFound` otherwise);
 *    an ACTIVE delivery already holding it is `delivery.branchConflict`. Bound on
 *    success; divergence from the baseline is only a warning
 *    (`delivery.branchBehindMain`), never a rejection.
 *
 * Progress (`fetching → creating → pushing`, or a single `binding`) is pushed to
 * the requesting connection; the result frame refreshes the detail and the
 * `deliveries` list is broadcast.
 */
export const initDeliveryBranchHandler: Handler<'init_delivery_branch'> = async (
  ctx,
  conn,
  msg,
) => {
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
  if (delivery.status === 'delivered' || delivery.status === 'cancelled') {
    conn.send({
      type: 'error',
      error: { code: 'delivery.initFailed', params: { detail: '交付已进入终态,无法初始化分支' } },
    })
    return
  }
  const branchName = msg.branchName.trim()
  if (!branchName) {
    conn.send({
      type: 'error',
      error: { code: 'delivery.initFailed', params: { detail: '分支名不能为空' } },
    })
    return
  }
  // Multi-repo gate (same verdict as create_delivery) before ANY git command.
  if (isMultiRepoWorkspace(abs)) {
    conn.send({ type: 'error', error: { code: 'delivery.multiRepoUnsupported' } })
    return
  }

  const report = (phase: DeliveryBranchPhase): void =>
    conn.send({ type: 'delivery_branch_init_progress', deliveryId: msg.deliveryId, phase })

  // Idempotent shortcut: already bound to this exact branch → success, no git.
  if (delivery.branchReady && delivery.branchName === branchName) {
    conn.send({ type: 'delivery_branch_init_result', workspaceId: msg.workspaceId, delivery })
    return
  }
  if (delivery.branchReady && delivery.branchName !== branchName) {
    conn.send({
      type: 'error',
      error: {
        code: 'delivery.branchConflict',
        params: { branch: delivery.branchName ?? branchName },
      },
    })
    return
  }

  report('fetching')
  const remoteRef = await fetchRemoteBaseAsync(abs, delivery.baseBranch)
  if (!remoteRef) {
    conn.send({
      type: 'error',
      error: {
        code: 'delivery.initFailed',
        params: { detail: `无法 fetch 基线分支 ${delivery.baseBranch}(离线或无远端)` },
      },
    })
    return
  }
  const expectedHead = await resolveRefHead(abs, remoteRef)
  if (!expectedHead) {
    conn.send({
      type: 'error',
      error: { code: 'delivery.initFailed', params: { detail: `远端基线 ${remoteRef} 无法解析` } },
    })
    return
  }

  const existingHead = await remoteBranchHead(abs, branchName)

  if (msg.mode === 'bind') {
    if (!existingHead) {
      conn.send({
        type: 'error',
        error: { code: 'delivery.branchNotFound', params: { branch: branchName } },
      })
      return
    }
    if (activeDeliveryHoldsBranch(abs, branchName, msg.deliveryId)) {
      conn.send({
        type: 'error',
        error: { code: 'delivery.branchConflict', params: { branch: branchName } },
      })
      return
    }
    report('binding')
    const updated = setDeliveryBranch(msg.deliveryId, branchName, true)
    if (!updated) {
      conn.send({ type: 'error', error: { code: 'delivery.notFound' } })
      return
    }
    const warning = existingHead === expectedHead ? undefined : 'delivery.branchBehindMain'
    conn.send({
      type: 'delivery_branch_init_result',
      workspaceId: msg.workspaceId,
      delivery: updated,
      ...(warning ? { warning } : {}),
    })
    ctx.broadcastDeliveries(abs)
    return
  }

  // mode: create — the remote branch must be absent, or an orphan of a previous
  // failed write that we may recover idempotently.
  if (existingHead) {
    if (existingHead === expectedHead) {
      // push 成功但 DB 写失败的孤儿 → 幂等绑定,不重新 push,绝不覆盖。
      report('binding')
      const updated = setDeliveryBranch(msg.deliveryId, branchName, true)
      if (!updated) {
        conn.send({ type: 'error', error: { code: 'delivery.notFound' } })
        return
      }
      conn.send({
        type: 'delivery_branch_init_result',
        workspaceId: msg.workspaceId,
        delivery: updated,
      })
      ctx.broadcastDeliveries(abs)
      return
    }
    // 起点不匹配 → 与他人分支冲突,无论用户是否确认都不 force push。
    conn.send({
      type: 'error',
      error: { code: 'delivery.branchConflict', params: { branch: branchName } },
    })
    return
  }

  const result = await createDeliveryBranch(abs, branchName, delivery.baseBranch, {
    onPhase: report,
  })
  if (!result.ok) {
    conn.send({
      type: 'error',
      error:
        result.errorKind === 'branchConflict'
          ? { code: 'delivery.branchConflict', params: { branch: branchName } }
          : { code: 'delivery.initFailed', params: { detail: result.error ?? '分支初始化失败' } },
    })
    return
  }
  const updated = setDeliveryBranch(msg.deliveryId, branchName, true)
  if (!updated) {
    // push 成功但 DB 写失败:重试时孤儿分支防御按起点匹配幂等绑定。
    conn.send({
      type: 'error',
      error: {
        code: 'delivery.initFailed',
        params: { detail: '分支已推送但台账写入失败,请重试初始化' },
      },
    })
    return
  }
  conn.send({
    type: 'delivery_branch_init_result',
    workspaceId: msg.workspaceId,
    delivery: updated,
  })
  ctx.broadcastDeliveries(abs)
}

/**
 * Clear a TERMINAL delivery's local branch reference (manual cleanup, requires
 * the page's second confirmation). Never touches the remote branch — deleting a
 * remote branch is irreversible, so it is never automated. Refused on any
 * non-terminal delivery (`delivery.cleanupForbidden`). Local-branch deletion is
 * best-effort (a missing branch is simply nothing to clean); the DB fields are
 * cleared regardless.
 */
export const cleanupDeliveryBranchHandler: Handler<'cleanup_delivery_branch'> = async (
  ctx,
  conn,
  msg,
) => {
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
  if (delivery.status !== 'delivered' && delivery.status !== 'cancelled') {
    conn.send({ type: 'error', error: { code: 'delivery.cleanupForbidden' } })
    return
  }
  if (delivery.branchName) {
    await deleteLocalBranch(abs, delivery.branchName)
  }
  const updated = clearDeliveryBranch(msg.deliveryId)
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
