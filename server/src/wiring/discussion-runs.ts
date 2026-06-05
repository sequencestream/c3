/**
 * Wiring — `startDiscussionRun` / `startResearchRun` / pause-gate factory
 * (server refactor 3/3e-2).
 *
 * Background-run starters that used to live in `server.ts`'s startup closure.
 * The two starters are the *only* callers of the orchestrator + research
 * engines from a non-feature module — the discussion engine itself is
 * feature-private (`features/discussions/orchestrator.ts`), and the
 * liveness maps are feature-private (`features/discussions/run-controls.ts`).
 * These starters glue the engine to the broadcast + run-control layers, and
 * they belong in `wiring/` (server-only assembly, not kernel, not feature).
 *
 * IMPORTANT (kernel boundary, ADR-0009 R1/R2/R6):
 * - This module lives in `wiring/`. It imports features (engine + store +
 *   run-controls) and the broadcast bag. It does NOT import ws/HTTP semantics
 *   and does NOT touch the kernel registry directly.
 * - Behavior is unchanged from the in-server.ts version (zero drift): the
 *   pause gate still resolves at once unless paused, and abort still wakes
 *   paused waiters via `signal.addEventListener('abort', wake, { once: true })`.
 */
import type { Discussion } from '@ccc/shared/protocol'
import {
  canAutoStartDiscussion,
  researchDiscussionContext,
} from '../features/discussions/research.js'
import { defaultDiscussionDeps, runDiscussion } from '../features/discussions/orchestrator.js'
import {
  deleteDiscussionRun,
  deleteResearchRun,
  hasDiscussionRun,
  setDiscussionRun,
  setResearchRun,
  type DiscussionRunControl,
} from '../features/discussions/run-controls.js'
import { getDiscussion, setDiscussionResearchResult } from '../features/discussions/store.js'
import type { Broadcasts } from './broadcasts.js'

/** Deps the discussion-runs factory reads (the broadcast bag it threads in). */
export interface DiscussionRunsDeps {
  broadcasts: Pick<
    Broadcasts,
    | 'broadcastDiscussions'
    | 'broadcastDiscussionMessage'
    | 'broadcastDiscussionDispatchStatus'
    | 'broadcastDiscussionRunStatus'
    | 'broadcastResearchMessage'
    | 'broadcastResearchRunStatus'
  >
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * The pause gate handed to the engine: resolves at once unless paused, else
 * blocks until resume() wakes the waiters or the run is aborted. Pure factory
 * — caller passes the per-run control, gets back the gate closure.
 */
const makeDiscussionGate =
  (ctrl: DiscussionRunControl) =>
  (signal: AbortSignal): Promise<void> => {
    if (!ctrl.paused || signal.aborted) return Promise.resolve()
    return new Promise<void>((res) => {
      const wake = (): void => res()
      ctrl.resumeWaiters.push(wake)
      signal.addEventListener('abort', wake, { once: true })
    })
  }

/** The two run starters the long-lived `KernelContext` exposes. */
export interface DiscussionRuns {
  startDiscussionRun: (discussion: Discussion) => void
  startResearchRun: (discussion: Discussion) => void
}

/**
 * Build the discussion run starters. Each is a thin glue: register liveness,
 * wire the broadcast + pause hooks, and clean up on finish. No logic change
 * from the in-server.ts version — only the broadcasts come from the injected
 * bag instead of closure-captured locals.
 */
export function createDiscussionRuns(deps: DiscussionRunsDeps): DiscussionRuns {
  const {
    broadcastDiscussions,
    broadcastDiscussionMessage,
    broadcastDiscussionDispatchStatus,
    broadcastDiscussionRunStatus,
    broadcastResearchMessage,
    broadcastResearchRunStatus,
  } = deps.broadcasts

  // Start a background orchestration run for a discussion (shared by
  // `start_discussion` and `continue_discussion`). The caller has already gated
  // re-entry and set the discussion's status; here we register the run
  // control, wire the broadcast + pause hooks, and clean up on finish.
  const startDiscussionRun = (discussion: Discussion): void => {
    const abort = new AbortController()
    const ctrl: DiscussionRunControl = { abort, paused: false, resumeWaiters: [] }
    setDiscussionRun(discussion.id, ctrl)
    broadcastDiscussionRunStatus(discussion.id, 'running')
    const deps = defaultDiscussionDeps({
      onMessage: (m) => broadcastDiscussionMessage(discussion.id, m),
      // Status/conclusion changes ride the refreshed list broadcast.
      onStatusChange: () => broadcastDiscussions(discussion.projectPath),
      onDispatchStatus: (s) => broadcastDiscussionDispatchStatus(discussion.id, s),
      gate: makeDiscussionGate(ctrl),
    })
    // Background orchestration: runs the agents and streams messages until it
    // concludes. It does not own a user session, so finishing never ends a
    // session (既有 session 约定).
    void runDiscussion(discussion.id, abort.signal, deps)
      .catch((err) => {
        console.warn(`[c3] discussion orchestration error: ${errMsg(err)}`)
      })
      .finally(() => {
        deleteDiscussionRun(discussion.id)
        broadcastDiscussionRunStatus(discussion.id, 'ended')
        broadcastDiscussions(discussion.projectPath)
      })
  }

  // Start the read-only research run for a freshly-created discussion as an
  // observable run (mirrors `startDiscussionRun`): register liveness, broadcast
  // `running`, stream each turn, and on settle persist the result, broadcast
  // `ended`, then auto-start the orchestration on success. Fire-and-forget —
  // research never blocks creation. The `ended`-before-auto-start order means
  // the right pane switches research → discussion in one batch; a failed
  // research broadcasts `ended` without auto-start, surfacing the manual Start
  // fallback.
  const startResearchRun = (discussion: Discussion): void => {
    const abort = new AbortController()
    setResearchRun(discussion.id, abort)
    broadcastResearchRunStatus(discussion.id, 'running')
    broadcastDiscussions(discussion.projectPath)
    void researchDiscussionContext(discussion, {
      onMessage: (item) => broadcastResearchMessage(discussion.id, item),
    })
      .then(({ ok, researchResult }) => {
        // Store the research output in its own field; the user's original `context`
        // is never overwritten. Empty output leaves it as ''.
        if (researchResult) {
          setDiscussionResearchResult(discussion.id, researchResult)
        }
        deleteResearchRun(discussion.id)
        broadcastResearchRunStatus(discussion.id, 'ended')
        broadcastDiscussions(discussion.projectPath)
        // Research failed → leave it a draft for a manual Start. On success,
        // re-validate on the freshest record (it may have been manually Started
        // or cancelled mid-research) before auto-starting the orchestration.
        if (!ok) return
        const latest = getDiscussion(discussion.id)
        if (canAutoStartDiscussion(latest, hasDiscussionRun(discussion.id))) {
          startDiscussionRun(latest as Discussion)
        }
      })
      .catch((err) => {
        // Defensive: research itself swallows its run error (returns ok=false),
        // so this only fires on a wiring fault. Still converge liveness so the
        // phase doesn't hang.
        deleteResearchRun(discussion.id)
        broadcastResearchRunStatus(discussion.id, 'ended')
        broadcastDiscussions(discussion.projectPath)
        console.warn(`[c3] discussion research wiring error: ${errMsg(err)}`)
      })
  }

  return { startDiscussionRun, startResearchRun }
}
