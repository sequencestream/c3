/**
 * The two EXPLICIT exits from a worktree whose baseline no longer contains the
 * delivery branch it should be rooted at.
 *
 * They exist as separate, user-invoked actions rather than as a step inside the
 * launch because neither is safe to do on someone's behalf: a rebuild destroys
 * uncommitted work, and a merge rewrites a branch the user owns. The launch only
 * ever DETECTS the mismatch (`worktree-baseline.ts`) and refuses; what happens
 * next is a decision, and this is where that decision is executed.
 *
 * Neither exit is reachable by the automation queue, and neither is covered by
 * the dependency gate's force-release: that override is for advice, this block is
 * about not losing work.
 */
import type { Handler } from '../../transport/handler-registry.js'
import { resolveWorkspaceRoot } from '../../state.js'
import { getIntent, isStoreAvailable } from './store.js'
import { impliedDeliveryContextId } from './delivery-context.js'
import { getDelivery } from '../deliveries/store.js'
import { resolveWorktreeBaseline } from './worktree-baseline.js'
import {
  getWorktreePath,
  mergeRefIntoWorktree,
  rebuildIntentWorktree,
  worktreeExists,
} from './worktree.js'

export const repairIntentWorktree: Handler<'repair_intent_worktree'> = (ctx, conn, msg) => {
  const workspacePath = resolveWorkspaceRoot(msg.workspaceId)
  if (!workspacePath) {
    conn.send({
      type: 'error',
      error: { code: 'workspace.unknown', params: { workspaceId: msg.workspaceId } },
    })
    return
  }
  if (!isStoreAvailable()) {
    conn.send({ type: 'error', error: { code: 'intent.dbUnavailable' } })
    return
  }
  const intent = getIntent(msg.intentId)
  if (!intent) {
    conn.send({ type: 'error', error: { code: 'intent.notFound' } })
    return
  }

  // Same context resolution the launch used, so the repair targets the branch the
  // refusal actually named. An explicit id must still be one the intent is linked
  // to — a repair is not a way to reach a delivery a launch could not.
  const deliveryId = msg.deliveryId ?? impliedDeliveryContextId(intent)
  if (deliveryId !== null && !intent.linkedDeliveries.some((d) => d.id === deliveryId)) {
    conn.send({ type: 'error', error: { code: 'intent.deliveryContextNotLinked' } })
    return
  }
  const baseline = resolveWorktreeBaseline(
    workspacePath,
    intent,
    deliveryId ? getDelivery(deliveryId) : null,
  )

  if (msg.mode === 'rebuild') {
    const removed = rebuildIntentWorktree(workspacePath, msg.intentId, intent.branchName)
    if (!removed.ok) {
      conn.send({
        type: 'error',
        error:
          removed.reason === 'dirty'
            ? { code: 'intent.worktreeDirty' }
            : { code: 'intent.worktreeRepairFailed', params: { message: removed.message ?? '' } },
      })
      return
    }
    ctx.broadcastIntents(workspacePath)
    conn.send({ type: 'intent_worktree_repair_result', intentId: msg.intentId, mode: 'rebuild' })
    return
  }

  // Merge: only ever the just-fetched REMOTE tip. Merging a stale local ref would
  // quietly produce a worktree that still does not contain the baseline.
  const worktreePath = getWorktreePath(workspacePath, msg.intentId)
  if (!baseline.remoteRef || !worktreeExists(worktreePath)) {
    conn.send({
      type: 'error',
      error: {
        code: 'intent.worktreeRepairFailed',
        params: { message: '基准分支远端引用不可解析' },
      },
    })
    return
  }
  const merged = mergeRefIntoWorktree(worktreePath, baseline.remoteRef)
  if (!merged.ok) {
    conn.send({
      type: 'error',
      error: { code: 'intent.worktreeRepairFailed', params: { message: merged.message } },
    })
    return
  }
  conn.send({ type: 'intent_worktree_repair_result', intentId: msg.intentId, mode: 'merge' })
}
