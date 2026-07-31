/**
 * Queue scheduling kernel — public surface.
 *
 * Pure scheduling logic only. This directory never imports `features/` or
 * `transport/` (ADR-0009 R1); fact gathering, persistence, run launching, event
 * subscription and broadcasting are assembled outside it.
 */
export * from './types.js'
export { reconcileQueue } from './reconcile.js'
export { CoalescingDirtySet, CoalescingRunner } from './dirty-set.js'
