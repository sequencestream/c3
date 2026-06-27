/**
 * `wait_user_involve` feature handlers.
 *
 * Listing + lifecycle handlers for WorkCenter wait-user-involve events.
 */
import { getEvent, isStoreAvailable, listEventsPage, updateStatus } from './store.js'
import { resolveWorkspaceRoot } from '../../state.js'
import type { Handler } from '../../transport/handler-registry.js'

export const listWaitUserEvents: Handler<'list_wait_user_events'> = (_ctx, conn, msg) => {
  if (!isStoreAvailable()) {
    conn.send({ type: 'error', error: { code: 'waitUserInvolve.dbUnavailable' } })
    return
  }
  // `workspaceId` is an opaque id on the wire; the store keys events by the resolved
  // absolute path. Resolve here — passing the id straight to `listEvents` would query
  // `workspace_path = <id>` and silently return nothing (the WorkCenter history / auto
  // re-fetch bug). An unregistered id degrades to an explicit empty snapshot.
  const workspacePath = resolveWorkspaceRoot(msg.workspaceId)
  if (!workspacePath) {
    conn.send({ type: 'wait_user_events', items: [], hasMore: false })
    return
  }
  const page = listEventsPage(
    workspacePath,
    msg.status,
    msg.cursorTime,
    msg.cursorExcludeId,
    msg.limit,
  )
  conn.send({ type: 'wait_user_events', items: page.items, hasMore: page.hasMore })
}

export const updateWaitUserEvent: Handler<'update_wait_user_event'> = (ctx, conn, msg) => {
  if (!isStoreAvailable()) {
    conn.send({ type: 'error', error: { code: 'waitUserInvolve.dbUnavailable' } })
    return
  }
  const event = getEvent(msg.id)
  if (!event || event.status !== 'todo' || msg.status === 'todo') {
    conn.send({ type: 'error', error: { code: 'waitUserInvolve.invalidStatusTransition' } })
    return
  }
  updateStatus(msg.id, msg.status)
  const workspacePath = resolveWorkspaceRoot(event.workspaceId)
  if (workspacePath) ctx.broadcastWaitUserEvents(workspacePath)
}
