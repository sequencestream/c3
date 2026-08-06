import type { DeliveryStatus } from '@ccc/shared/protocol'
import type { AppCtx } from './types'

// Install delivery-tab actions (read path + create/edit/cancel/status transition)
// onto the ctx. All writes are pure local data actions this phase; the status
// machine + guards are re-evaluated server-side on every write.
export function installDeliveryActions(ctx: AppCtx): void {
  const send = ctx.send
  const {
    deliveriesProject,
    activeDeliveryId,
    activeDelivery,
    activeDeliveryPlan,
    activeDeliveryBranchInit,
    activeTab,
  } = ctx

  // Enter the delivery view for a workspace: fetch its list + badge count and
  // reset the right pane.
  ctx.openDeliveries = (path: string): void => {
    activeTab.value = 'deliveries'
    deliveriesProject.value = path
    activeDeliveryId.value = null
    activeDelivery.value = null
    activeDeliveryPlan.value = null
    ctx.persistViewMode()
    send({ type: 'list_deliveries', workspaceId: path })
  }

  // Click a delivery in the list: pull its detail (model + transition plan).
  ctx.openDelivery = (deliveryId: string): void => {
    if (deliveryId === activeDeliveryId.value) return
    activeDeliveryId.value = deliveryId
    ctx.persistViewMode()
    send({ type: 'get_delivery_detail', deliveryId })
  }

  ctx.createDelivery = (payload: {
    title: string
    description?: string
    startDate?: number | null
    endDate?: number | null
  }): void => {
    if (!deliveriesProject.value) return
    send({
      type: 'create_delivery',
      workspaceId: deliveriesProject.value,
      title: payload.title,
      description: payload.description ?? '',
      startDate: payload.startDate ?? null,
      endDate: payload.endDate ?? null,
    })
  }

  ctx.updateDelivery = (payload: {
    deliveryId: string
    title?: string
    description?: string
    startDate?: number | null
    endDate?: number | null
  }): void => {
    if (!deliveriesProject.value) return
    send({ type: 'update_delivery', workspaceId: deliveriesProject.value, ...payload })
  }

  ctx.cancelDelivery = (deliveryId: string): void => {
    if (!deliveriesProject.value) return
    send({ type: 'cancel_delivery', workspaceId: deliveriesProject.value, deliveryId })
  }

  // Mobile drill-down back from the detail pane to the delivery list.
  ctx.onDeliveryMobileBack = (targetKey: string): void => {
    if (targetKey !== 'deliveries') return
    activeDeliveryId.value = null
    activeDelivery.value = null
    activeDeliveryPlan.value = null
    ctx.persistViewMode()
  }

  // Status write for the OPEN delivery. `confirmVerified` is the explicit human
  // confirmation required by `verifying → verified`; the page can never
  // auto-advance it.
  ctx.transitionDelivery = (to: DeliveryStatus, confirmVerified?: boolean): void => {
    const id = activeDeliveryId.value
    if (!id || !deliveriesProject.value) return
    send({
      type: 'transition_delivery',
      workspaceId: deliveriesProject.value,
      deliveryId: id,
      to,
      confirmVerified: confirmVerified === true,
    })
  }

  // Explicit remote-branch init for the OPEN delivery. Set the in-flight state
  // optimistically (the button disables and the "fetching" line shows); the
  // server's progress frames advance the phase and the result/error frames clear
  // it. Create and bind share one form; the server's orphan-defense recovers a
  // failed create's push on retry.
  ctx.initDeliveryBranch = (payload: { mode: 'create' | 'bind'; branchName: string }): void => {
    const id = activeDeliveryId.value
    if (!id || !deliveriesProject.value) return
    const branchName = payload.branchName.trim()
    if (!branchName) return
    activeDeliveryBranchInit.value = { deliveryId: id, phase: 'fetching' }
    send({
      type: 'init_delivery_branch',
      workspaceId: deliveriesProject.value,
      deliveryId: id,
      branchName,
      mode: payload.mode,
    })
  }

  // Manual cleanup of a TERMINAL delivery's local branch reference. The page
  // already passed the danger ConfirmDialog; the server refuses non-terminal
  // deliveries anyway. Remote branches are never touched.
  ctx.cleanupDeliveryBranch = (deliveryId: string): void => {
    if (!deliveriesProject.value) return
    send({ type: 'cleanup_delivery_branch', workspaceId: deliveriesProject.value, deliveryId })
  }
}
