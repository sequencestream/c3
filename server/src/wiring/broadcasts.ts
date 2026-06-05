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
import type { AutomationStatus, DiscussionMessage, ResearchMessage } from '@ccc/shared/protocol'
import { resolve } from 'node:path'
import type { Broadcaster } from '../transport/index.js'
import { listStatuses } from '../runs.js'
import { isStoreAvailable, listRequirements } from '../features/requirements/store.js'
import { enrichRunStatus } from '../features/requirements/run-status.js'
import {
  isStoreAvailable as isDiscussionStoreAvailable,
  listDiscussions,
} from '../features/discussions/store.js'
import { discussionRunSnapshot, researchRunSnapshot } from '../features/discussions/run-controls.js'
import type { ResearchStreamItem } from '../features/discussions/research.js'
import type { DispatchStatus } from '../features/discussions/orchestrator.js'
import {
  isStoreAvailable as isScheduleStoreAvailable,
  listSchedules,
} from '../features/schedules/store.js'

/** The single fan-out reference; threaded in by the composition root. */
export interface BroadcastsDeps {
  broadcaster: Broadcaster
}

/**
 * Every broadcast closure the long-lived `KernelContext` exposes. Same names
 * and signatures as the originals in `server.ts` (callers do not change).
 */
export interface Broadcasts {
  /** Re-broadcast the session-status snapshot to every connection. */
  broadcastStatuses: () => void
  /** Push a project's refreshed requirement list (with runStatus enrichment). */
  broadcastRequirements: (projectPath: string) => void
  /** Push a project's refreshed discussion list (with run/research snapshots). */
  broadcastDiscussions: (projectPath: string) => void
  /** Push a workspace's refreshed schedule list. */
  broadcastSchedules: (workspacePath: string) => void
  /** Push an automation-orchestrator status to every connection. */
  broadcastAutomation: (status: AutomationStatus) => void
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
}

/**
 * Build the broadcast bag. Each closure mirrors its in-server.ts counterpart
 * byte-for-byte (zero behavior change) — only its `broadcaster` reference
 * comes from the composition root instead of a closure-captured `broadcaster`.
 */
export function createBroadcasts(deps: BroadcastsDeps): Broadcasts {
  const { broadcaster } = deps

  // Re-broadcast the session-status snapshot. No-op when there are no
  // connections (e.g. a server-startup tick before the first WS opens).
  const broadcastStatuses = (): void => {
    broadcaster.toAll({ type: 'session_status', statuses: listStatuses() })
  }

  // Push a project's requirement list to every connection. The frontend keeps
  // a per-project map and ignores projects it isn't viewing. Used after a save,
  // a status change, or a dev launch. Applies runStatus enrichment so each
  // client sees the reconciled running/dangling/idle state. No-op when the
  // store is unavailable.
  const broadcastRequirements = (projectPath: string): void => {
    if (!isStoreAvailable()) return
    const proj = resolve(projectPath)
    const items = enrichRunStatus(listRequirements(proj))
    broadcaster.toAll({ type: 'requirements', projectPath: proj, items })
  }

  // Push a project's refreshed discussion list. The frontend keeps a
  // per-project cache and renders the one it's viewing. No-op when the store
  // is unavailable.
  const broadcastDiscussions = (projectPath: string): void => {
    if (!isDiscussionStoreAvailable()) return
    const proj = resolve(projectPath)
    const items = listDiscussions(proj)
    const runStates = discussionRunSnapshot(items)
    const researchStates = researchRunSnapshot(items)
    broadcaster.toAll({ type: 'discussions', projectPath: proj, items, runStates, researchStates })
  }

  // Push a workspace's schedule list. Used after create/update/delete. No-op
  // when the store is unavailable.
  const broadcastSchedules = (workspacePath: string): void => {
    if (!isScheduleStoreAvailable()) return
    const proj = resolve(workspacePath)
    const items = listSchedules(proj)
    broadcaster.toAll({ type: 'schedules', workspacePath: proj, items })
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
  const broadcastAutomation = (status: AutomationStatus): void => {
    broadcaster.toAll({ type: 'automation_status', status })
  }

  return {
    broadcastStatuses,
    broadcastRequirements,
    broadcastDiscussions,
    broadcastSchedules,
    broadcastAutomation,
    broadcastDiscussionMessage,
    broadcastDiscussionDispatchStatus,
    broadcastDiscussionRunStatus,
    broadcastResearchMessage,
    broadcastResearchRunStatus,
  }
}
