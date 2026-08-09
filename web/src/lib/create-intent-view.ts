/*
 * create-intent-view — pure decision logic for the 「增加意图」 progress overlay.
 *
 * Creating an intent WITH content is one request that runs a whole chain on the
 * server (fetch the base / delivery branch → `worktree add` → persist the intent
 * → start its owner session), which routinely takes seconds and can take tens of
 * them. The overlay blocks interaction from the submit onwards (no double-submit,
 * no mid-flight navigation) and names the stage the user is waiting on. It
 * converges on every terminal — the create result, a refusal, or the safety
 * timeout — so nobody is trapped behind it.
 *
 * `create_intent` carries no progress frames and no echoed token, so the stages
 * are approximated on a fixed client cadence: the reducer advances one step once
 * the current one has been shown for `CREATE_INTENT_STAGE_DWELL_MS`, and parks on
 * the last one until a terminal arrives. The displayed stage is therefore a
 * plausible narration of the server's chain, not a measurement of it — the
 * deliberate trade for leaving the protocol and the server untouched.
 *
 * Correlation rests on the single-flight guard plus the blocking overlay: while
 * one create is in flight a second cannot be started, so any terminal that
 * belongs to a create IS this one's. Unrelated error frames are filtered by the
 * caller (only the create refusal codes reach here) and the safety timeout backs
 * up the case where nothing ever arrives.
 *
 * Like `create-pr-view` / `dev-launch-view`, this module holds only the state
 * machine + step mapping (no DOM, no timers, no `send`): the control layer owns
 * the effects while the decisions stay unit-testable.
 */

/** Minimum visible time for the immediately-shown overlay (anti-flash). */
export const CREATE_INTENT_MIN_DWELL_MS = 500
/**
 * Hard ceiling: with no terminal by now, close the overlay with a hint. This
 * releases the UI only — the server task keeps running and the `intents`
 * broadcast remains the source of truth for whether the intent was created.
 */
export const CREATE_INTENT_SAFETY_TIMEOUT_MS = 120_000
/** How long each approximated stage is shown before the next one lights up. */
export const CREATE_INTENT_STAGE_DWELL_MS = 1_000

/** The ordered, user-facing steps the overlay renders (labels live in i18n). */
export const CREATE_INTENT_STEPS = [
  'fetch-branch',
  'prepare-worktree',
  'create-intent',
  'open-session',
] as const
export type CreateIntentStep = (typeof CREATE_INTENT_STEPS)[number]

export type CreateIntentStepStatus = 'pending' | 'active' | 'done'

/** The overlay's phase: the step being narrated, or one of the two terminals. */
export type CreateIntentPhase = CreateIntentStep | 'done' | 'failed'

/** The reactive overlay model the control layer holds (null = no overlay). */
export interface CreateIntentModel {
  /** Current coarse phase. */
  phase: CreateIntentPhase
  /** Submit time (ms epoch); drives the safety-timeout window. */
  startedAt: number
  /** When the overlay became visible (ms epoch); drives the minimum dwell window. */
  visibleAt: number
  /** When the current step lit up (ms epoch); drives the stage cadence. */
  stageAt: number
  /** A terminal received before the minimum dwell period ended. */
  pendingCloseReason?: Extract<CreateIntentCloseReason, 'done' | 'failed'>
}

/** Why the overlay closed. */
export type CreateIntentCloseReason = 'done' | 'failed' | 'timeout'

/** A reducer step result: the next model (null = closed) + optional close reason. */
export interface CreateIntentTransition {
  model: CreateIntentModel | null
  closedReason?: CreateIntentCloseReason
}

/** Events the overlay state machine folds in. */
export type CreateIntentEvent =
  /** The stage-cadence timer ticked. */
  | { kind: 'advance'; now: number }
  /** `create_intent_result` arrived (success terminal). */
  | { kind: 'done'; now: number }
  /**
   * A create refusal arrived (failure terminal). It carries the error's code and
   * its already-translated message so the control layer can decide whether the
   * user still needs a toast — see {@link shouldToastCreateIntentFailure}.
   */
  | { kind: 'failed'; code: string; message: string; now: number }
  /** The minimum-dwell timer fired. */
  | { kind: 'dwell-complete'; now: number }
  /** The safety-timeout fired. */
  | { kind: 'timeout'; now: number }

/** Build the initial visible model for a just-submitted intent creation. */
export function beginCreateIntent(now: number): CreateIntentModel {
  return { phase: CREATE_INTENT_STEPS[0], startedAt: now, visibleAt: now, stageAt: now }
}

/** Whether the elapsed time has reached the safety-timeout ceiling. */
export function isCreateIntentTimeoutDue(elapsedMs: number): boolean {
  return elapsedMs >= CREATE_INTENT_SAFETY_TIMEOUT_MS
}

/** Whether the overlay has completed its minimum visible dwell. */
export function isCreateIntentDwellComplete(elapsedMs: number): boolean {
  return elapsedMs >= CREATE_INTENT_MIN_DWELL_MS
}

/**
 * Whether a failure closing the overlay still needs a toast of its own. Refusals
 * under `intent.` are already spelled out by the global intent-action error
 * dialog and `agent.` ones already toast, so repeating them would report the same
 * refusal twice; `workspace.` / `delivery.` refusals have no other presentation
 * on the intents page (it is not a chat stream), so the overlay's close is the
 * only place the user can learn why the creation stopped.
 */
export function shouldToastCreateIntentFailure(code: string): boolean {
  return !code.startsWith('intent.') && !code.startsWith('agent.')
}

/**
 * Index of the active step: 0..3 while narrating, the step count (all done) for
 * `done`, -1 for `failed` (no step is active while the error shows).
 */
function activeStepIndex(phase: CreateIntentPhase): number {
  if (phase === 'done') return CREATE_INTENT_STEPS.length
  if (phase === 'failed') return -1
  return CREATE_INTENT_STEPS.indexOf(phase)
}

/** Per-step status (done / active / pending) for the current phase. */
export function createIntentStepStatuses(phase: CreateIntentPhase): CreateIntentStepStatus[] {
  const active = activeStepIndex(phase)
  return CREATE_INTENT_STEPS.map((_, i) => {
    if (active < 0) return 'pending'
    if (i < active) return 'done'
    if (i === active) return 'active'
    return 'pending'
  })
}

function settleCreateIntent(
  model: CreateIntentModel,
  reason: Extract<CreateIntentCloseReason, 'done' | 'failed'>,
  now: number,
): CreateIntentTransition {
  // First terminal wins: a later one must not restart the dwell or re-close.
  if (model.pendingCloseReason) return { model }
  if (isCreateIntentDwellComplete(now - model.visibleAt)) {
    return { model: null, closedReason: reason }
  }
  return { model: { ...model, phase: reason, pendingCloseReason: reason } }
}

/** Fold one event into the overlay model, converging on every terminal. */
export function reduceCreateIntent(
  model: CreateIntentModel | null,
  ev: CreateIntentEvent,
): CreateIntentTransition {
  if (!model) return { model: null }
  switch (ev.kind) {
    case 'advance': {
      // A terminal already arrived; hold its presentation until the dwell ends.
      if (model.pendingCloseReason) return { model }
      const current = activeStepIndex(model.phase)
      // The last step is where the wait actually ends: park there rather than
      // claiming a completion the client cannot observe.
      if (current < 0 || current >= CREATE_INTENT_STEPS.length - 1) return { model }
      // An early tick (a shared timer, a re-armed one) must not skip a step ahead
      // of its dwell — the cadence is the only thing making the narration legible.
      if (ev.now - model.stageAt < CREATE_INTENT_STAGE_DWELL_MS) return { model }
      return { model: { ...model, phase: CREATE_INTENT_STEPS[current + 1], stageAt: ev.now } }
    }
    case 'done':
      return settleCreateIntent(model, 'done', ev.now)
    case 'failed':
      return settleCreateIntent(model, 'failed', ev.now)
    case 'dwell-complete':
      if (model.pendingCloseReason && isCreateIntentDwellComplete(ev.now - model.visibleAt)) {
        return { model: null, closedReason: model.pendingCloseReason }
      }
      return { model }
    case 'timeout':
      if (isCreateIntentTimeoutDue(ev.now - model.startedAt)) {
        return { model: null, closedReason: 'timeout' }
      }
      return { model }
  }
}
