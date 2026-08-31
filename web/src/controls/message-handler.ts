import type { SessionRunStatus, SessionStatus } from '@ccc/shared/protocol'
import { createHandlerRegistry } from './handler-registry'
import { buildHandlerMap, createMessageHandlerLocals } from './handlers/register'
import { DASHBOARD_REFRESH_TYPES } from './handlers/shared'
import type { AppCtx } from './types'

/**
 * Install the WebSocket message router (`handleMessage`) plus its status helpers
 * onto the shared ctx. Inbound `ServerToClient` events dispatch through an
 * exhaustive per-type handler registry (compile-time complete).
 */
export function installMessageHandler(ctx: AppCtx): void {
  const locals = createMessageHandlerLocals(ctx)
  const registry = createHandlerRegistry(buildHandlerMap(ctx, locals))

  ctx.handleMessage = (msg): void => {
    registry.dispatch(ctx, msg)
    if (DASHBOARD_REFRESH_TYPES.has(msg.type)) ctx.maybeRefreshDashboard()
  }

  ctx.applyStatuses = (statuses: SessionRunStatus[]): void => {
    const prev = locals.sessionStatus.value
    for (const s of statuses) {
      if (
        s.status === 'awaiting_permission' &&
        prev[s.sessionId] !== 'awaiting_permission' &&
        s.sessionId !== locals.activeSession.value
      ) {
        ctx.notifyAwaitingPermission(s.sessionId)
      }
    }
    const next: Record<string, SessionStatus> = {}
    for (const s of statuses) next[s.sessionId] = s.status
    locals.sessionStatus.value = next
    if (locals.teamSessions.value.size) {
      const live = new Set(
        [...locals.teamSessions.value].filter((id) => {
          const st = next[id]
          return st === 'team' || st === 'running' || st === 'awaiting_permission'
        }),
      )
      if (live.size !== locals.teamSessions.value.size) locals.teamSessions.value = live
    }
    ctx.flushIfReady()
  }

  ctx.notifyAwaitingPermission = (id: string): void => {
    if (typeof Notification === 'undefined') return
    const show = (): Notification =>
      new Notification(locals.t('permission.notification.title'), {
        body: locals.t('permission.notification.body', { title: ctx.sessionTitleById(id) }),
      })
    if (Notification.permission === 'granted') show()
    else if (Notification.permission !== 'denied')
      Notification.requestPermission().then((p) => {
        if (p === 'granted') show()
      })
  }
}
