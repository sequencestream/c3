/**
 * Broadcaster shell — slice 1/3 (ADR-0009 R2).
 *
 * A thin wrapper over the live `connections` set. Slice 1 just CENTRALIZES the
 * "deliver to every connection" fan-out behind one object so the `broadcast*`
 * closures in `server.ts` have a single place to route through. The SHELL exists
 * now; slice 2/3 makes it SUBSCRIBE to a kernel event bus (so kernel emits pure
 * domain facts and transport turns them into wire frames), completing R2.
 *
 * For slice 1 there is no behavior change: `server.ts` keeps its `broadcast*`
 * closures and may (optionally) build them on top of this object's `each()`.
 */
import type { ServerToClient } from '@ccc/shared/protocol'

export type Deliver = (msg: ServerToClient) => void

export interface Broadcaster {
  /** Register a connection's deliver callback. */
  add: (deliver: Deliver) => void
  /** Drop a connection's deliver callback (on close). */
  remove: (deliver: Deliver) => void
  /** Fan one frame out to every live connection. */
  send: (msg: ServerToClient) => void
  /** Run a side effect against every live connection (for compound broadcasts). */
  each: (fn: (deliver: Deliver) => void) => void
  /** Number of live connections (diagnostics/tests). */
  size: () => number
}

/**
 * Build a Broadcaster over a fresh connection set. The returned `connections`
 * Set is the SAME object `server.ts` uses for its current per-connection
 * bookkeeping, so slice 1 wires both to one source of truth.
 */
export function createBroadcaster(connections: Set<Deliver>): Broadcaster {
  return {
    add: (deliver) => connections.add(deliver),
    remove: (deliver) => connections.delete(deliver),
    send: (msg) => {
      for (const deliver of connections) deliver(msg)
    },
    each: (fn) => {
      for (const deliver of connections) fn(deliver)
    },
    size: () => connections.size,
  }
}
