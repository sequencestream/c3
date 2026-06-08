/**
 * `permissions` feature handler — slice 1/3 (ADR-0009).
 *
 * Auto-resolves the corresponding WaitUserInvolveEvent when a permission
 * prompt is answered: `allow` → `done`, `deny` → `canceled`. Broadcasts
 * the refreshed todo list so the pending-items panel updates in real time.
 */
import { resolvePending } from '../../runs.js'
import { registerPermissionResolver } from '../../kernel/permission/index.js'
import type { Handler } from '../../transport/handler-registry.js'
import { getEventByRequestId, updateStatus } from '../user-involve/store.js'

export const permissionResponse: Handler<'permission_response'> = (ctx, _conn, msg) => {
  // Clear the pending-prompt guard first so the run's eventual `turn_end` can
  // settle to idle (the prompt is now decided).
  resolvePending(msg.requestId)
  registerPermissionResolver.resolve(msg.requestId, msg.decision, msg.answers)

  // Resolve the matching wait-user-involve event (graceful: no event → no-op).
  const event = getEventByRequestId(msg.requestId)
  if (!event) return

  const status = msg.decision === 'allow' ? 'done' : 'canceled'
  updateStatus(event.id, status)

  // Broadcast the refreshed 'todo' list so every connection's pending-items
  // panel updates in real time (WorkCenter tab, session tab, sidebar badge).
  ctx.broadcastWaitUserEvents(event.projectPath)
}
