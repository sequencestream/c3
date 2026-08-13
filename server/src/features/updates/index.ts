/**
 * `updates` feature handlers — the console's control surface over self-update.
 *
 * All three are admin-gated: staging burns bandwidth and disk, and applying
 * restarts the server out from under every connected session. The resulting
 * state is broadcast, not replied to, so every console sees the same picture.
 */
import type { Handler } from '../../transport/handler-registry.js'
import { requireAdmin } from '../auth/authz.js'
import { applySelfUpdate, cancelSelfUpdate, startSelfUpdate } from './self-update.js'

export const startSelfUpdateHandler: Handler<'start_self_update'> = (_ctx, conn) => {
  if (!requireAdmin(conn)) return
  void startSelfUpdate()
}

export const applySelfUpdateHandler: Handler<'apply_self_update'> = (_ctx, conn) => {
  if (!requireAdmin(conn)) return
  void applySelfUpdate()
}

export const cancelSelfUpdateHandler: Handler<'cancel_self_update'> = (_ctx, conn) => {
  if (!requireAdmin(conn)) return
  cancelSelfUpdate()
}
