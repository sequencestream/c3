/**
 * `permissions` feature handler — slice 1/3 (ADR-0009).
 *
 * Auto-resolves the corresponding WaitUserInvolveEvent when a permission
 * prompt is answered: `allow` → `done`, `deny` → `canceled`. Broadcasts
 * the refreshed todo list so the pending-items panel updates in real time.
 */
import { resolvePending } from '../../runs.js'
import { resolveWorkspaceRoot } from '../../state.js'
import { registerPermissionResolver } from '../../kernel/permission/index.js'
import type { Handler } from '../../transport/handler-registry.js'
import { getEventByRequestId, updateStatus } from '../user-involve/store.js'

export const permissionResponse: Handler<'permission_response'> = (ctx, conn, msg) => {
  // Carry the responding connection's authenticated subject into the decision so a
  // consumer can attribute the approval to a human. Server-authoritative: taken from
  // `conn.subject`, never the client message body (which has no such field). `null`
  // when unauthenticated / auth disabled.
  //
  // Resolve FIRST, then act on the outcome. An ask request re-validates its
  // answers server-side before the waiter resolves; a rejected answer keeps the
  // request pending (and its wait-user event `todo`) so the user can correct and
  // resubmit — nothing is settled until the answers are sound.
  const settled = registerPermissionResolver.resolve(
    msg.requestId,
    msg.decision,
    msg.answers,
    conn.subject,
  )
  if (settled.status === 'rejected') {
    // Visible error on the answering connection only; the request stays pending.
    conn.send({
      type: 'error',
      error: { code: 'permission.answersInvalid', params: { reason: settled.rejected ?? '' } },
      requestId: msg.requestId,
    })
    return
  }
  // A stale status (never registered / already resolved) proceeds: the kernel
  // approval registry gates the RUN's continuation, while the wait-user event
  // status is cosmetic — resolving it again is idempotent.

  // Clear the pending-prompt guard so the run's eventual `turn_end` can settle to
  // idle (the prompt is now decided).
  resolvePending(msg.requestId)

  // Resolve the matching wait-user-involve event (graceful: no event → no-op).
  const event = getEventByRequestId(msg.requestId)
  if (!event) return

  const status = msg.decision === 'allow' ? 'done' : 'canceled'
  updateStatus(event.id, status)

  // Broadcast the refreshed 'todo' list so every connection's pending-items
  // panel updates in real time (WorkCenter tab, session tab, sidebar badge).
  ctx.broadcastWaitUserEvents(resolveWorkspaceRoot(event.workspaceName)!)
}
