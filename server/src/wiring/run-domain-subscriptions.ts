/**
 * Wiring — resident domain subscriptions for run lifecycle (ADR-0018).
 *
 * Replaces all per-launch `eventBus.subscribe()` dispose patterns with a set of
 * **application-lifetime, single-responsibility resident subscriptions**,
 * registered once at the composition root, never disposed.
 *
 * Each subscription:
 *  - Filters for the RunKind / event type it owns.
 *  - Matches domain state via the event's `sessionId` / `prevId` (not via a
 *    bus subscription id).
 *  - Is idempotent (no-ops on unmatched events).
 *
 * ── Intent-session domain (`run:bound`, kind=『intent』) ─────────────
 *  Rebind the chat-store key from pending→real SDK id so the hidden-session
 *  filter (`isHiddenSession` / `listHiddenSessions`) matches, and broadcast
 *  the refreshed intent-session list.
 *
 * ── Session/dev domain (`run:bound`, kind≠intent) ───────────────────
 *  Persist the session's action mode under the real SDK id. If the pending id
 *  was registered as a manual start_development (`pendingDevLink`), flip the
 *  owning intent to `in_progress` and link the real dev session id.
 *
 *  Both domains fan out a `session_started` broadcast so every WS connection
 *  updates its active-session pointer (the client checks its own `clientId`).
 *
 * ── Intents-automation domain (`run:settled`, kind=『session』) ──────
 *  Broadcast the refreshed session list (title/order). For any settled session
 *  that matches an intent's `lastDevSessionId`, refresh the intent list and,
 *  if the project's automation controller is active, forward the event so the
 *  state machine drives the next action (judge → commit → next intent).
 *
 * ── Discussion domain (`run:settled`, kind=『discussion』) ───────────
 *  Broadcast the refreshed discussion list on settle. The discussion run
 *  starters (`discussion-runs.ts`) publish `run:started`/`run:bound`/
 *  `run:settled` with kind='discussion'; this subscription handles the
 *  domain broadcast so each starter's `.finally()` does not need to.
 *
 * ── Schedule domain (`run:settled`, kind=『schedule』) ──────────────
 *  Broadcast the refreshed schedule list on settle. The schedule engine
 *  (`scheduler.ts`) publishes `run:started`/`run:bound`/`run:settled` with
 *  kind='schedule'; this subscription replaces the old `store.broadcast`
 *  call for the schedule list refresh.
 *
 * ── Schedule trigger (unchanged) ─────────────────────────────────────
 *  The existing `dispatchEventSchedules` subscription in
 *  `scheduler-startup.ts` is already resident; only its RunKind filter in
 *  `scheduler.ts` is changed to an explicit whitelist.
 *
 * IMPORTANT (ADR-0009):
 *  This module lives in `wiring/`, which may import `features/` modules
 *  (the wiring layer is the composition root's assembly glue that crosses
 *  kernel/feature/transport boundaries). It does NOT import kernel modules
 *  other than the EventBus type.
 */
import type { Broadcaster } from '../transport/broadcaster.js'
import type { EventBus, EventBusEvents } from '../kernel/events/event-bus.js'
import { getRuntime } from '../runs.js'
import { setSessionMode } from '../state.js'
import {
  getIntent,
  rebindChatSession,
  setLastDevSession,
  updateStatus,
  listIntents,
} from '../features/intents/store.js'
import { takePendingDevLink } from '../features/intents/dev-link.js'
import { notifyTurnSettled } from '../features/intents/automation.js'
import {
  cancelBySourceId,
  isStoreAvailable as isWaitUserEventsStoreAvailable,
} from '../features/user-involve/store.js'
import { agentSwitchFor } from '../features/sessions/index.js'

/** Broader domain subscription dependencies, injected by the composition root. */
export interface DomainSubDeps {
  eventBus: EventBus<EventBusEvents>
  broadcaster: Broadcaster
  /** Fan the sessions list for a workspace to every connection. */
  broadcastSessions: (workspacePath: string) => void
  /** Fan the intent list for a project to every connection. */
  broadcastIntents: (projectPath: string) => void
  /** Fan the intent-session list for a project to every connection. */
  broadcastIntentSessions: (projectPath: string) => void
  /** Fan the discussion list for a project to every connection (2026-06-08-010). */
  broadcastDiscussions: (projectPath: string) => void
  /** Fan the schedule list for a workspace to every connection (2026-06-08-010). */
  broadcastSchedules: (workspacePath: string) => void
  /** Fan the wait-user-involve event (todo) list for a project to every connection. */
  broadcastWaitUserEvents: (projectPath: string) => void
}

/**
 * Register the two resident run-lifecycle subscriptions at the composition root.
 *
 * Called once after `eventBus` construction (`server.ts`). The returned object
 * is empty (the subscriptions are self-owned); the call constructs the closure
 * and registers on the bus — it is NOT a factory.
 */
export function registerRunDomainSubscriptions(deps: DomainSubDeps): void {
  const {
    eventBus,
    broadcaster,
    broadcastSessions,
    broadcastIntents,
    broadcastIntentSessions,
    broadcastDiscussions,
    broadcastSchedules,
    broadcastWaitUserEvents,
  } = deps

  // ── run:bound ────────────────────────────────────────────────────────
  // Matched via `getRuntime`. Two branches: intent comm-sessions (pending
  // →real re-key + hidden-set update) vs normal/dev sessions (mode persist
  // + optional manual-start_development linkage).
  eventBus.subscribe('run:bound', ({ prevId, realId, workspacePath }) => {
    // `realId` is current for the pending→real path; `prevId` as fallback
    // for the resume edge (where bindPending does NOT re-key).
    const rt = getRuntime(realId) ?? getRuntime(prevId)
    if (!rt) return // idempotent no-op for unknown sessions

    if (rt.kind === 'intent' && getRuntime(realId)) {
      // ── Intent-communication session ──
      // Guard: getRuntime(realId) must exist (genuine pending→real path).
      // On the resume edge prevId is already real — `rebindChatSession`
      // would wrongly re-key the chat row to an ephemeral retry sid; skip.
      if (prevId !== realId) rebindChatSession(prevId, realId)
      broadcastIntentSessions(rt.workspacePath)
    } else {
      // ── Normal dev session ──
      setSessionMode(realId, rt.mode)

      // Manual start_development linkage: flip owning intent to in_progress.
      const intentId = takePendingDevLink(prevId)
      if (intentId) {
        setLastDevSession(intentId, realId)
        // Intent row may not yet reflect db updates (only in the store).
        // Calling getIntent to check is safe but ultimately `updateStatus`
        // is the idempotent operation: setting to the same value just
        // bumps updated_at.
        if (getIntent(intentId)?.status !== 'in_progress') {
          updateStatus(intentId, 'in_progress')
        }
        broadcastIntents(rt.workspacePath)
      }
    }

    // Fan out session_started so every connection can self-repair its
    // active-session pointer (ADR-0018 resident-model, 2026-06-08).
    // The client echoes `rebind_view` to repoint `conn.viewing`.
    broadcaster.toAll({
      type: 'session_started',
      clientId: prevId,
      sessionId: realId,
      agentSwitch: agentSwitchFor(realId),
    })
  })

  // ── run:settled ──────────────────────────────────────────────────────
  // Broadcast session list refresh always. For `session` kind runs, also
  // match against intent `lastDevSessionId` to refresh intent status and
  // forward to the project's automation controller.
  eventBus.subscribe('run:settled', ({ sessionId, workspacePath, reason, kind }) => {
    // Always refresh the session list (title / order / status).
    broadcastSessions(workspacePath)

    if (kind !== 'session') return // only session runs affect intent state

    // Match settled session to an intent's lastDevSessionId.
    // Scan the workspace's intents — O(n) per settle; n is small (active
    // intents are typically < 50 per workspace). A reverse-map is not
    // justified until this shows up in a profile.
    const intents = listIntents(workspacePath)
    const matched = intents.find((r) => r.lastDevSessionId === sessionId)
    if (!matched) {
      // Not an intent-linked session — nothing more to do.
      return
    }

    // Refresh the intent list for clients tracking this project.
    broadcastIntents(workspacePath)

    // Forward to the automation controller (no-op if automation is idle).
    notifyTurnSettled(workspacePath, sessionId, reason, matched.id)
  })

  // ── run:settled (kind=discussion) — discussion domain ──────────────
  // Broadcast the refreshed discussion list when a discussion run (research
  // or orchestrator) settles. The discussion run starters in
  // `discussion-runs.ts` publish `run:started`/`run:bound` on start and
  // `run:settled` on finish/abort/error; this subscription reacts to the
  // latter to refresh the domain list.
  eventBus.subscribe('run:settled', ({ workspacePath, kind }) => {
    if (kind !== 'discussion') return
    broadcastDiscussions(workspacePath)
  })

  // ── run:settled (kind=schedule) — schedule domain ──────────────────
  // Broadcast the refreshed schedule list when a scheduled execution
  // settles. The schedule engine in `scheduler.ts` publishes
  // `run:started`/`run:bound`/`run:settled` with kind='schedule' around
  // each `execute()` call; this subscription replaces the old
  // `store.broadcast` call in `dispatchAndTrack`'s `.finally()`.
  eventBus.subscribe('run:settled', ({ workspacePath, kind }) => {
    if (kind !== 'schedule') return
    broadcastSchedules(workspacePath)
  })

  // ── run:settled (kind=session) — wait-user-involve event cancel ──
  // When a session run settles for ANY reason (complete / error / aborted),
  // cancel all still-todo wait-user-involve events for that session.
  // This is a safety net: if the user closes the tab or the process crashes
  // before resolving a pending permission request, the event won't be stuck
  // in 'todo' forever. Events are keyed by session's sourceId, so only
  // session-scoped events are affected (other sources like intent/discussion
  // have different sourceIds and are left untouched).
  // Broadcast the refreshed todo list after cancellation.
  eventBus.subscribe('run:settled', ({ sessionId, workspacePath, kind }) => {
    if (kind !== 'session') return
    if (!isWaitUserEventsStoreAvailable()) return
    cancelBySourceId(sessionId)
    broadcastWaitUserEvents(workspacePath)
  })
}
