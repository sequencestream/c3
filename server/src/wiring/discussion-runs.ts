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
 * Each starter now publishes run lifecycle events (`run:started` / `run:bound` /
 * `run:settled`) with `sessionKind='discussion'` on the kernel event bus (ADR-0018
 * amendment, 2026-06-08-010). The resident discussion subscription in
 * `run-domain-subscriptions.ts` reacts to those events to broadcast the
 * refreshed discussion list — the explicit `broadcastDiscussions` calls in
 * the `.finally()` cleanup are replaced by this subscription.
 *
 * IMPORTANT (kernel boundary, ADR-0009 R1/R2/R6):
 * - This module lives in `wiring/`. It imports features (engine + store +
 *   run-controls) and the broadcast bag. It does NOT import ws/HTTP semantics
 *   and does NOT touch the kernel registry directly.
 */
import type { Discussion, RunEndReason, VendorId } from '@ccc/shared/protocol'
import { resolveWorkspaceRoot } from '../state.js'
import type { EventBus, EventBusEvents } from '../kernel/events/event-bus.js'
import type { VendorAdapter } from '../kernel/agent/adapters/types.js'
import {
  canAutoStartDiscussion,
  researchDiscussionContext,
} from '../features/discussions/research.js'
import { defaultDiscussionDeps, runDiscussion } from '../features/discussions/orchestrator.js'
import { AgentSessionManager } from '../features/discussions/agent-session-manager.js'
import {
  appendResearchTranscript,
  clearResearchTranscript,
  deleteDiscussionRun,
  deleteResearchRun,
  hasDiscussionRun,
  setDiscussionRun,
  setResearchRun,
  type DiscussionRunControl,
} from '../features/discussions/run-controls.js'
import {
  getAgentSession as storeGetAgentSession,
  setAgentSession as storeSetAgentSession,
  deleteAgentSession as storeDeleteAgentSession,
  deleteAllByDiscussion as storeDeleteAllByDiscussion,
  getDiscussion,
  setDiscussionResearchResult,
} from '../features/discussions/store.js'
import {
  deleteByOwner,
  deleteByVendorId,
  upsertBoundRow,
} from '../features/works/work-session-store.js'
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
  /** Kernel event bus for publishing run lifecycle events (2026-06-08-010). */
  eventBus: EventBus<EventBusEvents>
  /**
   * Resolve a vendor id to its registered adapter. Used by the
   * {@link AgentSessionManager} to drive resume-aware agent sessions.
   * Throws when no adapter is registered for the given vendor.
   */
  getAdapter: (vendor: VendorId) => VendorAdapter
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function discussionSessionTitle(discussionTitle: string, agentName: string): string {
  return `${discussionTitle} · ${agentName}`
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
  const { eventBus } = deps
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
  //
  // Publishes `run:started`/`run:bound`/`run:settled` with sessionKind='discussion'
  // on the kernel event bus so the resident subscription in
  // `run-domain-subscriptions.ts` broadcasts the refreshed discussion list
  // (the subscription replaces the explicit `.finally()` broadcast).
  const startDiscussionRun = (discussion: Discussion): void => {
    const abort = new AbortController()
    const ctrl: DiscussionRunControl = { abort, paused: false, resumeWaiters: [] }
    setDiscussionRun(discussion.id, ctrl)
    broadcastDiscussionRunStatus(discussion.id, 'running')

    // Publish discussion run lifecycle events (2026-06-08-010).
    eventBus.publish('run:started', {
      sessionId: discussion.id,
      workspacePath: resolveWorkspaceRoot(discussion.workspaceId)!,
      sessionKind: 'discussion',
      runKind: 'internal',
    })
    eventBus.publish('run:bound', {
      prevId: discussion.id,
      realId: discussion.id,
      workspacePath: resolveWorkspaceRoot(discussion.workspaceId)!,
    })

    const sessionManager = new AgentSessionManager({
      getAdapter: deps.getAdapter,
      store: {
        getAgentSession: storeGetAgentSession,
        setAgentSession: storeSetAgentSession,
        deleteAgentSession: storeDeleteAgentSession,
        deleteAllByDiscussion: storeDeleteAllByDiscussion,
      },
      projection: {
        upsert: ({ discussionId, workspacePath, agent, sessionId, vendor }) => {
          const latest = getDiscussion(discussionId)
          upsertBoundRow({
            sessionId,
            workspacePath,
            vendor,
            agentId: agent.id,
            title: discussionSessionTitle(latest?.title ?? discussion.title, agent.displayName),
            sessionKind: 'discussion',
            ownerKind: 'discussion',
            ownerId: discussionId,
          })
        },
        delete: ({ sessionId, vendor }) => {
          if (vendor === 'claude' || vendor === 'codex') deleteByVendorId(vendor, sessionId)
        },
        deleteAll: (discussionId) => {
          deleteByOwner('discussion', discussionId)
        },
      },
    })
    let settledReason: RunEndReason = 'complete'
    const discussionDeps = defaultDiscussionDeps({
      sessionManager,
      onMessage: (m) => broadcastDiscussionMessage(discussion.id, m),
      // Status/conclusion changes ride the refreshed list broadcast.
      onStatusChange: () => broadcastDiscussions(resolveWorkspaceRoot(discussion.workspaceId)!),
      onDispatchStatus: (s) => broadcastDiscussionDispatchStatus(discussion.id, s),
      gate: makeDiscussionGate(ctrl),
    })
    // Background orchestration: runs the agents and streams messages until it
    // concludes. It does not own a user session, so finishing never ends a
    // session (既有 session 约定).
    void runDiscussion(discussion.id, abort.signal, discussionDeps)
      .catch((err) => {
        settledReason = 'error'
        console.warn(`[c3] discussion orchestration error: ${errMsg(err)}`)
      })
      .finally(() => {
        if (abort.signal.aborted) settledReason = 'aborted'
        eventBus.publish('run:settled', {
          sessionId: discussion.id,
          workspacePath: resolveWorkspaceRoot(discussion.workspaceId)!,
          reason: settledReason,
          sessionKind: 'discussion',
          runKind: 'internal',
        })
        deleteDiscussionRun(discussion.id)
        broadcastDiscussionRunStatus(discussion.id, 'ended')
      })
  }

  // Start the read-only research run for a freshly-created discussion as an
  // observable run (mirrors `startDiscussionRun`): register liveness, broadcast
  // `running`, stream each turn, and on settle persist the result, broadcast
  // `ended`, then auto-start the orchestration on success. Fire-and-forget —
  // research never blocks creation.
  //
  // Publishes `run:started`/`run:bound`/`run:settled` with sessionKind='discussion'
  // on the kernel event bus. The `ended`-before-auto-start order means the
  // right pane switches research → discussion in one batch; a failed research
  // broadcasts `ended` without auto-start, surfacing the manual Start fallback.
  const startResearchRun = (discussion: Discussion): void => {
    const abort = new AbortController()
    // Fresh runtime transcript for this run (clears any stale buffer from a prior
    // aborted run on the same discussion id).
    clearResearchTranscript(discussion.id)
    setResearchRun(discussion.id, abort)
    broadcastResearchRunStatus(discussion.id, 'running')

    // Publish research run lifecycle events (2026-06-08-010).
    eventBus.publish('run:started', {
      sessionId: discussion.id,
      workspacePath: resolveWorkspaceRoot(discussion.workspaceId)!,
      sessionKind: 'discussion',
      runKind: 'internal',
    })
    eventBus.publish('run:bound', {
      prevId: discussion.id,
      realId: discussion.id,
      workspacePath: resolveWorkspaceRoot(discussion.workspaceId)!,
    })

    void researchDiscussionContext(discussion, {
      onMessage: (item) => {
        // Keep a runtime copy for mid-research reconnect (replayed on the
        // `discussion_detail` snapshot) before fanning the live item out.
        appendResearchTranscript(discussion.id, item)
        broadcastResearchMessage(discussion.id, item)
      },
    })
      .then(({ ok, researchResult }) => {
        // Publish settled before state cleanup — the subscription fires
        // synchronously and broadcasts the (still-running) discussion list.
        const reason: RunEndReason = abort.signal.aborted ? 'aborted' : ok ? 'complete' : 'error'
        eventBus.publish('run:settled', {
          sessionId: discussion.id,
          workspacePath: resolveWorkspaceRoot(discussion.workspaceId)!,
          reason,
          sessionKind: 'discussion',
          runKind: 'internal',
        })

        // Store the research output in its own field; the user's original `context`
        // is never overwritten. Empty output leaves it as ''.
        if (researchResult) {
          setDiscussionResearchResult(discussion.id, researchResult)
        }
        deleteResearchRun(discussion.id)
        // Research ended → the right pane leaves the research phase, so the runtime
        // transcript is no longer needed (and `researchStates` no longer lists it).
        clearResearchTranscript(discussion.id)
        broadcastResearchRunStatus(discussion.id, 'ended')
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
        // so this only fires on a wiring fault. Ensure settled fires for liveness.
        eventBus.publish('run:settled', {
          sessionId: discussion.id,
          workspacePath: resolveWorkspaceRoot(discussion.workspaceId)!,
          reason: 'error',
          sessionKind: 'discussion',
          runKind: 'internal',
        })
        deleteResearchRun(discussion.id)
        clearResearchTranscript(discussion.id)
        broadcastResearchRunStatus(discussion.id, 'ended')
        console.warn(`[c3] discussion research wiring error: ${errMsg(err)}`)
      })
  }

  return { startDiscussionRun, startResearchRun }
}
