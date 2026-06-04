/**
 * `permissions` feature handler — slice 1/3 (ADR-0009).
 */
import { resolvePending } from '../../runs.js'
import { registerPermissionResolver } from '../../claude.js'
import type { Handler } from '../../transport/handler-registry.js'

export const permissionResponse: Handler<'permission_response'> = (_ctx, _conn, msg) => {
  // Clear the pending-prompt guard first so the run's eventual `turn_end` can
  // settle to idle (the prompt is now decided).
  resolvePending(msg.requestId)
  registerPermissionResolver.resolve(msg.requestId, msg.decision, msg.answers)
}
