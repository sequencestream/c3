import type { DevLaunchStage } from '@ccc/shared/protocol'

/*
 * dev-launch-view — pure decision logic for the manual `start_development`
 * startup-progress overlay.
 *
 * The overlay blocks interaction while a Start-Dev launch is in flight, but only
 * once it outlasts a threshold (a fast launch shows nothing). It steps through a
 * fixed ordered list mapped from the backend's coarse {@link DevLaunchStage}
 * phases, and converges on every terminal signal (success / failure / safety
 * timeout) so the user is never trapped behind it.
 *
 * This module holds only the state machine + step mapping (no DOM, no timers,
 * no `send`). The control layer wires it to `setTimeout` / the message handler
 * while the decisions stay unit-testable.
 */

/** Delay before a still-in-flight launch reveals the overlay (>5s per spec). */
export const DEV_LAUNCH_THRESHOLD_MS = 5_000
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
export const DEV_LAUNCH_STEPS = ['prepare-workspace', 'launch-session', 'enter-session'] as const
export type DevLaunchStep = (typeof DEV_LAUNCH_STEPS)[number]

export type StepStatus = 'pending' | 'active' | 'done'

/** The reactive overlay model the control layer holds (null = no overlay). */
export interface DevLaunchModel {
  /** The intent whose launch this overlay tracks. */
  intentId: string
  /** Current coarse phase. */
  phase: DevLaunchPhase
  /** Click time (ms epoch); drives the threshold + safety-timeout windows. */
  startedAt: number
  /** Whether the threshold has elapsed and the overlay is actually shown. */
  visible: boolean
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
  /** A timer/visibility tick: reveal the overlay if the threshold has elapsed. */
  | { kind: 'tick'; now: number }
  /** A connection-directed `dev_launch_progress` stage arrived. */
  | { kind: 'stage'; intentId: string; stage: DevLaunchStage }
  /** The target intent flipped to `in_progress` (success terminal). */
  | { kind: 'ready'; intentId: string }
  /** The safety-timeout fired. */
  | { kind: 'timeout'; now: number }

/** Build the initial in-flight (hidden) model for a just-clicked launch. */
export function beginDevLaunch(intentId: string, now: number): DevLaunchModel {
  return { intentId, phase: 'preparing-workspace', startedAt: now, visible: false }
}

/** Whether a still-in-flight launch has outlasted the reveal threshold. */
export function shouldRevealOverlay(elapsedMs: number, inFlight: boolean): boolean {
  return inFlight && elapsedMs >= DEV_LAUNCH_THRESHOLD_MS
}

/** Terminal phases stop progress (the overlay closes around these). */
export function isTerminalPhase(phase: DevLaunchPhase): boolean {
  return phase === 'ready' || phase === 'failed'
}

/** Whether the elapsed time has reached the safety-timeout ceiling. */
export function isSafetyTimeoutDue(elapsedMs: number): boolean {
  return elapsedMs >= DEV_LAUNCH_SAFETY_TIMEOUT_MS
}

/**
 * Index of the active step for a phase: 0/1 for the two progress stages, the
 * step count (all done) for the resolved `ready`, -1 for `failed` (no active).
 */
function activeStepIndex(phase: DevLaunchPhase): number {
  switch (phase) {
    case 'preparing-workspace':
      return 0
    case 'launching':
      return 1
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
    case 'tick':
      if (!model.visible && shouldRevealOverlay(ev.now - model.startedAt, true)) {
        return { model: { ...model, visible: true } }
      }
      return { model }
    case 'stage':
      // Ignore progress for a different intent (another tab / stale launch).
      if (ev.intentId !== model.intentId) return { model }
      if (ev.stage === 'failed') return { model: null, closedReason: 'failed' }
      return { model: { ...model, phase: ev.stage } }
    case 'ready':
      if (ev.intentId !== model.intentId) return { model }
      return { model: null, closedReason: 'ready' }
    case 'timeout':
      if (isSafetyTimeoutDue(ev.now - model.startedAt)) {
        return { model: null, closedReason: 'timeout' }
      }
      return { model }
  }
}
