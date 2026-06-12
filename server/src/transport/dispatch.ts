/**
 * The one-line dispatcher — slice 1/3 (ADR-0009).
 *
 * `server.ts`'s `onMessage` collapses from a 40+ case `switch` to a single
 * `await dispatch(reg, ctx, conn, raw)`. This module owns the cross-cutting
 * envelope: JSON parse, shape validation, and a uniform throw-guard so a
 * handler fault never tears down the connection.
 *
 * On a handler throw the guard logs to the server console (English debug output,
 * NOT modeled as a ui-code — see `shared/src/ui-codes.ts`) rather than minting a
 * new generic error frame. Handlers surface their OWN domain errors via the
 * registered ui-codes; this catch is the defensive backstop the old uncaught
 * `onMessage` rejection used to be.
 */
import type { ClientToServer } from '@ccc/shared/protocol'
import type { KernelContext } from '../kernel/types.js'
import type { Conn, HandlerRegistry } from './handler-registry.js'

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Message types an UNAUTHENTICATED connection may still send (ADR-0023 handshake
 * gate): the credential exchange (`login`/`logout`) and the transport heartbeat
 * (`ping`). Everything else is rejected until the handshake clears. When auth is
 * disabled the connection is marked `authed` at `onOpen`, so this gate is inert.
 */
const ALLOWED_WHEN_UNAUTHED = new Set<ClientToServer['type']>(['login', 'logout', 'ping'])

/**
 * Parse, validate, and dispatch one raw WS frame. A malformed frame is dropped
 * silently (matches the prior `JSON.parse` try/catch `return`); a handler that
 * throws is wrapped into a uniform `error` frame rather than tearing down the
 * socket.
 */
export async function dispatch(
  reg: HandlerRegistry,
  ctx: KernelContext,
  conn: Conn,
  raw: string,
): Promise<void> {
  let msg: ClientToServer
  try {
    msg = JSON.parse(raw) as ClientToServer
  } catch {
    // Unparseable frame — drop it (unchanged from the old switch's pre-parse guard).
    return
  }
  if (!msg || typeof msg !== 'object' || typeof (msg as { type?: unknown }).type !== 'string') {
    return
  }
  // Connection-level auth gate (ADR-0023): an unauthenticated connection may only
  // exchange credentials / heartbeat. Any other frame is refused with the 401-
  // analogue rather than reaching a handler. Inert when auth is disabled (the
  // connection is marked `authed` at handshake).
  if (!conn.authed && !ALLOWED_WHEN_UNAUTHED.has(msg.type)) {
    conn.send({ type: 'unauthenticated', reason: 'missing' })
    return
  }
  try {
    await reg.dispatch(ctx, conn, msg)
  } catch (err) {
    // Defensive backstop (English debug log, not a ui-code): handlers surface
    // their own domain errors; this only fires on an unexpected throw, which the
    // old uncaught `onMessage` would have rejected silently.
    console.warn(`[c3] handler '${msg.type}' threw: ${errMsg(err)}`)
  }
}
