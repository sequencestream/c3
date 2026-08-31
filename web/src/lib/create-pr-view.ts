import { CREATE_PR_STAGES, type CreatePrStage } from '@ccc/shared/protocol'

/*
 * create-pr-view — pure decision logic for the manual `create_pr` progress overlay.
 *
 * Creating a PR commits, pushes and calls the forge, so it routinely runs for
 * seconds with nothing on screen. The overlay blocks interaction from the click
 * onwards (no double-submit, no mid-flight navigation) and lights the four
 * stages the server reports. It converges on every terminal — success response,
 * action error, or safety timeout — so the user is never trapped behind it.
 *
 * Terminals are accepted only from the run this overlay started, identified by
 * the `requestId` the server echoes: the connection also carries errors from
 * unrelated requests, and a run the safety timeout already released can still
 * reply long after the user clicked again. Either would otherwise tear down an
 * overlay that is legitimately waiting.
 *
 * Like `dev-launch-view`, this module holds only the state machine + step
 * mapping (no DOM, no timers, no `send`): the control layer owns the effects
 * while the decisions stay unit-testable.
 */

/** Minimum visible time for the immediately-shown overlay (anti-flash). */
export const CREATE_PR_MIN_DWELL_MS = 500
/**
 * Hard ceiling: with no terminal by now, close the overlay with a hint. This
 * releases the UI only — the server task keeps running and the intent / PR
 * broadcast remains the source of truth for whether the PR was created.
 */
export const CREATE_PR_SAFETY_TIMEOUT_MS = 120_000

/**
 * The overlay's phase: the wire {@link CreatePrStage} values plus the two
 * web-only terminals derived from the existing response / error frames.
 */
export type CreatePrPhase = CreatePrStage | 'done' | 'failed'

/** The ordered, user-facing steps the overlay renders (labels live in i18n). */
export const CREATE_PR_STEPS = ['analyze-changes', 'commit', 'push', 'create-pr'] as const
export type CreatePrStep = (typeof CREATE_PR_STEPS)[number]

export type CreatePrStepStatus = 'pending' | 'active' | 'done'

/** The reactive overlay model the control layer holds (null = no overlay). */
export interface CreatePrModel {
  /** The intent whose PR creation this overlay tracks. */
  intentId: string
  /** The delivery target this run named, when the UI could see one. */
  deliveryId?: string
  /**
   * The token sent with this run's `create_pr`, echoed back on its progress and
   * terminal frames. Every frame is matched against it, so an unrelated error on
   * the connection and a late terminal from a superseded run (same intent, older
   * click) both fall through instead of closing this overlay.
   */
  requestId: string
  /** Current coarse phase. */
  phase: CreatePrPhase
  /** Click time (ms epoch); drives the safety-timeout window. */
  startedAt: number
  /** When the overlay became visible (ms epoch); drives the minimum dwell window. */
  visibleAt: number
  /** A terminal received before the minimum dwell period ended. */
  pendingCloseReason?: Extract<CreatePrCloseReason, 'done' | 'failed'>
}

/** Why the overlay closed — only `timeout` needs a hint (failures already toast). */
export type CreatePrCloseReason = 'done' | 'failed' | 'timeout'

/** A reducer step result: the next model (null = closed) + optional close reason. */
export interface CreatePrTransition {
  model: CreatePrModel | null
  closedReason?: CreatePrCloseReason
}

/**
 * Events the overlay state machine folds in. The three server-driven ones carry
 * the frame's `requestId` (undefined when the frame had none — e.g. an error
 * raised by some other request); only an exact match with the model's token is
 * accepted.
 */
export type CreatePrEvent =
  /** A connection-directed `create_pr_progress` stage arrived. */
  | { kind: 'stage'; intentId: string; stage: CreatePrStage; requestId?: string; now: number }
  /** `create_pr_response` arrived (success terminal). */
  | { kind: 'done'; requestId?: string; now: number }
  /** An `error` frame arrived (failure terminal when it belongs to this run). */
  | { kind: 'failed'; requestId?: string; now: number }
  /** The minimum-dwell timer fired. */
  | { kind: 'dwell-complete'; now: number }
  /** The safety-timeout fired. */
  | { kind: 'timeout'; now: number }

/** Build the initial visible model for a just-clicked PR creation. */
export function beginCreatePr(
  intentId: string,
  requestId: string,
  now: number,
  deliveryId?: string,
): CreatePrModel {
  return {
    intentId,
    deliveryId,
    requestId,
    phase: 'analyzing-changes',
    startedAt: now,
    visibleAt: now,
  }
}

/** Whether the elapsed time has reached the safety-timeout ceiling. */
export function isCreatePrTimeoutDue(elapsedMs: number): boolean {
  return elapsedMs >= CREATE_PR_SAFETY_TIMEOUT_MS
}

/** Whether the overlay has completed its minimum visible dwell. */
export function isCreatePrDwellComplete(elapsedMs: number): boolean {
  return elapsedMs >= CREATE_PR_MIN_DWELL_MS
}

function settleCreatePr(
  model: CreatePrModel,
  reason: Extract<CreatePrCloseReason, 'done' | 'failed'>,
  now: number,
): CreatePrTransition {
  // First terminal wins: a later one must not restart the dwell or re-close.
  if (model.pendingCloseReason) return { model }
  if (isCreatePrDwellComplete(now - model.visibleAt)) {
    return { model: null, closedReason: reason }
  }
  return { model: { ...model, phase: reason, pendingCloseReason: reason } }
}

/**
 * Index of the active step: 0..3 for the wire stages, the step count (all done)
 * for `done`, -1 for `failed` (no step is active while the error shows).
 */
function activeStepIndex(phase: CreatePrPhase): number {
  if (phase === 'done') return CREATE_PR_STEPS.length
  if (phase === 'failed') return -1
  return CREATE_PR_STAGES.indexOf(phase)
}

/** Per-step status (done / active / pending) for the current phase. */
export function createPrStepStatuses(phase: CreatePrPhase): CreatePrStepStatus[] {
  const active = activeStepIndex(phase)
  return CREATE_PR_STEPS.map((_, i) => {
    if (active < 0) return 'pending'
    if (i < active) return 'done'
    if (i === active) return 'active'
    return 'pending'
  })
}

/** Fold one event into the overlay model, converging on every terminal. */
export function reduceCreatePr(model: CreatePrModel | null, ev: CreatePrEvent): CreatePrTransition {
  if (!model) return { model: null }
  switch (ev.kind) {
    case 'stage': {
      // Progress for another intent or another run (a retry replaced this one,
      // or a superseded run is still reporting) is not ours.
      if (ev.intentId !== model.intentId || ev.requestId !== model.requestId) return { model }
      // A terminal already arrived; hold its presentation until the dwell ends.
      if (model.pendingCloseReason) return { model }
      // Stages are one-way: a repeat or an out-of-order frame never rewinds the
      // lit step (the server de-duplicates too, this is the client-side half).
      const next = CREATE_PR_STAGES.indexOf(ev.stage)
      if (next <= activeStepIndex(model.phase)) return { model }
      return { model: { ...model, phase: ev.stage } }
    }
    // Both terminals must prove they belong to THIS run: an error frame from an
    // unrelated request carries no token, and a reply from a run the user already
    // gave up on (safety timeout, then a fresh click) carries the previous one.
    // Neither may close the overlay that is currently up.
    case 'done':
      if (ev.requestId !== model.requestId) return { model }
      return settleCreatePr(model, 'done', ev.now)
    case 'failed':
      if (ev.requestId !== model.requestId) return { model }
      return settleCreatePr(model, 'failed', ev.now)
    case 'dwell-complete':
      if (model.pendingCloseReason && isCreatePrDwellComplete(ev.now - model.visibleAt)) {
        return { model: null, closedReason: model.pendingCloseReason }
      }
      return { model }
    case 'timeout':
      if (isCreatePrTimeoutDue(ev.now - model.startedAt)) {
        return { model: null, closedReason: 'timeout' }
      }
      return { model }
  }
}
