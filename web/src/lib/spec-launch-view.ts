import type { SpecLaunchStage } from '@ccc/shared/protocol'

export const SPEC_LAUNCH_MIN_DWELL_MS = 500
export const SPEC_LAUNCH_SAFETY_TIMEOUT_MS = 60_000
export type SpecLaunchPhase = SpecLaunchStage | 'ready' | 'failed'
export const SPEC_LAUNCH_STEPS = [
  'checking-dependencies',
  'pulling-code',
  'launching-session',
] as const
export type SpecLaunchStep = (typeof SPEC_LAUNCH_STEPS)[number]
export type SpecLaunchStepStatus = 'pending' | 'active' | 'done'
export interface SpecLaunchModel {
  intentId: string
  phase: SpecLaunchPhase
  startedAt: number
  visibleAt: number
  pendingCloseReason?: 'ready' | 'failed'
}
export type SpecLaunchEvent =
  | { kind: 'stage'; intentId: string; stage: SpecLaunchStage; now: number }
  | { kind: 'ready'; intentId: string; now: number }
  | { kind: 'failed'; now: number }
  | { kind: 'dwell-complete'; now: number }
  | { kind: 'timeout'; now: number }
export interface SpecLaunchTransition {
  model: SpecLaunchModel | null
  closedReason?: 'ready' | 'failed' | 'timeout'
}
export function beginSpecLaunch(intentId: string, now: number): SpecLaunchModel {
  return { intentId, phase: 'checking-dependencies', startedAt: now, visibleAt: now }
}
function settle(
  model: SpecLaunchModel,
  reason: 'ready' | 'failed',
  now: number,
): SpecLaunchTransition {
  if (model.pendingCloseReason) return { model }
  if (now - model.visibleAt >= SPEC_LAUNCH_MIN_DWELL_MS)
    return { model: null, closedReason: reason }
  return { model: { ...model, phase: reason, pendingCloseReason: reason } }
}
export function reduceSpecLaunch(
  model: SpecLaunchModel | null,
  ev: SpecLaunchEvent,
): SpecLaunchTransition {
  if (!model) return { model: null }
  if (ev.kind === 'stage') {
    if (ev.intentId !== model.intentId || model.pendingCloseReason) return { model }
    return ev.stage === 'failed'
      ? settle(model, 'failed', ev.now)
      : { model: { ...model, phase: ev.stage } }
  }
  if (ev.kind === 'ready')
    return ev.intentId === model.intentId ? settle(model, 'ready', ev.now) : { model }
  if (ev.kind === 'failed') return settle(model, 'failed', ev.now)
  if (ev.kind === 'dwell-complete') {
    return model.pendingCloseReason && ev.now - model.visibleAt >= SPEC_LAUNCH_MIN_DWELL_MS
      ? { model: null, closedReason: model.pendingCloseReason }
      : { model }
  }
  return ev.now - model.startedAt >= SPEC_LAUNCH_SAFETY_TIMEOUT_MS
    ? { model: null, closedReason: 'timeout' }
    : { model }
}
export function specLaunchStepStatuses(phase: SpecLaunchPhase): SpecLaunchStepStatus[] {
  const active =
    phase === 'checking-dependencies'
      ? 0
      : phase === 'pulling-code'
        ? 1
        : phase === 'launching'
          ? 2
          : phase === 'ready'
            ? 3
            : -1
  return SPEC_LAUNCH_STEPS.map((_, i) =>
    active < 0 ? 'pending' : i < active ? 'done' : i === active ? 'active' : 'pending',
  )
}
