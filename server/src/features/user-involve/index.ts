/**
 * `wait_user_involve` feature handlers.
 *
 * Currently a single handler for listing events; the event-creation and lifecycle
 * hooks will be added in the next intent.
 */
import { isStoreAvailable, listEvents } from './store.js'
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
    conn.send({ type: 'wait_user_events', items: [] })
    return
  }
  const items = listEvents(workspacePath, msg.status)
  conn.send({ type: 'wait_user_events', items })
}
