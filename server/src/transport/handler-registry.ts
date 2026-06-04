/**
 * Handler registry — slice 1/3 of the server refactor (ADR-0009).
 *
 * The structural centerpiece that replaces the 40+ case `switch`. A
 * `Record<ClientToServer['type'], Handler>` is exhaustive by construction:
 * omitting any message type is a COMPILE-TIME error (`pnpm typecheck` red).
 * `assertExhaustive` is the runtime backstop for a protocol type added without
 * a handler.
 *
 * `transport/` MAY import from `kernel/` (the boundary is one-directional:
 * kernel must not import transport — ADR-0009 R1).
 */
import type { ClientToServer, ServerToClient } from '@ccc/shared/protocol'
import type { AppContext } from '../kernel/types.js'

/**
 * A connection is a *view* (ADR-0006): it holds which session it watches and
 * how to deliver to its socket. Mutable `viewing` and the per-connection
 * helpers live here (transport), not on the kernel `AppContext`.
 */
export interface Conn {
  /** Send one wire frame to this connection's socket. */
  send: (msg: ServerToClient) => void
  /** The session id this connection currently watches (null = none). Mutable. */
  viewing: string | null
  /** This connection's stable delivery callback (added/removed as a viewer). */
  deliver: (msg: ServerToClient) => void
  /** Push the full workspace list to this connection. */
  sendWorkspaces: () => void
  /** Push a workspace's session list to this connection. */
  sendSessions: (workspacePath: string) => Promise<void>
}

/**
 * A message handler. Unified signature `(ctx, conn, msg) => void | Promise<void>`.
 * `M` narrows `msg` to the exact union member for the registered type.
 */
export type Handler<M extends ClientToServer['type'] = ClientToServer['type']> = (
  ctx: AppContext,
  conn: Conn,
  msg: Extract<ClientToServer, { type: M }>,
) => void | Promise<void>

/**
 * The exhaustive handler map. `{ [K in ClientToServer['type']]: Handler<K> }`
 * forces an entry for EVERY message type — a missing one fails typecheck.
 */
export type HandlerMap = {
  [K in ClientToServer['type']]: Handler<K>
}

/** Runtime backstop for ADR-0009: a message type with no handler is unreachable. */
export function assertExhaustive(x: never): never {
  throw new Error(`[c3] unhandled message type: ${String(x)}`)
}

export interface HandlerRegistry {
  /** Look up and run the handler for `msg.type`. */
  dispatch: (ctx: AppContext, conn: Conn, msg: ClientToServer) => void | Promise<void>
}

/**
 * Build a registry from an exhaustive `HandlerMap`. The map is assembled at
 * startup (`registerHandlers`), so a missing handler is caught by the compiler,
 * not at runtime.
 */
export function createHandlerRegistry(map: HandlerMap): HandlerRegistry {
  return {
    dispatch(ctx, conn, msg) {
      const handler = map[msg.type] as Handler | undefined
      if (!handler) {
        // Unreachable when `map` is a complete HandlerMap; guards a protocol
        // type added at runtime without a handler.
        return assertExhaustive(msg.type as never)
      }
      return handler(ctx, conn, msg)
    },
  }
}
