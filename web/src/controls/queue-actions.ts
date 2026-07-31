/**
 * installQueueActions() — the automation queue page's actions.
 *
 * Opening the page fetches the detail once; every subsequent refresh arrives by
 * push (`queue_detail`) after a reconcile pass or a manual control, so the page
 * always shows the pass that actually ran rather than a local guess.
 *
 * Each control maps one-to-one onto a kernel action and is sent verbatim — the
 * client never predicts the outcome. A refused control comes back as an `error`
 * frame and surfaces through the existing intent-error path, so a control that
 * did nothing can never look like it succeeded.
 */
import type { QueueControlAction } from '@ccc/shared/protocol'
import type { AppCtx } from './types'

export function installQueueActions(ctx: AppCtx): void {
  const { send, intentsProject, queuePageOpen } = ctx

  const refresh = (): void => {
    if (!intentsProject.value) return
    send({ type: 'get_queue_detail', workspaceId: intentsProject.value })
  }

  ctx.refreshQueueDetail = refresh

  ctx.openQueuePage = (): void => {
    queuePageOpen.value = true
    refresh()
  }

  ctx.closeQueuePage = (): void => {
    queuePageOpen.value = false
  }

  ctx.queueControl = (action: QueueControlAction, intentId?: string): void => {
    if (!intentsProject.value) return
    send({
      type: 'queue_control',
      workspaceId: intentsProject.value,
      action,
      ...(intentId ? { intentId } : {}),
    })
  }
}
