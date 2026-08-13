import type { AppCtx } from './types'

// Install the self-update actions behind the header's update pill. All three are
// fire-and-forget: the server owns the state machine and broadcasts every move,
// so nothing here mirrors or predicts it locally.
export function installUpdateActions(ctx: AppCtx): void {
  const send = ctx.send

  ctx.startSelfUpdate = (): void => {
    send({ type: 'start_self_update' })
  }

  ctx.applySelfUpdate = (): void => {
    // The connection drops as soon as the server hands off its relaunch; the WS
    // client's own backoff reconnects into the new version.
    send({ type: 'apply_self_update' })
  }

  ctx.cancelSelfUpdate = (): void => {
    send({ type: 'cancel_self_update' })
  }
}
