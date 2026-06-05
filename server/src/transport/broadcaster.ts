/**
 * Broadcaster — the single broadcast egress (server refactor 2/3b, ADR-0009 R2).
 *
 * The ~12 `broadcast*` closures in `server.ts` used to each iterate the live
 * `connections` set inline (`for (const deliver of connections) deliver(frame)`).
 * Slice 2/3b collapses that to ONE object owning the connection set, with a
 * single typed egress `toAll`. Frame CONSTRUCTION stays where it is (in the
 * feature/server closures that have the domain data); only the DELIVERY funnels
 * through here.
 *
 * Scope (pragmatic, 2/3b): every current broadcast is "to every connection"
 * (`toAll`) — the frontend filters by what it is viewing. Per-run delivery is the
 * kernel's `emit`/`viewers` path (ADR-0006), NOT a broadcast, so it is untouched.
 * `toSession`/`toRun` + the view→session table are deferred to slice 3/3, where
 * the kernel event bus gives them a real consumer; adding them now would be dead
 * API.
 *
 * `toAll<K>` is constrained to `Extract<ServerToClient, { type: K }>` via the
 * type parameter so a caller cannot hand it a bare/mistyped object — the wire
 * frame is checked at the call site.
 *
 * `C3_BROADCAST_SHADOW=1` turns on a wire-frame tracer: every emitted frame's
 * type + byte length is logged, so a two-tab fan-out smoke can confirm exactly
 * what crossed the wire. Off by default — zero overhead in production.
 */
import type { ServerToClient } from '@ccc/shared/protocol'

export type Deliver = (msg: ServerToClient) => void

export interface Broadcaster {
  /** Register a connection's deliver callback (on open). */
  add: (deliver: Deliver) => void
  /** Drop a connection's deliver callback (on close). */
  remove: (deliver: Deliver) => void
  /** Fan one typed frame out to every live connection. */
  toAll: <K extends ServerToClient['type']>(frame: Extract<ServerToClient, { type: K }>) => void
  /** Number of live connections (diagnostics/tests). */
  size: () => number
}

const SHADOW = process.env.C3_BROADCAST_SHADOW === '1'

/**
 * Build a Broadcaster over a connection set. The passed `connections` Set is the
 * single source of truth for who is live; `server.ts` adds/removes through this
 * object so there is exactly one egress.
 */
export function createBroadcaster(connections: Set<Deliver>): Broadcaster {
  return {
    add: (deliver) => connections.add(deliver),
    remove: (deliver) => connections.delete(deliver),
    toAll: (frame) => {
      if (SHADOW) {
        // Wire-frame tracer for the two-tab fan-out smoke (B4). Logs the exact
        // bytes' shape so a human can confirm parity; never alters delivery.
        console.warn(`[c3:shadow] toAll ${frame.type} ${JSON.stringify(frame).length}B`)
      }
      for (const deliver of connections) deliver(frame)
    },
    size: () => connections.size,
  }
}
