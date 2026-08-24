/**
 * Wiring — `runRobotTurn`: ONE unattended turn for an IM chat robot.
 *
 * Structurally a sibling of `dev-turn.ts` (same internal-Viewer observation of
 * the runtime, same "resolve on turn_end with the last assistant text"), with
 * three deliberate differences that all follow from one fact: **nobody is
 * watching this run**. It is driven by an inbound group message, and the only
 * thing the person in the chat ever sees is the value this Promise resolves to.
 *
 *  1. A `permission_request` is NOT something to wait on. The dev turn keeps the
 *     run alive because a human is looking at the browser; here there is no such
 *     human, so a prompt is a dead end — we stop the run and settle `blocked`.
 *     (The `robot` gate is built so this should never fire; this is the second
 *     line of defence, not the first — ADR-0046.)
 *  2. A hard wall clock. An unattended turn with no upper bound is a thread that
 *     silently never answers.
 *  3. No `attach` and no team-push branch. A robot thread is strictly serial —
 *     the supervisor holds one in-flight turn per thread — so there is never a
 *     turn already running to attach to.
 *
 * Only the final assistant text leaves this module. That is what makes "only the
 * final answer is ever sent to a third-party IM cloud" a structural property
 * rather than a filter someone can misconfigure: tool calls, tool results and
 * intermediate reasoning are observed here and dropped on the floor.
 *
 * IMPORTANT (kernel boundary, ADR-0009 R1/R2/R6): this module lives in
 * `wiring/`, not `kernel/`. It reaches `runs.ts` only through public functions
 * and constructs no transport; `launchDeps` is threaded in by the composition
 * root, exactly as in `dev-turn.ts`.
 */
import { randomUUID } from 'node:crypto'
import { PENDING_SESSION_PREFIX } from '@ccc/shared/protocol'
import { launchRun, type LaunchRunDeps } from '../kernel/run/run-lifecycle.js'
import { getDefaultMode } from '../kernel/config/index.js'
import { addViewer, ensureRuntime, removeViewer, stopRun, type Viewer } from '../runs.js'

/** How a robot turn ended. */
export type RobotTurnOutcome = 'complete' | 'error' | 'blocked' | 'timeout'

/**
 * A real execution-stage event, projected for optional progress feedback. Frames
 * carry only the phase and a cumulative ordinal — never a tool name, input,
 * output, path or any content — so "progress reflects the real run" is a
 * structural property rather than a promise.
 */
export type RobotTurnProgress =
  | { kind: 'accepted' }
  | { kind: 'step_started'; step: number }
  | { kind: 'step_done'; step: number }

export interface RobotTurnResult {
  outcome: RobotTurnOutcome
  /** The bound session id — the caller persists it as the thread's session. */
  sessionId: string
  /**
   * The LAST assistant text of the turn (not a concatenation of all of them).
   * This is the only content the caller may relay to the IM platform.
   */
  lastMessage: string
  /** Diagnostic detail for the audit row; never relayed verbatim to a chat. */
  detail?: string
}

export interface RunRobotTurnInput {
  /**
   * The robot this turn belongs to. Its launch profile — system prompt,
   * disallowed tools, and the frozen write allowlist — is resolved from this id,
   * so it is part of the security contract rather than a label.
   */
  robotId: string
  /**
   * The robot's working directory — `~/.c3/robots/<name>`. Deliberately not a
   * registered workspace: a robot is not scoped to one, and this directory is
   * all local file tools can reach.
   */
  workspacePath: string
  /**
   * Call-level IM authorization for c3 L1 tools. Required for ledger access;
   * handlers re-resolve scope on every call.
   */
  imAuth: NonNullable<import('../runs.js').SessionRuntime['robotImAuth']>
  /**
   * Optional native session cache for this Conversation. Present only when the
   * supervisor verified it against the Conversation's vendor and revision.
   * Absent (or after workdir rebuild / vendor change) means `prompt` already
   * carries any database recovery seed for a fresh native session.
   */
  sessionId?: string
  /**
   * The current user question, or a database-seeded prompt when the native
   * session cache is unavailable. The supervisor owns seed formatting.
   */
  prompt: string
  /** Wall-clock ceiling for this turn. */
  maxTurnMs: number
  signal: AbortSignal
  /**
   * Optional projection of real execution stages. Called at most once per real
   * event (accepted on launch, step_started/step_done per tool event); never
   * called after the turn settles. The caller decides whether/how many reach a
   * chat — this module only reports what actually happened.
   */
  onProgress?: (frame: RobotTurnProgress) => void
}

export interface RobotTurnDeps {
  launchDeps: LaunchRunDeps
}

/**
 * Build the robot-turn runner. The returned Promise ALWAYS resolves — a robot
 * turn has no caller that could usefully handle a rejection, and every outcome
 * (including a failed launch) has to become a message in the chat.
 */
export function makeRunRobotTurn(
  deps: RobotTurnDeps,
): (input: RunRobotTurnInput) => Promise<RobotTurnResult> {
  const { launchDeps } = deps
  return (input: RunRobotTurnInput): Promise<RobotTurnResult> =>
    new Promise<RobotTurnResult>((resolveTurn) => {
      const id = input.sessionId ?? `${PENDING_SESSION_PREFIX}${randomUUID()}`
      // A robot turn is the `robot` scenario executed with no socket — `background`.
      const rt = ensureRuntime(
        id,
        input.workspacePath,
        getDefaultMode(input.workspacePath),
        [],
        'robot',
        undefined,
        'background',
      )
      // Carry the robot identity on the runtime, the way a spec review carries the
      // intent it reviews: `launchRun` resolves the robot's profile from it and
      // throws when it is missing, so a turn can never run unconstrained.
      rt.robotId = input.robotId
      rt.robotImAuth = input.imAuth

      let lastText = ''
      let settled = false
      let timer: ReturnType<typeof setTimeout> | null = null
      // Cumulative per-turn tool event ordinals for progress projection.
      let toolStarted = 0
      let toolDone = 0

      const emitProgress = (frame: RobotTurnProgress): void => {
        if (settled) return
        input.onProgress?.(frame)
      }

      const finish = (r: RobotTurnResult): void => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        removeViewer(rt.sessionId, viewer)
        resolveTurn(r)
      }

      // A stopped run still has to answer. `stopRun` makes the run wind down; the
      // outcome is decided here rather than waiting for the `turn_end` it may or
      // may not still emit.
      //
      // The already-settled check guards the run, not just the Promise: the abort
      // listener outlives the turn (an AbortSignal has no removal hook here), so
      // without it a supervisor shutdown would stop whatever run currently holds
      // this session id — potentially the NEXT turn on the same thread.
      const abandon = (outcome: RobotTurnOutcome, detail: string): void => {
        if (settled) return
        stopRun(rt.sessionId)
        finish({ outcome, sessionId: rt.sessionId, lastMessage: lastText, detail })
      }

      const viewer: Viewer = (e) => {
        if (settled) return
        if (e.type === 'assistant_text') {
          lastText = e.text
        } else if (e.type === 'tool_use') {
          toolStarted += 1
          emitProgress({ kind: 'step_started', step: toolStarted })
        } else if (e.type === 'tool_result') {
          toolDone += 1
          emitProgress({ kind: 'step_done', step: toolDone })
        } else if (e.type === 'permission_request') {
          // Nobody can answer this. Waiting would hold the thread until the wall
          // clock expires and leave the chat silent for that whole window, so the
          // turn ends now with an outcome the caller can explain.
          abandon('blocked', `permission requested for ${e.toolName}`)
        } else if (e.type === 'turn_end') {
          finish({
            outcome: e.reason === 'error' ? 'error' : 'complete',
            sessionId: rt.sessionId,
            lastMessage: lastText,
            detail: e.error,
          })
        }
      }
      addViewer(id, viewer)

      timer = setTimeout(() => abandon('timeout', `exceeded ${input.maxTurnMs}ms`), input.maxTurnMs)
      // Never hold the process open on a robot turn's timer.
      timer.unref?.()

      input.signal.addEventListener('abort', () => abandon('blocked', 'aborted'))

      // Defensive: a launcher that throws synchronously must still settle the
      // turn — an unhandled rejection here would leave the chat waiting forever.
      try {
        const launched = launchRun(rt, input.prompt, launchDeps)
        // The turn entered execution: report it before anything settles.
        emitProgress({ kind: 'accepted' })
        if (launched && typeof launched.catch === 'function') {
          launched.catch((err: unknown) =>
            finish({
              outcome: 'error',
              sessionId: rt.sessionId,
              lastMessage: lastText,
              detail: err instanceof Error ? err.message : String(err),
            }),
          )
        }
      } catch (err) {
        finish({
          outcome: 'error',
          sessionId: rt.sessionId,
          lastMessage: lastText,
          detail: err instanceof Error ? err.message : String(err),
        })
      }
    })
}
