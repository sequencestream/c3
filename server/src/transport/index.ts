/**
 * `transport/` barrel — slice 1/3 (ADR-0009).
 *
 * WebSocket/HTTP plumbing: the handler registry, the one-line dispatcher, the
 * connection-side broadcaster. `transport/` MAY import from `kernel/`; the
 * reverse is forbidden (R1).
 */
export type { Conn, Handler, HandlerMap, HandlerRegistry } from './handler-registry.js'
export { createHandlerRegistry, assertExhaustive } from './handler-registry.js'
export { dispatch } from './dispatch.js'
export type { Broadcaster, Deliver } from './broadcaster.js'
export { createBroadcaster } from './broadcaster.js'
