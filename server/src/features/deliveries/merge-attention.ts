/**
 * The ledger-backed half of the delivery badge: "is there a delivery-PR action
 * the user can take right now?".
 *
 * Split out of both the pure state machine (which must not read the db) and the
 * handler module (which the broadcast wiring should not have to import wholesale)
 * so the list reply and the broadcast count deliveries by the SAME rule — a badge
 * that differs between a reply and a broadcast is worse than no badge.
 */
import type { Delivery } from '@ccc/shared/protocol'
import { getGitBranchMode } from '../../kernel/config/index.js'
import { getLatestDeliveryPr } from './store.js'

/**
 * Whether this delivery has a delivery-PR action waiting for a human:
 *
 * - no PR yet (or the last one was closed) → 「创建交付 PR」;
 * - an open PR that is 「合并受阻」 → fix CI / get an approval.
 *
 * Everything else is a pure wait and stays out of the badge: an open, unblocked
 * PR is simply someone else's turn to press merge, and a PR already recorded as
 * merged means the `delivered` write is settled. Only `verified` deliveries are
 * considered — before that there is nothing to propose — and `current-branch`
 * workspaces never are, because the whole merge section is hidden there.
 */
export function deliveryMergeActionable(workspacePath: string, delivery: Delivery): boolean {
  if (delivery.status !== 'verified') return false
  if (getGitBranchMode(workspacePath) !== 'worktree') return false
  const pr = getLatestDeliveryPr(delivery.id)
  if (!pr || pr.status === 'closed') return true
  return pr.status === 'reviewing' && pr.blockedReason !== null
}
