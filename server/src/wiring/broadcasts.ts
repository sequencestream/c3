/**
 * Wiring — broadcast closures (server refactor 3/3e-2).
 *
 * The ~12 `broadcast*` closures that used to live in `server.ts`'s startup
 * closure. Frame CONSTRUCTION lives here (we have the domain data); DELIVERY
 * funnels through the injected `Broadcaster` (single egress, ADR-0009 R2,
 * server refactor 2/3b). `server.ts` only constructs the wiring and threads it
 * into `KernelContext`.
 *
 * IMPORTANT (kernel boundary, ADR-0009 R1/R2/R6):
 * - This module lives in `wiring/`, NOT in `kernel/`. It is server-only
 *   assembly glue — it imports features (to read their stores) and transport
 *   (to call `broadcaster.toAll`). `kernel/` is the inverse: feature-free, no
 *   broadcaster calls.
 * - No transport field (`sock`/`viewer`/`connections`) crosses this boundary —
 *   the broadcaster is the only egress, and it is captured by reference.
 */
import type { WorkflowStatus, DiscussionMessage, ResearchMessage } from '@ccc/shared/protocol'
import { resolve } from 'node:path'
import { pathToId } from '../state.js'
import { getSddEnabled } from '../kernel/config/index.js'
import type { Broadcaster } from '../transport/index.js'
import type { SessionAccessor } from '../kernel/agent/session/accessor.js'
import { listSessionsVia } from '../kernel/agent/session/list-sessions.js'
import { paginateSessions } from '../kernel/agent/session/paginate-sessions.js'
import { isRunning, listStatuses } from '../runs.js'
import { isStoreAvailable, listChatSessions, listIntents } from '../features/intents/store.js'
import { enrichRunStatus } from '../features/intents/run-status.js'
import {
  isStoreAvailable as isDiscussionStoreAvailable,
  listDiscussions,
} from '../features/discussions/store.js'
import { discussionRunSnapshot, researchRunSnapshot } from '../features/discussions/run-controls.js'
import type { ResearchStreamItem } from '../features/discussions/research.js'
import type { DispatchStatus } from '../features/discussions/orchestrator.js'
import {
  isStoreAvailable as isAutomationStoreAvailable,
  listAutomations,
} from '../features/automations/store.js'
import {
  isStoreAvailable as isWaitUserEventsStoreAvailable,
  listEvents as listWaitUserEvents,
} from '../features/user-involve/store.js'
import { currentLicenseStatus } from '../features/license/store.js'
import { currentUpdateStatus } from '../features/updates/update-checker.js'

/** The single fan-out reference; threaded in by the composition root. */
export interface BroadcastsDeps {
  broadcaster: Broadcaster
  /** Read the `session_metadata` projection for `broadcastSessions` (same source
   * as the per-connection `sendSessions` in `ws-upgrade.ts`). */
  sessionAccessor: SessionAccessor
}

/**
 * Every broadcast closure the long-lived `KernelContext` exposes. Same names
 * and signatures as the originals in `server.ts` (callers do not change).
 */
export interface Broadcasts {
  /** Re-broadcast the session-status snapshot to every connection. */
  broadcastStatuses: () => void
  /** Push a project's refreshed intent list (with runStatus enrichment). */
  broadcastIntents: (workspacePath: string) => void
  /**
   * Push a project's refreshed intent-communication-session list (with a
   * runStates snapshot). Used after list/add/rename/delete and on reconnect,
   * so the frontend authoritatively knows which sessions exist and which have
   * a live background agent run.
   */
  broadcastIntentSessions: (workspacePath: string) => void
  /**
   * Push a workspace's refreshed session list to EVERY connection (the
   * `session_metadata` projection read). The per-connection `conn.sendSessions`
   * only reaches the originating socket; a background, connection-less producer
   * (the automation orchestrator's dev turns) has no socket, so it fans the list
   * out to all clients instead. Fire-and-forget: the async projection read is not
   * awaited, errors are logged. The frontend keeps a per-workspace map and renders
   * the one it's viewing.
   */
  broadcastSessions: (workspacePath: string) => void
  /** Push a project's refreshed discussion list (with run/research snapshots). */
  broadcastDiscussions: (workspacePath: string) => void
  /** Push a workspace's refreshed automation list. */
  broadcastAutomations: (workspacePath: string) => void
  /** Push an automation-orchestrator status to every connection. */
  broadcastWorkflow: (status: WorkflowStatus) => void
  /** Stream one freshly-appended discussion message. */
  broadcastDiscussionMessage: (discussionId: string, message: DiscussionMessage) => void
  /** Broadcast the transient in-flight/failed status of dispatched participants. */
  broadcastDiscussionDispatchStatus: (discussionId: string, s: DispatchStatus) => void
  /** Broadcast a discussion's live run-state (decoupled from its persisted status). */
  broadcastDiscussionRunStatus: (
    discussionId: string,
    state: 'running' | 'paused' | 'ended',
  ) => void
  /** Stream one research turn (runtime-only — research messages are never persisted). */
  broadcastResearchMessage: (discussionId: string, item: ResearchStreamItem) => void
  /** Broadcast a discussion's research-run liveness (runtime-only). */
  broadcastResearchRunStatus: (discussionId: string, state: 'running' | 'ended') => void
  /** Push a project's refreshed wait-user-involve event list (todo status). */
  broadcastWaitUserEvents: (workspacePath: string) => void
  /** Push the current product-license state to every connection (PL-R7). */
  broadcastLicense: () => void
  /** Push the current update-availability snapshot to every connection. */
  broadcastUpdateStatus: () => void
}

/**
 * Build the broadcast bag. Each closure mirrors its in-server.ts counterpart
 * byte-for-byte (zero behavior change) — only its `broadcaster` reference
 * comes from the composition root instead of a closure-captured `broadcaster`.
 */
export function createBroadcasts(deps: BroadcastsDeps): Broadcasts {
  const { broadcaster, sessionAccessor } = deps

  // Re-broadcast the session-status snapshot. No-op when there are no
  // connections (e.g. a server-startup tick before the first WS opens).
  const broadcastStatuses = (): void => {
    broadcaster.toAll({ type: 'session_status', statuses: listStatuses() })
  }

  // Push a project's intent list to every connection. The frontend keeps
  // a per-project map and ignores projects it isn't viewing. Used after a save,
  // a status change, or a dev launch. Applies runStatus enrichment so each
  // client sees the reconciled running/dangling/idle state. No-op when the
  // store is unavailable.
  const broadcastIntents = (workspacePath: string): void => {
    if (!isStoreAvailable()) return
    const proj = resolve(workspacePath)
    const items = enrichRunStatus(listIntents(proj))
    broadcaster.toAll({
      type: 'intents',
      workspaceId: pathToId(proj)!,
      items,
      sddEnabled: getSddEnabled(proj),
    })
  }

  // Snapshot helper: which listed intent sessions have a live agent run.
  // Absent from the result means idle / no run.
  const intentSessionRunSnapshot = (
    items: { sessionId: string }[],
  ): Record<string, 'running'> | undefined => {
    const out: Record<string, 'running'> = {}
    let found = false
    for (const it of items) {
      if (isRunning(it.sessionId)) {
        out[it.sessionId] = 'running'
        found = true
      }
    }
    return found ? out : undefined
  }

  // Push a project's refreshed intent-communication-session list (with a
  // runStates snapshot). No-op when the store is unavailable. The frontend
  // pops back to the latest is_current when its current session is deleted.
  const broadcastIntentSessions = (workspacePath: string): void => {
    if (!isStoreAvailable()) return
    const proj = resolve(workspacePath)
    const items = listChatSessions(proj)
    const runStates = intentSessionRunSnapshot(items)
    broadcaster.toAll({ type: 'intent_sessions', workspaceId: pathToId(proj)!, items, runStates })
  }

  // Push a workspace's refreshed session list to every connection. Mirrors the
  // per-connection `conn.sendSessions` (ws-upgrade.ts), but fans out — the
  // automation orchestrator runs detached with no originating socket, so its
  // freshly-bound work session would otherwise never live-appear in any sidebar.
  // Fire-and-forget: the projection read is async; we don't block the caller and
  // log (never throw) on failure.
  const broadcastSessions = (workspacePath: string): void => {
    const proj = resolve(workspacePath)
    void listSessionsVia(sessionAccessor, proj)
      .then((all) => {
        // Bounded fan-out (SR-R14): the broadcast has no per-client cursor, so it
        // pushes only the newest page tagged `live`. The client upserts these by
        // id WITHOUT replacing its loaded-more window (a freshly-bound/just-active
        // session sorts to the top, so the newest page surfaces it — SR-R13);
        // older-session updates and deletions reconcile via the client's window
        // refresh, not this push.
        const { sessions } = paginateSessions(all)
        broadcaster.toAll({
          type: 'sessions',
          workspaceId: pathToId(proj)!,
          sessionKind: 'work',
          sessions,
          page: { kind: 'live', hasMore: false },
        })
      })
      .catch((err) => console.error('[c3] broadcastSessions failed:', err))
  }

  // Push a project's refreshed discussion list. The frontend keeps a
  // per-project cache and renders the one it's viewing. No-op when the store
  // is unavailable.
  const broadcastDiscussions = (workspacePath: string): void => {
    if (!isDiscussionStoreAvailable()) return
    const proj = resolve(workspacePath)
    const items = listDiscussions(proj)
    const runStates = discussionRunSnapshot(items)
    const researchStates = researchRunSnapshot(items)
    broadcaster.toAll({
      type: 'discussions',
      workspaceId: pathToId(proj)!,
      items,
      runStates,
      researchStates,
    })
  }

  // Push a workspace's automation list. Used after create/update/delete. No-op
  // when the store is unavailable.
  const broadcastAutomations = (workspacePath: string): void => {
    if (!isAutomationStoreAvailable()) return
    const proj = resolve(workspacePath)
    const items = listAutomations(proj)
    broadcaster.toAll({ type: 'automations', workspaceId: pathToId(proj)!, items })
  }

  // Stream one freshly-appended discussion message to every connection (the
  // frontend appends it when viewing that discussion).
  const broadcastDiscussionMessage = (discussionId: string, message: DiscussionMessage): void => {
    broadcaster.toAll({ type: 'discussion_message', discussionId, message })
  }

  // Broadcast the transient in-flight/failed status of agents the organizer
  // just dispatched (pending → cleared/failed). Runtime-only, never persisted;
  // maps the engine's per-agent `DispatchStatus` onto the wire event.
  const broadcastDiscussionDispatchStatus = (discussionId: string, s: DispatchStatus): void => {
    const evt =
      s.phase === 'failed'
        ? {
            type: 'discussion_dispatch_status' as const,
            discussionId,
            phase: 'failed' as const,
            agents: [s.agent],
            error: s.error,
          }
        : {
            type: 'discussion_dispatch_status' as const,
            discussionId,
            phase: s.phase,
            agents: s.agents,
          }
    broadcaster.toAll(evt)
  }

  // Broadcast a discussion's live run-state (decoupled from its persisted status).
  const broadcastDiscussionRunStatus = (
    discussionId: string,
    state: 'running' | 'paused' | 'ended',
  ): void => {
    broadcaster.toAll({ type: 'discussion_run_status', discussionId, state })
  }

  // Stream one research turn to every connection (runtime-only — research
  // messages are never persisted; the frontend appends to the right pane's
  // research stream).
  const broadcastResearchMessage = (discussionId: string, item: ResearchStreamItem): void => {
    const message: ResearchMessage = { ...item, discussionId, createdAt: Date.now() }
    broadcaster.toAll({ type: 'research_message', discussionId, message })
  }

  // Broadcast a discussion's research-run liveness (running while the agent
  // works, ended on finish/fail/dead process). Runtime-only, mirrors
  // `discussion_run_status`.
  const broadcastResearchRunStatus = (discussionId: string, state: 'running' | 'ended'): void => {
    broadcaster.toAll({ type: 'research_run_status', discussionId, state })
  }

  // Push an automation-orchestrator status to every connection (the frontend
  // keeps a per-project map and renders the one it's viewing).
  const broadcastWorkflow = (status: WorkflowStatus): void => {
    broadcaster.toAll({ type: 'workflow_status', status })
  }

  // Push a project's refreshed wait-user-involve event list. Only 'todo'
  // events are broadcast — the frontend's pending-items badge count uses them.
  // 'done' / 'canceled' events are still queryable via list_wait_user_events
  // with an explicit status filter, but are never pushed proactively.
  const broadcastWaitUserEvents = (workspacePath: string): void => {
    if (!isWaitUserEventsStoreAvailable()) return
    const proj = resolve(workspacePath)
    const items = listWaitUserEvents(proj, 'todo')
    broadcaster.toAll({ type: 'wait_user_events', items })
  }

  // Push the current product-license state to every connection. The frontend
  // renders it as the license badge/menu (PL-R7). Cheap, no store dependency.
  const broadcastLicense = (): void => {
    broadcaster.toAll({ type: 'license_state', license: currentLicenseStatus() })
  }

  // Push the current update-availability snapshot to every connection. The
  // frontend shows the header upgrade hint only when a newer release is available.
  // Cheap in-memory read, no store dependency.
  const broadcastUpdateStatus = (): void => {
    broadcaster.toAll({ type: 'update_status', updateStatus: currentUpdateStatus() })
  }

  return {
    broadcastStatuses,
    broadcastIntents,
    broadcastIntentSessions,
    broadcastSessions,
    broadcastDiscussions,
    broadcastAutomations,
    broadcastWorkflow,
    broadcastDiscussionMessage,
    broadcastDiscussionDispatchStatus,
    broadcastDiscussionRunStatus,
    broadcastResearchMessage,
    broadcastResearchRunStatus,
    broadcastWaitUserEvents,
    broadcastLicense,
    broadcastUpdateStatus,
  }
}
