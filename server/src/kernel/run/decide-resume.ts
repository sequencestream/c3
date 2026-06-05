/**
 * `decideResume` — the pure run-continuation state machine (server refactor 3/3).
 *
 * The launcher (`run-lifecycle.ts`) runs one agent attempt, observes how it ended
 * (`RunOutcome`), and asks this function what to do next (`ResumeAction`). All the
 * branching that used to be tangled inside two nested loops — degradation-chain
 * stepping AND the single socket auto-resume — lives here as a pure function, so
 * the launcher's imperative shell only performs SDK calls and registry/emit side
 * effects. The socket sub-decision reuses the already-pure {@link decideSocketResume}.
 *
 * Pure: no IO, no registry, no SDK. Unit-tested directly (step/fallback/resume/
 * exhausted/stop) — see `decide-resume.test.ts`.
 */
import { decideSocketResume, type SocketManualTurnEnd, type SocketResumeContext } from './resume.js'

/** Where the cycle is: which agent attempt just ran, out of how many. */
export interface ResumeState {
  /** 0-based index of the agent attempt that just ran (into the agent chain). */
  attemptIndex: number
  /** Total agents to try (the length of the launcher's `agentsToTry`). */
  chainLength: number
}

/** How the agent attempt that just ran ended. */
export type RunOutcome =
  /** `runClaude` returned cleanly — the turn is done. */
  | { kind: 'completed' }
  /** A degradable error fired (`onDegradableError`) — try the next agent. */
  | { kind: 'degradable' }
  /** A socket disconnect fired (`onSocketDisconnect`) — resume or refuse. */
  | { kind: 'socket'; error: string; ctx: SocketResumeContext }
  /** The user stopped the run (the cycle controller aborted). */
  | { kind: 'aborted' }

/** What the launcher should do next. */
export type ResumeAction =
  /** The run succeeded; stop the cycle. */
  | { type: 'succeed' }
  /** Try the next agent in the degradation chain (at `nextIndex`). */
  | { type: 'fallback'; nextIndex: number }
  /** Socket auto-resume the SAME session once (re-run the same agent, `resume:`). */
  | { type: 'resume' }
  /** The degradation chain is spent; the launcher finalizes with `all_agents_failed`. */
  | { type: 'exhausted' }
  /** Terminal: a user stop (no `turnEnd`), or a refused socket disconnect (its `turnEnd`). */
  | { type: 'stop'; turnEnd?: SocketManualTurnEnd }

/**
 * Decide the next step after an agent attempt ends.
 *
 * - `aborted` ⇒ `stop` (user stop wins over everything; the launcher's `finalizeRun`
 *   settles the terminal `turn_end`, so no synthetic one here).
 * - `completed` ⇒ `succeed`.
 * - `degradable` ⇒ `fallback` to the next agent, or `exhausted` if this was the last.
 * - `socket` ⇒ a single same-session `resume` when {@link decideSocketResume} allows
 *   it, else `stop` carrying that decision's manual terminal `turn_end`.
 *
 * A socket disconnect is never degradable — it never advances the chain.
 */
export function decideResume(state: ResumeState, outcome: RunOutcome): ResumeAction {
  switch (outcome.kind) {
    case 'aborted':
      return { type: 'stop' }
    case 'completed':
      return { type: 'succeed' }
    case 'degradable': {
      const nextIndex = state.attemptIndex + 1
      return nextIndex < state.chainLength ? { type: 'fallback', nextIndex } : { type: 'exhausted' }
    }
    case 'socket': {
      const decision = decideSocketResume(outcome.error, outcome.ctx)
      return decision.action === 'auto-resume'
        ? { type: 'resume' }
        : { type: 'stop', turnEnd: decision.turnEnd }
    }
  }
}
