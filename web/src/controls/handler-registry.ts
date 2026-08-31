/**
 * Client-side handler registry — mirror of server ADR-0009 for `ServerToClient`.
 *
 * `{ [K in ServerToClient['type']]: Handler<K> }` is exhaustive by construction:
 * omitting any message type is a compile-time error (`pnpm typecheck` red).
 */
import type { ServerToClient } from '@ccc/shared/protocol'
import type { AppCtx } from './types'

/** A message handler. `M` narrows `msg` to the exact union member for the registered type. */
export type Handler<M extends ServerToClient['type'] = ServerToClient['type']> = (
  ctx: AppCtx,
  msg: Extract<ServerToClient, { type: M }>,
) => void

/** The exhaustive handler map — a missing entry fails typecheck. */
export type HandlerMap = {
  [K in ServerToClient['type']]: Handler<K>
}

/** Runtime backstop: a message type with no handler is unreachable. */
export function assertExhaustive(x: never): never {
  throw new Error(`[c3] unhandled message type: ${String(x)}`)
}

export interface HandlerRegistry {
  dispatch: (ctx: AppCtx, msg: ServerToClient) => void
}

/** Build a registry from an exhaustive `HandlerMap`. */
export function createHandlerRegistry(map: HandlerMap): HandlerRegistry {
  return {
    dispatch(ctx, msg) {
      const handler = map[msg.type] as Handler | undefined
      if (!handler) {
        return assertExhaustive(msg.type as never)
      }
      handler(ctx, msg)
    },
  }
}
