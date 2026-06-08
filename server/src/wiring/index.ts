/**
 * `wiring/` barrel — server refactor 3/3e-2.
 *
 * The server-only assembly layer. The composition root (`server.ts`)
 * constructs a `Broadcaster` and threads it through these factories; the
 * returned objects are placed on `KernelContext` and consumed by feature
 * handlers + the run launcher.
 *
 * `wiring/` is NOT a kernel module: it imports features (to read their
 * stores) and the broadcaster (the single egress). `kernel/` is the
 * inverse — feature-free, no broadcaster calls (ADR-0009 R1/R2/R6).
 */
export { createBroadcasts, type Broadcasts, type BroadcastsDeps } from './broadcasts.js'
export { makeRunDevTurn, type DevTurnDeps } from './dev-turn.js'
export {
  createDiscussionRuns,
  type DiscussionRuns,
  type DiscussionRunsDeps,
} from './discussion-runs.js'
export { createWsHandler } from './ws-upgrade.js'
export { mountStaticAssets, mountDevPlaceholder } from './static-assets.js'
export { startSchedulerWiring, stopSchedulerWiring } from './scheduler-startup.js'
export { registerRunDomainSubscriptions } from './run-domain-subscriptions.js'
