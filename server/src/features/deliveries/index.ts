/**
 * `deliveries` feature handlers (ADR-0036).
 *
 * Slice 1: pure local data actions (create / list / detail / update / cancel /
 * status transition) — no git, no forge, no network. Slice 2 adds the EXPLICIT,
 * retryable branch-init action (`init_delivery_branch`) and the manual terminal
 * cleanup (`cleanup_delivery_branch`): the delivery's real integration branch is
 * created on / bound to the remote, guarded by the multi-repo gate and the
 * orphan-defense (a push success whose DB write failed is recovered idempotently
 * on retry, and a mismatched remote branch is NEVER overwritten). Slice 3 adds
 * the intent ↔ delivery association (`link_intent_to_delivery` /
 * `unlink_intent_from_delivery`) — the edge every guard and the N/M aggregate
 * ultimately read, with the merged-PR unlink denial that keeps "the association
 * is gone but the code is already in" from ever happening.
 *
 * All status writes funnel through the delivery domain's pure
 * `canTransitionDelivery`, so the client can never relax reachability or guards;
 * the transition plan + gaps the page renders come from `computeTransitionPlan`,
 * recomputed on every read and write.
 */
import { randomUUID } from 'node:crypto'
import type {
  Delivery,
  DeliveryLogOperation,
  DeliveryStatus,
  IntentPr,
  ServerToClient,
} from '@ccc/shared/protocol'
import {
  closeForgePr,
  countCommitsAhead,
  createDeliveryBranch,
  createForgePr,
  deleteLocalBranch,
  deliveryMergeTrial,
  detectDeliveryDiffBloat,
  fetchRemoteBaseAsync,
  findMergedForgePr,
  findOpenForgePr,
  getForgeDeliveryPrFacts,
  getForgePrStatus,
  isMultiRepoWorkspace,
  remoteBranchHead,
  resolveRefHead,
  syncDeliveryMainline,
} from '../../git.js'
import {
  getDefaultMainBranch,
  getForgeOverride,
  getGitBranchMode,
} from '../../kernel/config/index.js'
import type { KernelContext } from '../../kernel/types.js'
import { resolveWorkspaceRoot } from '../../state.js'
import type { Conn, Handler } from '../../transport/handler-registry.js'
import { resolveWorkspaceBaseBranch } from '../intents/base-branch.js'
import { parsePrIdentity } from '../intents/pr-identity.js'
import { getIntent, upsertIntentPr } from '../intents/store.js'
import { completeIntentOnPrsMerged } from '../intents/pr-merge-completion.js'
import { markQueueDirty } from '../intents/workflow.js'
import { maybePublishDeliveryReviewRequired } from '../im/broadcast-hooks.js'
import { deliveryMergeActionable } from './merge-attention.js'
import {
  canTransitionDelivery,
  computeTransitionPlan,
  countDeliveriesNeedingAction,
} from './state-machine.js'
import {
  activeDeliveryHoldsBranch,
  adoptReadyDeliveryBranchAsIntentBase,
  clearDeliveryBranch,
  commitDeliveryDelivered,
  commitDeliveryMergeConflict,
  createDelivery,
  deleteIntentDelivery,
  getDelivery,
  getLatestDeliveryPr,
  insertDeliveryLog,
  insertIntentDelivery,
  isIntentLinked,
  isStoreAvailable,
  listAssociatedIntents,
  listDeliveries,
  listDeliveryLogs,
  setDeliveryBranch,
  setDeliveryStatus,
  updateDelivery,
  updateDeliveryPrFacts,
  upsertDeliveryPr,
  type UpdateDeliveryInput,
} from './store.js'

/** Branch-init progress phases (mirrors the wire union, kept local to the partition). */
type DeliveryBranchPhase = 'fetching' | 'creating' | 'pushing' | 'binding'

/**
 * The one `delivery_detail` frame builder. Every reply carrying a delivery's
 * detail goes through it, so the transition plan and the associated-intent list
 * can never be assembled from different reads.
 */
function detailFrame(
  delivery: Delivery,
  linkWarning?: 'delivery.diffBloat',
  mainlineAhead: number | null = null,
  deliveryBranchAhead: number | null = null,
  notice?: 'delivery.autoDelivered',
): Extract<ServerToClient, { type: 'delivery_detail' }> {
  return {
    type: 'delivery_detail',
    delivery,
    transitionPlan: computeTransitionPlan(delivery),
    associatedIntents: listAssociatedIntents(delivery.id),
    mainlineAhead,
    deliveryBranchAhead,
    deliveryPr: getLatestDeliveryPr(delivery.id),
    ...(linkWarning ? { linkWarning } : {}),
    ...(notice ? { notice } : {}),
  }
}

/**
 * How far `origin/<base_branch>` is ahead of the delivery branch, from the LOCAL
 * remote-tracking refs. Deliberately fetch-free: a network round trip on every
 * detail open would be slow and surprising, and every branch / PR / sync action
 * already refreshes those refs. `null` whenever the question does not apply (no
 * branch yet) or cannot be answered (refs unresolvable).
 */
async function readMainlineAhead(
  workspacePath: string,
  delivery: Delivery,
): Promise<number | null> {
  if (!delivery.branchName || !delivery.branchReady) return null
  return countCommitsAhead(
    workspacePath,
    `origin/${delivery.branchName}`,
    `origin/${delivery.baseBranch}`,
  )
}

/**
 * How far the delivery branch is ahead of `origin/<base_branch>` — the mirror of
 * `readMainlineAhead`, same fetch-free read of the LOCAL remote-tracking refs,
 * same `null` whenever the question does not apply or cannot be answered.
 * `> 0` is what proves a merge would actually ship something.
 */
async function readDeliveryBranchAhead(
  workspacePath: string,
  delivery: Delivery,
): Promise<number | null> {
  if (!delivery.branchName || !delivery.branchReady) return null
  return countCommitsAhead(
    workspacePath,
    `origin/${delivery.baseBranch}`,
    `origin/${delivery.branchName}`,
  )
}

export const listDeliveriesHandler: Handler<'list_deliveries'> = (ctx, conn, msg) => {
  if (!isStoreAvailable()) {
    conn.send({ type: 'error', error: { code: 'delivery.dbUnavailable' } })
    return
  }
  const abs = resolveWorkspaceRoot(msg.workspaceName)
  if (!abs) {
    conn.send({
      type: 'error',
      error: { code: 'workspace.unknown', params: { id: msg.workspaceName } },
    })
    return
  }
  const items = listDeliveries(abs)
  conn.send({
    type: 'deliveries',
    workspaceName: msg.workspaceName,
    items,
    needsActionCount: countDeliveriesNeedingAction(items, (d) => deliveryMergeActionable(abs, d)),
  })
}

export const createDeliveryHandler: Handler<'create_delivery'> = (ctx, conn, msg) => {
  if (!isStoreAvailable()) {
    conn.send({ type: 'error', error: { code: 'delivery.dbUnavailable' } })
    return
  }
  const abs = resolveWorkspaceRoot(msg.workspaceName)
  if (!abs) {
    conn.send({
      type: 'error',
      error: { code: 'workspace.unknown', params: { id: msg.workspaceName } },
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
      actor: conn.subject ?? 'system',
    })
    conn.send({
      type: 'create_delivery_result',
      workspaceName: msg.workspaceName,
      delivery,
      prMergeNotice,
    })
    ctx.broadcastDeliveries(abs)
    publishDeliveryEvent(ctx, abs, 'created', {
      deliveryId: delivery.id,
      title: delivery.title,
      baseBranch: delivery.baseBranch,
    })
  } catch (err) {
    conn.send({
      type: 'error',
      error: { code: 'delivery.createFailed', params: { detail: String(err) } },
    })
  }
}

export const getDeliveryDetailHandler: Handler<'get_delivery_detail'> = async (_ctx, conn, msg) => {
  if (!isStoreAvailable()) {
    conn.send({ type: 'error', error: { code: 'delivery.dbUnavailable' } })
    return
  }
  const delivery = getDelivery(msg.deliveryId)
  if (!delivery) {
    conn.send({ type: 'error', error: { code: 'delivery.notFound' } })
    return
  }
  const workspacePath = resolveWorkspaceRoot(delivery.workspaceName)
  const ahead = workspacePath ? await readMainlineAhead(workspacePath, delivery) : null
  const branchAhead = workspacePath ? await readDeliveryBranchAhead(workspacePath, delivery) : null
  conn.send(detailFrame(delivery, undefined, ahead, branchAhead))
}

/**
 * One delivery's lifecycle-log entries, newest first — the 「日志」 tab's whole
 * read path. Deliberately its own message rather than a field on
 * `delivery_detail`: every delivery write already replies with a detail frame,
 * and hanging the full trail off it would make the page's main read grow with a
 * delivery's age whether or not anyone opens the tab.
 *
 * The delivery must exist (`delivery.notFound` otherwise) and the query is
 * scoped to its id, so a caller can never read another delivery's trail through
 * this. No pagination, no filtering — the same shape as the intent changelog.
 */
export const listDeliveryLogsHandler: Handler<'list_delivery_logs'> = (_ctx, conn, msg) => {
  if (!isStoreAvailable()) {
    conn.send({ type: 'error', error: { code: 'delivery.dbUnavailable' } })
    return
  }
  if (!getDelivery(msg.deliveryId)) {
    conn.send({ type: 'error', error: { code: 'delivery.notFound' } })
    return
  }
  conn.send({
    type: 'delivery_logs_list',
    deliveryId: msg.deliveryId,
    items: listDeliveryLogs(msg.deliveryId),
  })
}

/**
 * 「同步主线」— merge `origin/<base_branch>` into the delivery branch and push.
 *
 * Gate order: store → delivery exists in this workspace → the branch is ready →
 * the delivery is still `integrating`. Only `integrating` accepts it: before that
 * there is nothing to integrate, and from `verifying` on, changing the tree is
 * exactly what invalidates the verification.
 *
 * A conflict is reported as `delivery.syncMainlineConflict` with git's own output
 * and nothing is pushed — the user resolves it, c3 never picks a resolution.
 */
export const syncDeliveryMainlineHandler: Handler<'sync_delivery_mainline'> = async (
  _ctx,
  conn,
  msg,
) => {
  if (!isStoreAvailable()) {
    conn.send({ type: 'error', error: { code: 'delivery.dbUnavailable' } })
    return
  }
  const abs = resolveWorkspaceRoot(msg.workspaceName)
  if (!abs) {
    conn.send({
      type: 'error',
      error: { code: 'workspace.unknown', params: { id: msg.workspaceName } },
    })
    return
  }
  const delivery = getDelivery(msg.deliveryId)
  if (!delivery || delivery.workspaceName !== msg.workspaceName) {
    conn.send({ type: 'error', error: { code: 'delivery.notFound' } })
    return
  }
  if (!delivery.branchName || !delivery.branchReady) {
    conn.send({ type: 'error', error: { code: 'delivery.guard.branchNotReady' } })
    return
  }
  if (delivery.status !== 'integrating') {
    conn.send({ type: 'error', error: { code: 'delivery.syncMainlineForbidden' } })
    return
  }

  const result = await syncDeliveryMainline(
    abs,
    delivery.branchName,
    delivery.baseBranch,
    (phase) =>
      conn.send({ type: 'delivery_sync_mainline_progress', deliveryId: delivery.id, phase }),
  )
  if (!result.ok) {
    conn.send({
      type: 'error',
      error: result.conflict
        ? { code: 'delivery.syncMainlineConflict', params: { detail: result.error ?? '' } }
        : { code: 'delivery.syncMainlineFailed', params: { detail: result.error ?? '' } },
    })
    return
  }
  conn.send({
    type: 'delivery_sync_mainline_result',
    deliveryId: delivery.id,
    ahead: result.ahead ?? 0,
  })
}

export const updateDeliveryHandler: Handler<'update_delivery'> = (ctx, conn, msg) => {
  if (!isStoreAvailable()) {
    conn.send({ type: 'error', error: { code: 'delivery.dbUnavailable' } })
    return
  }
  const abs = resolveWorkspaceRoot(msg.workspaceName)
  if (!abs) {
    conn.send({
      type: 'error',
      error: { code: 'workspace.unknown', params: { id: msg.workspaceName } },
    })
    return
  }
  const delivery = getDelivery(msg.deliveryId)
  if (!delivery || delivery.workspaceName !== msg.workspaceName) {
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
    const updated = updateDelivery(msg.deliveryId, input, conn.subject ?? 'system')
    if (!updated) {
      conn.send({ type: 'error', error: { code: 'delivery.notFound' } })
      return
    }
    conn.send(detailFrame(updated))
    ctx.broadcastDeliveries(abs)
  } catch (err) {
    conn.send({
      type: 'error',
      error: { code: 'delivery.updateFailed', params: { detail: String(err) } },
    })
  }
}

/**
 * One status edge, as the audit trail names it.
 *
 * The trail records what the ACTOR DID, not merely that a column moved: a human
 * confirming a verification and a human abandoning a delivery are different
 * events even though both are "status changed". Splitting them here is also what
 * keeps a single action from appearing twice on the timeline — each committed
 * edge writes exactly one line, under exactly one of these kinds.
 */
function transitionLogOperation(from: DeliveryStatus, to: DeliveryStatus): DeliveryLogOperation {
  if (to === 'cancelled') return 'cancelled'
  if (from === 'verifying' && to === 'verified') return 'verification_confirmed'
  return 'status_changed'
}

/**
 * The persisted one-line summary of a status edge, always naming both ends.
 *
 * The RAW status codes are used, not their Chinese labels: the summary is a
 * historical record that must stay readable after any copy change, and the wire
 * codes are what the rest of the ledger, the events and the logs already speak.
 * `detail` appends the cause when the caller has one (a PR number, a conflict).
 */
function transitionSummary(from: DeliveryStatus, to: DeliveryStatus, detail?: string): string {
  const edge = `状态变更: ${from} → ${to}`
  return detail ? `${edge};${detail}` : edge
}

/**
 * The one status-write core shared by `transition_delivery` and
 * `cancel_delivery`. Re-evaluates `canTransitionDelivery` from CURRENT facts
 * (a stale client plan is refused) and re-computes the plan on success.
 *
 * A committed write publishes `delivery:status_changed` with the edge, plus
 * `delivery:cancelled` when the target is the abandonment terminal.
 */
function applyTransition(
  ctx: Parameters<Handler<'transition_delivery'>>[0],
  conn: Parameters<Handler<'transition_delivery'>>[1],
  workspaceName: string,
  deliveryId: string,
  to: DeliveryStatus,
  confirmVerified: boolean,
): void {
  const abs = resolveWorkspaceRoot(workspaceName)
  if (!abs) {
    conn.send({
      type: 'error',
      error: { code: 'workspace.unknown', params: { id: workspaceName } },
    })
    return
  }
  const delivery = getDelivery(deliveryId)
  if (!delivery || delivery.workspaceName !== workspaceName) {
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
  const from = delivery.status
  const updated = setDeliveryStatus(deliveryId, to, {
    operationType: transitionLogOperation(from, to),
    summary: transitionSummary(from, to),
    actor: conn.subject ?? 'system',
  })
  if (!updated) {
    conn.send({ type: 'error', error: { code: 'delivery.notFound' } })
    return
  }
  conn.send(detailFrame(updated))
  ctx.broadcastDeliveries(abs)
  publishDeliveryStatusChanged(ctx, abs, updated, from, to)
  // Terminal double-publish: `cancelled` is also its own stable fact, so a
  // subscriber that only cares about abandonment need not filter `to`.
  if (to === 'cancelled') {
    publishDeliveryEvent(ctx, abs, 'cancelled', {
      deliveryId: updated.id,
      title: updated.title,
    })
  }
}

export const transitionDeliveryHandler: Handler<'transition_delivery'> = (ctx, conn, msg) => {
  if (!isStoreAvailable()) {
    conn.send({ type: 'error', error: { code: 'delivery.dbUnavailable' } })
    return
  }
  applyTransition(
    ctx,
    conn,
    msg.workspaceName,
    msg.deliveryId,
    msg.to,
    msg.confirmVerified === true,
  )
}

export const cancelDeliveryHandler: Handler<'cancel_delivery'> = (ctx, conn, msg) => {
  if (!isStoreAvailable()) {
    conn.send({ type: 'error', error: { code: 'delivery.dbUnavailable' } })
    return
  }
  applyTransition(ctx, conn, msg.workspaceName, msg.deliveryId, 'cancelled', false)
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
  const abs = resolveWorkspaceRoot(msg.workspaceName)
  if (!abs) {
    conn.send({
      type: 'error',
      error: { code: 'workspace.unknown', params: { id: msg.workspaceName } },
    })
    return
  }
  const delivery = getDelivery(msg.deliveryId)
  if (!delivery || delivery.workspaceName !== msg.workspaceName) {
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

  // `branch_ready` announces the same fact on all three routes that flip
  // `branchReady` to 1 (create / bind / idempotent orphan adoption) — what a
  // subscriber reacts to is "the delivery branch exists now", not how it got there.
  const announceBranchReady = (ready: Delivery): void =>
    publishDeliveryEvent(ctx, abs, 'branch_ready', {
      deliveryId: ready.id,
      title: ready.title,
      branch: ready.branchName ?? branchName,
    })

  /**
   * The `false → true` edge is the ONE moment an intent's base-branch snapshot
   * may follow a delivery: an intent linked while the branch did not exist is
   * still holding the mainline snapshot, and a worktree created after this point
   * must root on the delivery branch instead. Runs on every route that flips the
   * fact, BEFORE the success frame, so a failed catch-up can never be reported
   * as a completed initialisation. Re-running it writes the same value, so the
   * idempotent shortcut above (already ready, same branch) needs none of its own.
   */
  const adoptBranchAsIntentBase = (ready: Delivery): void => {
    const adopted = adoptReadyDeliveryBranchAsIntentBase(ready.id, ready.branchName ?? branchName)
    if (adopted.length > 0) ctx.broadcastIntents(abs)
  }

  // Idempotent shortcut: already bound to this exact branch → success, no git.
  if (delivery.branchReady && delivery.branchName === branchName) {
    conn.send({ type: 'delivery_branch_init_result', workspaceName: msg.workspaceName, delivery })
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
    adoptBranchAsIntentBase(updated)
    const warning = existingHead === expectedHead ? undefined : 'delivery.branchBehindMain'
    conn.send({
      type: 'delivery_branch_init_result',
      workspaceName: msg.workspaceName,
      delivery: updated,
      ...(warning ? { warning } : {}),
    })
    ctx.broadcastDeliveries(abs)
    announceBranchReady(updated)
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
      adoptBranchAsIntentBase(updated)
      conn.send({
        type: 'delivery_branch_init_result',
        workspaceName: msg.workspaceName,
        delivery: updated,
      })
      ctx.broadcastDeliveries(abs)
      announceBranchReady(updated)
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
  adoptBranchAsIntentBase(updated)
  conn.send({
    type: 'delivery_branch_init_result',
    workspaceName: msg.workspaceName,
    delivery: updated,
  })
  ctx.broadcastDeliveries(abs)
  announceBranchReady(updated)
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
  const abs = resolveWorkspaceRoot(msg.workspaceName)
  if (!abs) {
    conn.send({
      type: 'error',
      error: { code: 'workspace.unknown', params: { id: msg.workspaceName } },
    })
    return
  }
  const delivery = getDelivery(msg.deliveryId)
  if (!delivery || delivery.workspaceName !== msg.workspaceName) {
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
  conn.send(detailFrame(updated))
  ctx.broadcastDeliveries(abs)
}

// ---------------------------------------------------------------------------
// Intent ↔ delivery association
// ---------------------------------------------------------------------------

/**
 * Resolve + validate the (workspace, delivery, intent) triple both association
 * handlers start from. Sends the error frame itself and returns `null` so the
 * caller can `return` immediately; the guards are identical on purpose — a link
 * and an unlink must agree on what "these two belong together" means.
 */
function resolveAssociation(
  conn: Conn,
  workspaceName: string,
  deliveryId: string,
  intentId: string,
): { abs: string; delivery: Delivery; pr: IntentPr | null } | null {
  const abs = resolveWorkspaceRoot(workspaceName)
  if (!abs) {
    conn.send({
      type: 'error',
      error: { code: 'workspace.unknown', params: { id: workspaceName } },
    })
    return null
  }
  const delivery = getDelivery(deliveryId)
  if (!delivery || delivery.workspaceName !== workspaceName) {
    conn.send({ type: 'error', error: { code: 'delivery.notFound' } })
    return null
  }
  const intent = getIntent(intentId)
  if (!intent || intent.workspaceName !== workspaceName) {
    conn.send({ type: 'error', error: { code: 'intent.notFound' } })
    return null
  }
  // The intent's PR toward THIS delivery — the only PR either handler may act on.
  return { abs, delivery, pr: intent.prs.find((p) => p.deliveryId === deliveryId) ?? null }
}

/**
 * How an intent is named in the delivery's audit trail: its title, or its id
 * when the title is empty (a blank intent created straight into a delivery has
 * one). A row that says which intent it was about is the whole point — falling
 * back to the id keeps that true without inventing a name.
 */
function intentLabel(title: string | undefined, intentId: string): string {
  return title?.trim() ? title.trim() : intentId
}

/**
 * Link an intent to a delivery: insert the association edge, then warn (never
 * refuse) when the intent's commits would make the resulting PR's diff bloated.
 *
 * A FIRST link also re-takes the intent's base-branch snapshot as this
 * delivery's branch — atomically with the edge, so the ledger can never hold one
 * without the other. Everything else about the snapshot is deliberately absent:
 * a second link keeps the existing value, and an unready branch writes nothing.
 *
 * Deliberately NOT done here: re-targeting an existing delivery-less PR at this
 * delivery. Linking establishes the edge only; moving a PR's base is a separate,
 * later capability, and silently re-basing an open PR is not something a link
 * click should do.
 */
export const linkIntentToDeliveryHandler: Handler<'link_intent_to_delivery'> = async (
  ctx,
  conn,
  msg,
) => {
  if (!isStoreAvailable()) {
    conn.send({ type: 'error', error: { code: 'delivery.dbUnavailable' } })
    return
  }
  const resolved = resolveAssociation(conn, msg.workspaceName, msg.deliveryId, msg.intentId)
  if (!resolved) return
  const { abs, delivery } = resolved
  const intent = getIntent(msg.intentId)
  const latestCommitHash = intent?.latestCommitHash ?? null

  const readyBranch = delivery.branchReady ? (delivery.branchName?.trim() ?? null) : null

  let inserted: boolean
  try {
    inserted = insertIntentDelivery(msg.deliveryId, msg.intentId, readyBranch, {
      operationType: 'intent_linked',
      summary: `关联意图: ${intentLabel(intent?.title, msg.intentId)}`,
      actor: conn.subject ?? 'system',
    })
  } catch (err) {
    // Two very different causes reach here, and the ledger itself separates them:
    // if the edge EXISTS, the unique index fired on a concurrent link and the
    // user's verdict is the same as losing the in-transaction check. If it does
    // NOT exist, the transaction rolled back (e.g. the audit write failed) and
    // calling that 「已关联」 would be a plain lie about what the ledger holds.
    console.warn(`[delivery] link_intent_to_delivery 插入失败: ${String(err)}`)
    conn.send({
      type: 'error',
      error: isIntentLinked(msg.deliveryId, msg.intentId)
        ? { code: 'delivery.intentAlreadyLinked' }
        : { code: 'delivery.linkFailed', params: { detail: String(err) } },
    })
    return
  }
  if (!inserted) {
    conn.send({ type: 'error', error: { code: 'delivery.intentAlreadyLinked' } })
    return
  }

  // Observational only: a git failure (no repo, missing ref, no remote) must not
  // undo a link the ledger already accepted.
  let bloated = false
  if (latestCommitHash) {
    try {
      bloated = await detectDeliveryDiffBloat(
        abs,
        latestCommitHash,
        delivery.baseBranch,
        delivery.branchName,
      )
    } catch (err) {
      console.warn(`[delivery] diff 膨胀检测跳过: ${String(err)}`)
    }
  }

  const fresh = getDelivery(msg.deliveryId)
  if (!fresh) {
    conn.send({ type: 'error', error: { code: 'delivery.notFound' } })
    return
  }
  conn.send(detailFrame(fresh, bloated ? 'delivery.diffBloat' : undefined))
  ctx.broadcastDeliveries(abs)
  // The intent side renders `linkedDeliveries` + PRs grouped by delivery, so the
  // same write has to reach it.
  ctx.broadcastIntents(abs)
}

/**
 * Unlink an intent from a delivery. The PR toward this delivery decides whether
 * the unlink may happen at all:
 *
 * 1. Local `merged` → refused outright.
 * 2. Otherwise the forge is asked for the LIVE state. A remotely-merged PR the
 *    ledger has not caught up with is the exact black hole this guard exists for:
 *    the code is already on the delivery branch, so dropping the edge would leave
 *    the association gone and the code in, with only a revert to undo it. On that
 *    verdict the local row is synced to `merged` too, so every later attempt is
 *    refused by step 1 without another round trip.
 * 3. A forge lookup that FAILS blocks the unlink — "cannot confirm it is not
 *    merged" is treated as "may be merged", never as "probably fine".
 * 4. Only a confirmed-unmerged PR is closed, and only a successful close lets the
 *    edge and the PR row go. A close failure aborts the whole unlink.
 *
 * Dropping the LAST link returns the intent's base-branch snapshot to the
 * workspace mainline, in the same transaction as the edge removal. Every refusal
 * above leaves both untouched — a guard that stops the unlink must not move what
 * the intent is built on.
 */
export const unlinkIntentFromDeliveryHandler: Handler<'unlink_intent_from_delivery'> = async (
  ctx,
  conn,
  msg,
) => {
  if (!isStoreAvailable()) {
    conn.send({ type: 'error', error: { code: 'delivery.dbUnavailable' } })
    return
  }
  const resolved = resolveAssociation(conn, msg.workspaceName, msg.deliveryId, msg.intentId)
  if (!resolved) return
  const { abs, pr } = resolved

  if (pr) {
    if (pr.status === 'merged') {
      conn.send({ type: 'error', error: { code: 'delivery.unlinkMergedPrDenied' } })
      return
    }
    // The row's own forge wins; the workspace override only covers rows written
    // before the origin was persisted (same rule as intent cancellation).
    const forge = pr.forge ?? getForgeOverride(abs)
    const live = await getForgePrStatus(abs, pr.number, forge)
    if (!live.ok) {
      conn.send({
        type: 'error',
        error: {
          code: 'delivery.unlinkPrStatusCheckFailed',
          params: { detail: live.error ?? '无法读取 PR 状态' },
        },
      })
      return
    }
    if (live.status === 'merged') {
      upsertIntentPr({
        intentId: msg.intentId,
        deliveryId: msg.deliveryId,
        forge: pr.forge,
        repo: pr.repo,
        number: pr.number,
        status: 'merged',
      })
      // The merge just observed may be the intent's last open PR — settle its
      // status here too, so the refusal below is not the only thing this pass
      // records about a finished intent.
      completeIntentOnPrsMerged(abs, msg.intentId)
      ctx.broadcastIntents(abs)
      conn.send({ type: 'error', error: { code: 'delivery.unlinkMergedPrDenied' } })
      return
    }
    // Confirmed not merged. An already-closed PR is absorbed as success inside
    // `closeForgePr`, so the `closed` live state needs no special case here.
    const close = await closeForgePr(abs, pr.number, forge)
    if (!close.ok) {
      conn.send({
        type: 'error',
        error: {
          code: 'delivery.unlinkClosePrFailed',
          params: { detail: close.error ?? '关闭 PR 失败' },
        },
      })
      return
    }
  }

  // The PR row, the edge, the base-branch snapshot and the audit line drop
  // TOGETHER — every forge round trip is already behind us, so what is left is
  // purely local and has no excuse to land in pieces.
  deleteIntentDelivery(
    msg.deliveryId,
    msg.intentId,
    resolveWorkspaceBaseBranch(abs),
    {
      operationType: 'intent_unlinked',
      summary: `解除关联意图: ${intentLabel(getIntent(msg.intentId)?.title, msg.intentId)}`,
      actor: conn.subject ?? 'system',
    },
    pr !== null,
  )

  const fresh = getDelivery(msg.deliveryId)
  if (!fresh) {
    conn.send({ type: 'error', error: { code: 'delivery.notFound' } })
    return
  }
  conn.send(detailFrame(fresh))
  ctx.broadcastDeliveries(abs)
  ctx.broadcastIntents(abs)
}

// ---------------------------------------------------------------------------
// Delivery PR — 「交付分支 → 主线」, the change request a human merges on the forge
//
// c3 never merges it. Going through a PR buys CI, review, protected branches and
// diff review for free, and makes the whole action idempotent on the forge's own
// terms. What c3 owns is the LEDGER side: opening the PR without ever duplicating
// it, and settling what the forge says about it — layered, because "cannot merge"
// has three causes that must not be treated alike.
// ---------------------------------------------------------------------------

/**
 * Resolve + gate the (workspace, delivery) pair both delivery-PR handlers start
 * from. Sends the error frame itself and returns `null` so the caller can
 * `return` immediately.
 *
 * `requireVerified` is the one difference between them: creating a delivery PR
 * proposes a VERIFIED delivery for mainline, while syncing an existing PR must
 * keep working from any status the PR outlived — including `verifying` after a
 * conflict rollback and `delivered` after the merge landed.
 */
function resolveDeliveryPrContext(
  conn: Conn,
  workspaceName: string,
  deliveryId: string,
  requireVerified: boolean,
): { abs: string; delivery: Delivery } | null {
  const abs = resolveWorkspaceRoot(workspaceName)
  if (!abs) {
    conn.send({
      type: 'error',
      error: { code: 'workspace.unknown', params: { id: workspaceName } },
    })
    return null
  }
  const delivery = getDelivery(deliveryId)
  if (!delivery || delivery.workspaceName !== workspaceName) {
    conn.send({ type: 'error', error: { code: 'delivery.notFound' } })
    return null
  }
  // `current-branch` has no delivery branch, so there is no head to propose.
  if (getGitBranchMode(abs) !== 'worktree') {
    conn.send({ type: 'error', error: { code: 'delivery.deliveryPrModeUnsupported' } })
    return null
  }
  if (requireVerified && delivery.status !== 'verified') {
    conn.send({ type: 'error', error: { code: 'delivery.deliveryPrForbidden' } })
    return null
  }
  if (!delivery.branchName || !delivery.branchReady) {
    conn.send({ type: 'error', error: { code: 'delivery.guard.branchNotReady' } })
    return null
  }
  return { abs, delivery }
}

/**
 * Open the delivery PR (「交付分支 → `base_branch`」), or adopt the one the forge
 * already holds.
 *
 * Gate order is fixed: `worktree` mode → `verified` → branch ready → the delivery
 * branch actually holds commits mainline does not. The last one is what refuses a
 * delivery branch someone already merged by hand — an empty PR explains nothing.
 *
 * Then, and this is the whole point of the retry contract: the FORGE is asked
 * first. An open PR for the same `(head, base)` is adopted into the ledger; only
 * when the forge holds none is one created. That single ordering covers both
 * "created successfully but the response was lost" and "the ledger row is gone",
 * and it is why a local return code is never taken as proof. A forge lookup that
 * FAILS aborts — creating on an unanswered question is how duplicates are born.
 */
export const createDeliveryPrHandler: Handler<'create_delivery_pr'> = async (ctx, conn, msg) => {
  if (!isStoreAvailable()) {
    conn.send({ type: 'error', error: { code: 'delivery.dbUnavailable' } })
    return
  }
  const resolved = resolveDeliveryPrContext(conn, msg.workspaceName, msg.deliveryId, true)
  if (!resolved) return
  const { abs, delivery } = resolved
  const branchName = delivery.branchName!

  const fail = (detail: string): void =>
    conn.send({
      type: 'error',
      error: { code: 'delivery.deliveryPrCreateFailed', params: { detail } },
    })

  // Both refs are fetched before anything is decided: `base_sha` / `head_sha` are
  // the idempotency key's own material, so reading them off stale local refs
  // would key the row to a state that no longer exists on the remote.
  const baseRef = await fetchRemoteBaseAsync(abs, delivery.baseBranch)
  if (!baseRef) {
    fail(`无法 fetch 基线分支 ${delivery.baseBranch}(离线或无远端)`)
    return
  }
  const headRef = await fetchRemoteBaseAsync(abs, branchName)
  if (!headRef) {
    fail(`无法 fetch 交付分支 ${branchName}(离线或无远端)`)
    return
  }
  const baseSha = await resolveRefHead(abs, baseRef)
  const headSha = await resolveRefHead(abs, headRef)
  if (!baseSha || !headSha) {
    fail(`远端引用 ${baseRef} / ${headRef} 无法解析`)
    return
  }

  const ahead = await countCommitsAhead(abs, baseRef, headRef)
  if (ahead === null) {
    fail(`远端引用 ${baseRef} / ${headRef} 无法比较`)
    return
  }
  if (ahead === 0) {
    // 「没有可提的差异」有两个成因,处置完全相反。分支承载的产出已经进主线(有人
    // 在 c3 之外合了)是「已交付」这个事实本身 —— 拿不出 PR 恰恰因为交付已经完成,
    // 让用户卡在 verified 上既没有 PR 可建、又因 `delivered` 是系统专属边而无法
    // 人工推进,是个死结。分支上压根没有产出才是真的「无事可提」。
    if (!deliveryOutputIntegrated(delivery)) {
      conn.send({ type: 'error', error: { code: 'delivery.deliveryPrNoDiff' } })
      return
    }
    await settleDeliveryLanded(ctx, conn, abs, delivery, { baseSha, headSha })
    return
  }

  const forgeOverride = getForgeOverride(abs)
  const existing = await findOpenForgePr(abs, branchName, delivery.baseBranch, forgeOverride)
  if (!existing.ok) {
    fail(existing.error ?? '无法向 forge 查询开放 PR')
    return
  }

  let number: string
  let url: string | null
  if (existing.pr) {
    number = existing.pr.number
    url = existing.pr.url
  } else {
    const created = await createForgePr(
      abs,
      `交付: ${delivery.title}`,
      buildDeliveryPrBody(delivery),
      branchName,
      delivery.baseBranch,
      forgeOverride,
    )
    if (!created.ok || !created.prId) {
      fail(created.error ?? '创建交付 PR 失败')
      return
    }
    number = created.prId
    url = created.prUrl ?? null
  }

  const identity = parsePrIdentity(url)
  try {
    upsertDeliveryPr({
      deliveryId: delivery.id,
      forge: identity.forge ?? forgeOverride ?? null,
      repo: identity.repo,
      number,
      url,
      headBranch: branchName,
      baseBranch: delivery.baseBranch,
      baseSha,
      headSha,
      status: 'reviewing',
    })
  } catch (err) {
    // A concurrent create won the unique index. The PR itself exists either way —
    // the next attempt reads the forge, finds it and adopts the winner's row.
    fail(`交付 PR 已创建但台账写入失败,请重试: ${String(err)}`)
    return
  }
  insertDeliveryLog(
    delivery.id,
    'delivery_pr_opened',
    `交付 PR #${number}: ${branchName} → ${delivery.baseBranch}`,
    conn.subject ?? 'system',
  )

  const fresh = getDelivery(delivery.id)
  if (!fresh) {
    conn.send({ type: 'error', error: { code: 'delivery.notFound' } })
    return
  }
  conn.send(
    detailFrame(
      fresh,
      undefined,
      await readMainlineAhead(abs, fresh),
      await readDeliveryBranchAhead(abs, fresh),
    ),
  )
  ctx.broadcastDeliveries(abs)
  // Created and forge-first adopted are the SAME fact for a subscriber — 「交付 PR
  // 已就绪」 — so the idempotent adoption publishes too. `sync_delivery_pr` does
  // not: it reports on a PR that was already announced.
  publishDeliveryEvent(ctx, abs, 'pr_created', {
    deliveryId: fresh.id,
    title: fresh.title,
    prNumber: number,
    ...(url ? { prUrl: url } : {}),
    baseBranch: fresh.baseBranch,
  })
}

/** The delivery PR's body — what the delivery is, in the reviewer's own view. */
function buildDeliveryPrBody(delivery: Delivery): string {
  const lines = [`交付「${delivery.title}」合入主线。`, '']
  if (delivery.description.trim()) lines.push(delivery.description.trim(), '')
  lines.push(
    `集成就绪: ${delivery.integration.merged}/${delivery.integration.total}`,
    `交付分支: ${delivery.branchName ?? ''} → ${delivery.baseBranch}`,
  )
  return lines.join('\n')
}

/**
 * Pull the delivery PR's live facts and settle them, LAYERED.
 *
 * | forge 事实      | 交付状态                | 落库                           |
 * | --------------- | ----------------------- | ------------------------------ |
 * | merged          | `→ delivered` (原子写)  | 状态 + 交付日志 + PR 行         |
 * | open + 冲突     | `verified → verifying`  | 冲突文件 + SHA 快照            |
 * | open + CI/审批  | 不变                    | `blocked_reason`               |
 * | open 无阻塞     | 不变                    | 清空 `blocked_reason`          |
 * | closed          | 不变                    | 行状态同步                     |
 * | 查询失败        | 不变                    | 无                             |
 *
 * The conflict rollback and the CI/approval stay-put are the same decision seen
 * from two sides: a conflict means the integrated code must change, so the
 * verification it earned is genuinely void; a failing check or a missing approval
 * says nothing about the code, and rolling back there would make the user redo a
 * verification for no reason.
 *
 * Both status writes go through `canTransitionDelivery` with `role: 'system'`, so
 * the state machine stays the single gate. This does not contradict 「开发会话不
 * 改状态」: that rule constrains development sessions, not an asynchronous
 * terminal callback about a merge that already happened.
 */
export const syncDeliveryPrHandler: Handler<'sync_delivery_pr'> = async (ctx, conn, msg) => {
  if (!isStoreAvailable()) {
    conn.send({ type: 'error', error: { code: 'delivery.dbUnavailable' } })
    return
  }
  const resolved = resolveDeliveryPrContext(conn, msg.workspaceName, msg.deliveryId, false)
  if (!resolved) return
  const { abs, delivery } = resolved

  const pr = getLatestDeliveryPr(delivery.id)
  if (!pr) {
    conn.send({ type: 'error', error: { code: 'delivery.deliveryPrNotFound' } })
    return
  }

  const facts = await getForgeDeliveryPrFacts(abs, pr.number, pr.forge ?? getForgeOverride(abs))
  if (!facts.ok || !facts.status) {
    // An unreadable forge is not evidence about the PR: nothing moves, and the
    // page offers a retry.
    conn.send({
      type: 'error',
      error: {
        code: 'delivery.deliveryPrSyncFailed',
        params: { detail: facts.error ?? '无法读取交付 PR 状态' },
      },
    })
    return
  }

  const finish = (updated: Delivery): void => {
    conn.send(detailFrame(updated))
    ctx.broadcastDeliveries(abs)
  }

  if (facts.status === 'merged') {
    await settleDeliveryDelivered(ctx, conn, abs, delivery, pr.number, facts.prUrl ?? pr.url)
    return
  }

  if (facts.status === 'closed') {
    updateDeliveryPrFacts(delivery.id, {
      status: 'closed',
      url: facts.prUrl ?? undefined,
      blockedReason: null,
    })
    // A closed PR normally means 「这条 PR 作废了」 — but it also covers 「PR 关了,
    // 代码另行合进主线了」. Git decides which: when the delivery branch holds
    // nothing mainline does not, the delivery IS delivered, and leaving it at
    // `verified` would strand it (no PR to reopen, no human edge to `delivered`).
    if (delivery.status !== 'delivered' && (await probeMainlineLanding(abs, delivery))) {
      // No PR identity travels with this settle: THIS PR is closed, and naming it
      // as the one that merged would tell every subscriber something untrue.
      await settleDeliveryDelivered(ctx, conn, abs, delivery, null, null, {
        markPrMerged: false,
        notice: 'delivery.autoDelivered',
      })
      return
    }
    finish(getDelivery(delivery.id) ?? delivery)
    return
  }

  // Open. Conflict first — it is the only verdict that moves the delivery.
  if (facts.conflict) {
    const trial = await deliveryMergeTrial(abs, delivery.branchName!, delivery.baseBranch)
    const prFacts = {
      status: 'reviewing' as const,
      url: facts.prUrl ?? undefined,
      blockedReason: null,
      baseSha: trial.baseSha,
      headSha: trial.headSha,
      conflictFiles: trial.conflictFiles,
    }
    if (delivery.status !== 'verified') {
      // Already rolled back by an earlier sync (or never `verified`): refresh the
      // conflict evidence without asking the state machine for a no-op edge.
      updateDeliveryPrFacts(delivery.id, prFacts)
      finish(getDelivery(delivery.id) ?? delivery)
      return
    }
    const verdict = canTransitionDelivery({
      from: delivery.status,
      to: 'verifying',
      role: 'system',
      branchReady: delivery.branchReady,
      integration: delivery.integration,
      confirmVerified: false,
      reason: 'merge_conflict',
    })
    if (!verdict.ok) {
      conn.send({
        type: 'delivery_transition_failed',
        deliveryId: delivery.id,
        code: verdict.code,
        reasons: verdict.reasons,
        currentStatus: delivery.status,
        to: 'verifying',
      })
      return
    }
    const updated = commitDeliveryMergeConflict(
      delivery.id,
      prFacts,
      transitionSummary(
        delivery.status,
        'verifying',
        trial.conflictFiles.length > 0
          ? `交付 PR #${pr.number} 合并冲突,冲突文件 ${trial.conflictFiles.length} 个`
          : `交付 PR #${pr.number} 合并冲突`,
      ),
      'system',
    )
    if (!updated) {
      conn.send({ type: 'error', error: { code: 'delivery.notFound' } })
      return
    }
    finish(updated)
    publishDeliveryStatusChanged(ctx, abs, updated, delivery.status, 'verifying')
    return
  }

  updateDeliveryPrFacts(delivery.id, {
    status: 'reviewing',
    url: facts.prUrl ?? undefined,
    // CI first: a red pipeline is the concrete thing to fix, and a repo that also
    // requires approvals would otherwise hide it behind 「等人批」.
    blockedReason: facts.ciFailed ? 'ci_failed' : facts.approvalMissing ? 'approval' : null,
  })
  finish(delivery)
}

/**
 * Whether the delivery branch ever CARRIED integrated output — every associated
 * intent's PR toward this delivery is merged, and there is at least one.
 *
 * This is what separates 「产出已经进主线」 from 「这条分支上什么都没有」 when git
 * reports no commits ahead of mainline: both look identical to `git rev-list`,
 * because a delivery branch that was never written to sits exactly on its fork
 * point. The ledger is the only place that difference is recorded.
 */
function deliveryOutputIntegrated(delivery: Delivery): boolean {
  const { total, merged } = delivery.integration
  return total > 0 && merged === total
}

/**
 * Whether the delivery branch's commits are ALREADY reachable from mainline —
 * asked with fresh remote refs, because a stale local ref would answer about a
 * state that no longer exists.
 *
 * Fetch failures answer `false`: an unreachable remote is not evidence that
 * anything was merged, and this verdict only ever ADDS a terminal write.
 */
async function probeMainlineLanding(workspacePath: string, delivery: Delivery): Promise<boolean> {
  if (!delivery.branchName || !deliveryOutputIntegrated(delivery)) return false
  const baseRef = await fetchRemoteBaseAsync(workspacePath, delivery.baseBranch)
  const headRef = await fetchRemoteBaseAsync(workspacePath, delivery.branchName)
  if (!baseRef || !headRef) return false
  return (await countCommitsAhead(workspacePath, baseRef, headRef)) === 0
}

/**
 * Settle a delivery whose branch reached mainline WITHOUT c3 opening (or merging)
 * the PR itself — someone merged it by hand, or through a PR c3 never recorded.
 *
 * The forge is still asked for the merged PR of the same (head, base), purely to
 * ENRICH the record: a lookup that fails or finds nothing never blocks the
 * terminal write, because git already proved the code is in mainline and the
 * whole point of this path is that the user has no other way out — `delivered` is
 * a system-only edge, so nobody can move it by hand.
 *
 * `shas` is passed when the caller already resolved the ref pair (the create path
 * did, as its idempotency key); without it the PR row is left alone rather than
 * keyed to SHAs read a second time.
 */
async function settleDeliveryLanded(
  ctx: KernelContext,
  conn: Conn,
  workspacePath: string,
  delivery: Delivery,
  shas: { baseSha: string; headSha: string } | null,
): Promise<void> {
  const forgeOverride = getForgeOverride(workspacePath)
  const branchName = delivery.branchName ?? ''
  const merged = await findMergedForgePr(
    workspacePath,
    branchName,
    delivery.baseBranch,
    forgeOverride,
  )
  const mergedPr = merged.ok ? (merged.pr ?? null) : null
  if (mergedPr && shas) {
    const identity = parsePrIdentity(mergedPr.url)
    try {
      upsertDeliveryPr({
        deliveryId: delivery.id,
        forge: identity.forge ?? forgeOverride ?? null,
        repo: identity.repo,
        number: mergedPr.number,
        url: mergedPr.url,
        headBranch: branchName,
        baseBranch: delivery.baseBranch,
        baseSha: shas.baseSha,
        headSha: shas.headSha,
        status: 'merged',
      })
    } catch (err) {
      // The ledger row is a record OF the merge, not the merge itself: losing the
      // race for it must not cost the delivery its terminal status.
      console.warn(`[delivery] 已合并交付 PR 落账失败: ${String(err)}`)
    }
  }
  await settleDeliveryDelivered(
    ctx,
    conn,
    workspacePath,
    delivery,
    mergedPr?.number ?? null,
    mergedPr?.url ?? null,
    // The row is only rewritten to `merged` when this run actually identified a
    // merged PR — a genuinely closed PR row must keep saying so.
    { markPrMerged: mergedPr !== null, notice: 'delivery.autoDelivered' },
  )
}

/**
 * Land `delivered` and everything that follows from it.
 *
 * The status write and the delivery log are ONE transaction — a delivery whose
 * code is in mainline but whose ledger says nothing about it is exactly the drift
 * this action exists to prevent. Everything after the commit is a CONSEQUENCE of
 * a fact that is already true, so a failure there never un-delivers anything:
 *
 *  1. the associated intents are NOT touched — they went `done` when their PRs
 *     merged into the delivery branch, and rewriting them here would give status
 *     a second driver;
 *  2. the cross-delivery dependency gate is recomputed (`markQueueDirty`), because
 *     its verdict reads `delivered`: skipping it would leave every intent blocked
 *     on this delivery blocked forever;
 *  3. `delivery:status_changed` and `delivery:delivered` both go out on the
 *     generic event pipeline (the trail and the terminal fact);
 *  4. the delivery log line was already written inside the transaction.
 */
async function settleDeliveryDelivered(
  ctx: KernelContext,
  conn: Conn,
  workspacePath: string,
  delivery: Delivery,
  prNumber: string | null,
  prUrl: string | null,
  options: { markPrMerged?: boolean; notice?: 'delivery.autoDelivered' } = {},
): Promise<void> {
  const markPrMerged = options.markPrMerged ?? true
  if (delivery.status === 'delivered') {
    // A repeat sync of an already-settled delivery: refresh the row and stop.
    if (markPrMerged) {
      updateDeliveryPrFacts(delivery.id, {
        status: 'merged',
        url: prUrl ?? undefined,
        blockedReason: null,
      })
    }
    conn.send(detailFrame(delivery))
    return
  }
  const verdict = canTransitionDelivery({
    from: delivery.status,
    to: 'delivered',
    role: 'system',
    branchReady: delivery.branchReady,
    integration: delivery.integration,
    confirmVerified: false,
    mergeSucceeded: true,
  })
  if (!verdict.ok) {
    conn.send({
      type: 'delivery_transition_failed',
      deliveryId: delivery.id,
      code: verdict.code,
      reasons: verdict.reasons,
      currentStatus: delivery.status,
      to: 'delivered',
    })
    return
  }
  const updated = commitDeliveryDelivered(
    delivery.id,
    transitionSummary(
      delivery.status,
      'delivered',
      prNumber
        ? `交付 PR #${prNumber} 已合入 ${delivery.baseBranch}`
        : `交付分支 ${delivery.branchName ?? ''} 的产出已在 ${delivery.baseBranch} 上`,
    ),
    'system',
    markPrMerged,
  )
  if (!updated) {
    conn.send({ type: 'error', error: { code: 'delivery.notFound' } })
    return
  }
  if (prUrl && markPrMerged)
    updateDeliveryPrFacts(delivery.id, { status: 'merged', url: prUrl, blockedReason: null })

  // Terminal double-publish: the transition trail AND the terminal fact.
  publishDeliveryStatusChanged(ctx, workspacePath, updated, delivery.status, 'delivered')
  publishDeliveryDelivered(ctx, workspacePath, updated, prNumber, prUrl)
  // Fire-and-forget: the queue recomputes every tick anyway, and the manual paths
  // read live facts — the worst case of a failure here is one tick of latency.
  void markQueueDirty(workspacePath)

  conn.send(detailFrame(updated, undefined, null, null, options.notice))
  ctx.broadcastDeliveries(workspacePath)
  // The intent side renders the dependency gate off `delivered`, so the unblocked
  // intents have to reach it too.
  ctx.broadcastIntents(workspacePath)
}

// ---------------------------------------------------------------------------
// Delivery lifecycle events (`delivery:*`)
//
// Every one is a SYSTEM-OBSERVED FACT published on the generic event pipeline
// (`ctx.normalizeEvent` → `eventBus.publish('event')`), so an automation can
// subscribe to the delivery lifecycle the same way it subscribes to anything
// else. Deliberately NOT `pr:*`: that category carries an automation's own PR
// operation, and reusing it for a delivery fact would drift what its existing
// subscribers agreed to react to.
//
// Publishing happens AFTER the status write has committed and never rolls it
// back: a failure only logs a warning and does not block the broadcast or the
// dependency-gate recompute. The fact is already true — refusing to announce it
// cannot make it untrue.
// ---------------------------------------------------------------------------

/** The delivery lifecycle actions published as `delivery:<action>`. */
type DeliveryEventAction =
  'created' | 'status_changed' | 'branch_ready' | 'pr_created' | 'delivered' | 'cancelled'

/** Normalize + publish one `delivery:<action>` event; a failure only warns. */
function publishDeliveryEvent(
  ctx: KernelContext,
  workspacePath: string,
  action: DeliveryEventAction,
  metadata: Record<string, string>,
): void {
  const type = `delivery:${action}`
  const res = ctx.normalizeEvent({ type, metadata })
  if (!res.ok) {
    console.warn(`[delivery] ${type} 事件未发布: ${res.reason}`)
    return
  }
  ctx.eventBus.publish('event', {
    workspacePath,
    sessionId: randomUUID(),
    event: res.event,
  })
}

/**
 * Publish `delivery:status_changed` for one committed status write, carrying the
 * edge as `from` / `to`. Called on EVERY status write — the human transitions,
 * the cancellation, the conflict rollback and the terminal `delivered` landing —
 * so a `delivery:*` subscriber can reconstruct the whole trail.
 */
function publishDeliveryStatusChanged(
  ctx: KernelContext,
  workspacePath: string,
  delivery: Delivery,
  from: DeliveryStatus,
  to: DeliveryStatus,
): void {
  publishDeliveryEvent(ctx, workspacePath, 'status_changed', {
    deliveryId: delivery.id,
    title: delivery.title,
    from,
    to,
  })
  if (to === 'verifying') {
    maybePublishDeliveryReviewRequired(delivery.id, delivery.updatedAt)
  }
}

/**
 * Publish `delivery:delivered` — the terminal fact that the delivery PR merged
 * and the delivery reached mainline. Published ALONGSIDE the `status_changed`
 * for the same edge, never instead of it.
 */
function publishDeliveryDelivered(
  ctx: KernelContext,
  workspacePath: string,
  delivery: Delivery,
  prNumber: string | null,
  prUrl: string | null,
): void {
  publishDeliveryEvent(ctx, workspacePath, 'delivered', {
    deliveryId: delivery.id,
    title: delivery.title,
    baseBranch: delivery.baseBranch,
    branch: delivery.branchName ?? '',
    // Absent when the delivery branch reached mainline outside a PR c3 can name —
    // 「已交付」 is true either way, and inventing a number would be worse than
    // omitting one.
    ...(prNumber ? { prNumber } : {}),
    ...(prUrl ? { prUrl } : {}),
  })
}
