import type { DevLaunchStage } from '@ccc/shared/protocol'

/*
 * dev-launch-view — pure decision logic for the manual `start_development`
 * startup-progress overlay.
 *
 * The overlay blocks interaction immediately while a Start-Dev launch is in
 * flight. It remains visible for a minimum dwell time to avoid flashing during
 * fast launches, then converges on every terminal signal (success / failure /
 * safety timeout) so the user is never trapped behind it.
 *
 * This module holds only the state machine + step mapping (no DOM, no timers,
 * no `send`). The control layer wires it to `setTimeout` / the message handler
 * while the decisions stay unit-testable.
 */

/** Minimum visible time for the immediately-shown overlay. */
export const DEV_LAUNCH_MIN_DWELL_MS = 500
/**
 * Hard ceiling: if no terminal signal (in_progress / failed) arrives by now,
 * close the overlay with an error so a lost/dropped signal never traps the user.
 */
export const DEV_LAUNCH_SAFETY_TIMEOUT_MS = 60_000

/**
 * The overlay's phase. The wire {@link DevLaunchStage} values plus `ready`, a
 * web-only success terminal derived from the intent flipping to `in_progress`.
 */
export type DevLaunchPhase = DevLaunchStage | 'ready'

/** The ordered, user-facing steps the overlay renders (labels live in i18n). */
export const DEV_LAUNCH_STEPS = [
  'fetch-remote-main',
  'prepare-worktree',
  'launch-session',
  'enter-session',
] as const
export type DevLaunchStep = (typeof DEV_LAUNCH_STEPS)[number]

export type StepStatus = 'pending' | 'active' | 'done'

/** The reactive overlay model the control layer holds (null = no overlay). */
export interface DevLaunchModel {
  /** The intent whose launch this overlay tracks. */
  intentId: string
  /** Current coarse phase. */
  phase: DevLaunchPhase
  /** Click time (ms epoch); drives the safety-timeout window. */
  startedAt: number
  /** When the overlay became visible (ms epoch); drives the minimum dwell window. */
  visibleAt: number
  /** The overlay is immediately visible for every manual launch. */
  visible: boolean
  /** A success or failure received before the minimum dwell period ends. */
  pendingCloseReason?: Extract<DevLaunchCloseReason, 'ready' | 'failed'>
}

/** Why the overlay closed — drives the control layer's toast (none on success). */
export type DevLaunchCloseReason = 'ready' | 'failed' | 'timeout'

/** A reducer step result: the next model (null = closed) + optional close reason. */
export interface DevLaunchTransition {
  model: DevLaunchModel | null
  closedReason?: DevLaunchCloseReason
}

/** Events the overlay state machine folds in. */
export type DevLaunchEvent =
  /** A connection-directed `dev_launch_progress` stage arrived. */
  | { kind: 'stage'; intentId: string; stage: DevLaunchStage; now: number }
  /** The target intent flipped to `in_progress` (success terminal). */
  | { kind: 'ready'; intentId: string; now: number }
  /** The minimum-dwell timer fired. */
  | { kind: 'dwell-complete'; now: number }
  /** The safety-timeout fired. */
  | { kind: 'timeout'; now: number }

/** Build the initial in-flight (visible) model for a just-clicked launch. */
export function beginDevLaunch(intentId: string, now: number): DevLaunchModel {
  return { intentId, phase: 'fetching-remote-main', startedAt: now, visibleAt: now, visible: true }
}

/** Terminal phases stop progress (the overlay closes around these). */
export function isTerminalPhase(phase: DevLaunchPhase): boolean {
  return phase === 'ready' || phase === 'failed'
}

/** Whether the elapsed time has reached the safety-timeout ceiling. */
export function isSafetyTimeoutDue(elapsedMs: number): boolean {
  return elapsedMs >= DEV_LAUNCH_SAFETY_TIMEOUT_MS
}

/** Whether the overlay has completed its minimum visible dwell. */
export function isMinimumDwellComplete(elapsedMs: number): boolean {
  return elapsedMs >= DEV_LAUNCH_MIN_DWELL_MS
}

function settleDevLaunch(
  model: DevLaunchModel,
  reason: Extract<DevLaunchCloseReason, 'ready' | 'failed'>,
  now: number,
): DevLaunchTransition {
  if (model.pendingCloseReason) return { model }
  if (isMinimumDwellComplete(now - model.visibleAt)) {
    return { model: null, closedReason: reason }
  }
  return {
    model: {
      ...model,
      ...(reason === 'failed' ? { phase: 'failed' as const } : { phase: 'ready' as const }),
      pendingCloseReason: reason,
    },
  }
}

/**
 * Index of the active step for a phase: 0/1/2 for the progress stages, the
 * step count (all done) for the resolved `ready`, -1 for `failed` (no active).
 */
function activeStepIndex(phase: DevLaunchPhase): number {
  switch (phase) {
    case 'fetching-remote-main':
      return 0
    case 'preparing-worktree':
      return 1
    case 'launching':
      return 2
    case 'ready':
      return DEV_LAUNCH_STEPS.length
    case 'failed':
      return -1
  }
}

/** Per-step status (done / active / pending) for the current phase. */
export function stepStatusesForPhase(phase: DevLaunchPhase): StepStatus[] {
  const active = activeStepIndex(phase)
  return DEV_LAUNCH_STEPS.map((_, i) => {
    if (active < 0) return 'pending'
    if (i < active) return 'done'
    if (i === active) return 'active'
    return 'pending'
  })
}

/** Fold one event into the overlay model, converging on every terminal. */
export function reduceDevLaunch(
  model: DevLaunchModel | null,
  ev: DevLaunchEvent,
): DevLaunchTransition {
  if (!model) return { model: null }
  switch (ev.kind) {
    case 'stage':
      // Ignore progress for a different intent (another tab / stale launch).
      if (ev.intentId !== model.intentId) return { model }
      // A terminal signal already arrived; hold its terminal presentation until dwell ends.
      if (model.pendingCloseReason) return { model }
      if (ev.stage === 'failed') return settleDevLaunch(model, 'failed', ev.now)
      return { model: { ...model, phase: ev.stage } }
    case 'ready':
      if (ev.intentId !== model.intentId) return { model }
      return settleDevLaunch(model, 'ready', ev.now)
    case 'dwell-complete':
      if (model.pendingCloseReason && isMinimumDwellComplete(ev.now - model.visibleAt)) {
        return { model: null, closedReason: model.pendingCloseReason }
      }
      return { model }
    case 'timeout':
      if (isSafetyTimeoutDue(ev.now - model.startedAt)) {
        return { model: null, closedReason: 'timeout' }
      }
      return { model }
  }
}
