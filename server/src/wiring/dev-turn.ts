/**
 * Wiring — `runDevTurn` (server refactor 3/3e-2).
 *
 * The dev-turn observer closure that used to live in `server.ts`'s startup.
 * It runs ONE dev turn for the automation orchestrator and resolves once it
 * settles, observing the runtime via an internal `Viewer`. Behavior is
 * unchanged from the in-server.ts version (no logic touched — only the
 * launchDeps + broadcast closures are now injected instead of closure-captured).
 *
 * IMPORTANT (kernel boundary, ADR-0009 R1/R2/R6):
 * - This module lives in `wiring/`, NOT in `kernel/`. It imports `runs.ts`
 *   (the kernel registry) only through its public functions; it does not
 *   import ws/HTTP semantics, and it does not construct transports.
 * - `launchDeps` is threaded in by the composition root — same pattern as
 *   `kernel/run/run-lifecycle.ts` (the launcher itself).
 */
import { randomUUID } from 'node:crypto'
import { PENDING_SESSION_PREFIX } from '@ccc/shared/protocol'
import { setSessionMode } from '../state.js'
import { launchRun, type LaunchRunDeps } from '../kernel/run/run-lifecycle.js'
import { getDefaultMode } from '../kernel/config/index.js'
import {
  addViewer,
  ensureRuntime,
  isRunning,
  removeViewer,
  setStatus,
  stopRun,
  emit,
  type Viewer,
} from '../runs.js'
import {
  hasPendingQuestion,
  type DevTurnResult,
  type RunDevTurnInput,
} from '../features/requirements/automation.js'

/** Deps the dev-turn factory reads. `launchDeps` matches what `launchRun` needs. */
export interface DevTurnDeps {
  launchDeps: LaunchRunDeps
}

/**
 * Build the dev-turn observer. Same signature + behavior as the in-server.ts
 * version (server refactor 2/3c-2 folded it into `launchRun`; the local glue
 * here is unchanged).
 */
export function makeRunDevTurn(
  deps: DevTurnDeps,
): (input: RunDevTurnInput) => Promise<DevTurnResult> {
  const { launchDeps } = deps
  return (input: RunDevTurnInput): Promise<DevTurnResult> =>
    new Promise<DevTurnResult>((resolveTurn) => {
      const id = input.sessionId ?? `${PENDING_SESSION_PREFIX}${randomUUID()}`
      const rt = ensureRuntime(id, input.projectPath, getDefaultMode(), [], 'normal')
      let lastText = ''
      // Attaching to an already-running turn: its latest assistant text may have
      // been emitted BEFORE we add our viewer, so seed lastText from the buffer —
      // otherwise the completion judge would read '' instead of the real message.
      if (input.attach) {
        for (const e of rt.buffer) if (e.type === 'assistant_text') lastText = e.text
      }
      let settled = false
      let awaiting = false
      const finish = (r: DevTurnResult): void => {
        if (settled) return
        settled = true
        removeViewer(rt.sessionId, viewer)
        resolveTurn(r)
      }
      const viewer: Viewer = (e) => {
        if (e.type === 'assistant_text') {
          lastText = e.text
        } else if (e.type === 'permission_request') {
          // A human authorization is needed. Automation mirrors manual: do NOT abort —
          // the prompt is already surfaced to the browser and the run stays alive
          // awaiting the watching human's answer. Just signal the orchestrator so it
          // can show an "awaiting authorization" hint.
          if (!awaiting) {
            awaiting = true
            input.onAwaitingPermission?.(true)
          }
        } else if (e.type === 'tool_result') {
          // The pending prompt was answered (its tool produced a result) — the run
          // is moving again. Clear the awaiting hint.
          if (awaiting) {
            awaiting = false
            input.onAwaitingPermission?.(false)
          }
        } else if (e.type === 'turn_end') {
          if (awaiting) {
            awaiting = false
            input.onAwaitingPermission?.(false)
          }
          finish({
            outcome: e.reason === 'error' ? 'error' : 'complete',
            sessionId: rt.sessionId,
            lastMessage: lastText,
            detail: e.error,
          })
        }
      }
      addViewer(id, viewer)
      input.signal.addEventListener('abort', () => {
        stopRun(rt.sessionId)
        finish({
          outcome: 'blocked',
          sessionId: rt.sessionId,
          lastMessage: lastText,
          detail: 'aborted',
        })
      })

      // Attach mode: the turn is already running in the background — only observe
      // it (the viewer above), never launch or push. If it settled in the race
      // between the orchestrator's isRunning check and our addViewer, its turn_end
      // already fired (before our viewer existed), so resolve now from the buffer
      // instead of hanging forever.
      if (input.attach) {
        if (!isRunning(rt.sessionId)) {
          let outcome: DevTurnResult['outcome'] = 'complete'
          let detail: string | undefined
          for (let i = rt.buffer.length - 1; i >= 0; i--) {
            const e = rt.buffer[i]
            if (e.type === 'turn_end') {
              outcome = e.reason === 'error' ? 'error' : 'complete'
              detail = e.error
              break
            }
          }
          // The settled turn may have ended on an unanswered AskUserQuestion (a real
          // human decision). It reads as `complete` here, but the orchestrator must
          // stop, not continue over it — flag it so develop()'s guard catches a
          // mis-judged in_progress (RM-A11).
          finish({
            outcome,
            sessionId: rt.sessionId,
            lastMessage: lastText,
            detail,
            pendingQuestion: hasPendingQuestion(rt.buffer),
          })
        }
        return
      }

      // Live team lead (rare for a dev skill): feed the same process. Otherwise launch
      // a new session or resume the existing one.
      if (rt.team && rt.run?.handle) {
        emit(rt.sessionId, { type: 'user_text', text: input.prompt })
        setStatus(rt.sessionId, 'running')
        rt.run.handle.pushInput(input.prompt)
      } else {
        void launchRun(rt, input.prompt, launchDeps, {
          onEvent: (e) => {
            if (e.kind === 'bound') {
              setSessionMode(e.realId, rt.mode)
              // Surface the bind to the orchestrator immediately (early in_progress flip).
              input.onSessionId?.(e.realId)
            }
          },
        })
      }
    })
}
