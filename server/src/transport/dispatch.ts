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
import type { AppContext } from '../kernel/types.js'
import type { Conn, HandlerRegistry } from './handler-registry.js'

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Parse, validate, and dispatch one raw WS frame. A malformed frame is dropped
 * silently (matches the prior `JSON.parse` try/catch `return`); a handler that
 * throws is wrapped into a uniform `error` frame rather than tearing down the
 * socket.
 */
export async function dispatch(
  reg: HandlerRegistry,
  ctx: AppContext,
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
  try {
    await reg.dispatch(ctx, conn, msg)
  } catch (err) {
    // Defensive backstop (English debug log, not a ui-code): handlers surface
    // their own domain errors; this only fires on an unexpected throw, which the
    // old uncaught `onMessage` would have rejected silently.
    console.warn(`[c3] handler '${msg.type}' threw: ${errMsg(err)}`)
  }
}
