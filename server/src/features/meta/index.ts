/**
 * `meta` feature handlers — slice 1/3 (ADR-0009).
 *
 * Connection liveness + status pulls. Handlers are `(ctx, conn, msg)`; shared
 * state is reached via `ctx`, per-connection delivery via `conn` (slice 1 keeps
 * the shared state in the `server.ts` closure that `ctx` references).
 */
import { listStatuses } from '../../runs.js'
import type { Handler } from '../../transport/handler-registry.js'

export const ping: Handler<'ping'> = (_ctx, conn) => {
  conn.send({ type: 'pong' })
}

export const requestSessionStatus: Handler<'request_session_status'> = (_ctx, conn) => {
  conn.send({ type: 'session_status', statuses: listStatuses() })
}
