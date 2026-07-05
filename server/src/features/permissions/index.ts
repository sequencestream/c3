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
  // Clear the pending-prompt guard first so the run's eventual `turn_end` can
  // settle to idle (the prompt is now decided).
  resolvePending(msg.requestId)
  // Carry the responding connection's authenticated subject into the decision so
  // the `save_intents` gate can attribute `intent_logs.actor` to the human who
  // approved. Server-authoritative: taken from `conn.subject`, never the client
  // message body (which has no such field). `null` when unauthenticated / auth
  // disabled ⇒ downstream falls back to `'system'`, unchanged.
  registerPermissionResolver.resolve(msg.requestId, msg.decision, msg.answers, conn.subject)

  // Resolve the matching wait-user-involve event (graceful: no event → no-op).
  const event = getEventByRequestId(msg.requestId)
  if (!event) return

  const status = msg.decision === 'allow' ? 'done' : 'canceled'
  updateStatus(event.id, status)

  // Broadcast the refreshed 'todo' list so every connection's pending-items
  // panel updates in real time (WorkCenter tab, session tab, sidebar badge).
  ctx.broadcastWaitUserEvents(resolveWorkspaceRoot(event.workspaceId)!)
}
