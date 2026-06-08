/**
 * `wait_user_involve` feature handlers.
 *
 * Currently a single handler for listing events; the event-creation and lifecycle
 * hooks will be added in the next intent.
 */
import { isStoreAvailable, listEvents } from './store.js'
import type { Handler } from '../../transport/handler-registry.js'

export const listWaitUserEvents: Handler<'list_wait_user_events'> = (_ctx, conn, msg) => {
  if (!isStoreAvailable()) {
    conn.send({ type: 'error', error: { code: 'waitUserInvolve.dbUnavailable' } })
    return
  }
  const items = listEvents(msg.projectPath, msg.status)
  conn.send({ type: 'wait_user_events', items })
}
