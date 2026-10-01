/**
 * Feed the delivery domain's actionable ID set into the badge projection.
 * The projection does not decide which deliveries need action.
 */
import { pathToName } from '../../state.js'
import { badgeProjection } from '../../kernel/activity/index.js'
import { listDeliveries } from './store.js'
import { listDeliveriesNeedingAction } from './state-machine.js'
import { deliveryMergeActionable } from './merge-attention.js'

export function syncDeliveryAttention(workspacePath: string): void {
  const workspaceName = pathToName(workspacePath)
  if (!workspaceName) return
  const items = listDeliveries(workspacePath)
  badgeProjection.setAttentionMembers(
    'delivery',
    workspaceName,
    listDeliveriesNeedingAction(items, (d) => deliveryMergeActionable(workspacePath, d)),
  )
}
