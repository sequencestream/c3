/**
 * Wiring — resident domain subscriptions for run lifecycle (ADR-0018).
 *
 * Replaces all per-launch `eventBus.subscribe()` dispose patterns with a set of
 * **application-lifetime, single-responsibility resident subscriptions**,
 * registered once at the composition root, never disposed.
 *
 * Each subscription:
 *  - Filters for the SessionKind / event type it owns.
 *  - Matches domain state via the event's `sessionId` / `prevId` (not via a
 *    bus subscription id).
 *  - Is idempotent (no-ops on unmatched events).
 *
 * ── Intent-session domain (`run:bound`, sessionKind=『intent』) ─────────────
 *  Rebind the chat-store key from pending→real SDK id so the hidden-session
 *  filter (`isHiddenSession` / `listHiddenSessions`) matches, and broadcast
 *  the refreshed intent-session list.
 *
 * ── Session/dev domain (`run:bound`, sessionKind≠intent) ───────────────────
 *  Persist the session's action mode under the real SDK id. If the pending id
 *  was registered as a manual start_development (`pendingDevLink`), flip the
 *  owning intent to `in_progress` and link the real work session id.
 *
 *  Both domains fan out a `session_started` broadcast so every WS connection
 *  updates its active-session pointer (the client checks its own `clientId`).
 *
 * ── Intents-automation domain (`run:settled`, sessionKind=『work』) ──────
 *  Broadcast the refreshed session list (title/order). For any settled session
 *  that matches an intent's `lastWorkSessionId`, refresh the intent list and,
 *  if the project's automation controller is active, forward the event so the
 *  state machine drives the next action (judge → commit → next intent).
 *
 * ── Discussion domain (`run:settled`, sessionKind=『discussion』) ───────────
 *  Broadcast the refreshed discussion list on settle. The discussion run
 *  starters (`discussion-runs.ts`) publish `run:started`/`run:bound`/
 *  `run:settled` with sessionKind='discussion'; this subscription handles the
 *  domain broadcast so each starter's `.finally()` does not need to.
 *
 * ── Automation domain (`run:settled`, sessionKind=『automation』) ──────────────
 *  Broadcast the refreshed automation list on settle. The automation engine
 *  (`scheduler.ts`) publishes `run:started`/`run:bound`/`run:settled` with
 *  sessionKind='automation'; this subscription replaces the old `store.broadcast`
 *  call for the automation list refresh.
 *
 * ── Automation trigger (unchanged) ─────────────────────────────────────
 *  The existing `dispatchEventTriggers` subscription in
 *  `scheduler-startup.ts` is already resident; only its SessionKind filter in
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
import type { IntentDevSessionExitCode, PrOperationEvent } from '@ccc/shared/protocol'
import { getRuntime } from '../runs.js'
import { pathToId, setSessionMode } from '../state.js'
import {
  getIntent,
  getIntentSessionBySessionId,
  insertIntentSession,
  rebindChatSession,
  setBranchName,
  setIntentSessionId,
  setLastWorkSession,
  setLatestCommitHash,
  setPrInfo,
  setPrStatus,
  setSpecSessionId,
  safeInsertIntentLog,
  updateIntentSession,
  updateStatus,
  listIntents,
} from '../features/intents/store.js'
import {
  clearPendingDevLink,
  releaseDevLaunch,
  takePendingDevLink,
} from '../features/intents/dev-link.js'
import { clearPendingSpecLink, takePendingSpecLink } from '../features/intents/spec-link.js'
import { clearPendingIntentLink, takePendingIntentLink } from '../features/intents/intent-link.js'
import { isIntentDrivenByWorkflow, notifyTurnSettled } from '../features/intents/workflow.js'
import { runManualDevCleanup, type DevCleanupDeps } from '../features/intents/dev-cleanup.js'
import { handlePrUpdateEvent } from '../features/intents/pr-update-consumer.js'
import {
  publishIntentLifecycle,
  publishIntentStatusTransition,
} from '../features/intents/lifecycle-events.js'
import { getWorktreePath } from '../features/intents/worktree.js'
import {
  getDefaultMainBranch,
  getForgeOverride,
  getGitBranchMode,
  getSessionAgentId,
} from '../kernel/config/index.js'
import {
  deleteByVendorId,
  updateRowOwner,
  upsertBoundRow,
} from '../features/sessions/session-metadata-store.js'
import {
  cancelBySessionId,
  createEvent,
  isStoreAvailable as isWaitUserEventsStoreAvailable,
} from '../features/user-involve/store.js'
import { agentSwitchFor } from '../features/works/index.js'
import { resolveSessionVendor } from '../kernel/agent-config/index.js'
import {
  commitAndPush,
  createForgePr,
  getCurrentBranch,
  getHeadCommit,
  gitDiffStat,
  hasCommittableChanges,
} from '../git.js'
import { GIT_CLEANUP_EVENT_TOOL } from '@ccc/shared/protocol'

/** Broader domain subscription dependencies, injected by the composition root. */
export interface DomainSubDeps {
  eventBus: EventBus<EventBusEvents>
  broadcaster: Broadcaster
  /** Fan the sessions list for a workspace to every connection. */
  broadcastSessions: (workspacePath: string) => void
  /** Fan the intent list for a project to every connection. */
  broadcastIntents: (workspacePath: string) => void
  /** Fan the intent-session list for a project to every connection. */
  broadcastIntentSessions: (workspacePath: string) => void
  /** Fan the discussion list for a project to every connection (2026-06-08-010). */
  broadcastDiscussions: (workspacePath: string) => void
  /** Fan the automation list for a workspace to every connection (2026-06-08-010). */
  broadcastAutomations: (workspacePath: string) => void
  /** Fan the wait-user-involve event (todo) list for a project to every connection. */
  broadcastWaitUserEvents: (workspacePath: string) => void
  /** Publish a normalized PR operation event onto the kernel event bus. */
  publishPrEvent: (payload: { workspacePath: string; sessionId: string } & PrOperationEvent) => void
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
    broadcastAutomations,
    broadcastWaitUserEvents,
    publishPrEvent,
  } = deps

  // Manual Start-Work session-end Git/PR cleanup deps (MSC-R1…R6). Stateless
  // wiring of git helpers + store writers + the workbench failure-todo channel.
  const cleanupDeps: DevCleanupDeps = {
    getGitBranchMode,
    getDefaultMainBranch,
    getForgeOverride,
    gitCwd: (ws, intentId) =>
      getGitBranchMode(ws) === 'worktree' ? getWorktreePath(ws, intentId) : ws,
    hasCommittableChanges,
    getCurrentBranch,
    getHeadCommit,
    commitAndPush,
    createForgePr: (cwd, title, body, headBranch, baseBranch, providerOverride) =>
      createForgePr(cwd, title, body, headBranch, baseBranch, providerOverride),
    getIntent,
    setBranchName,
    setLatestCommitHash,
    setPrInfo,
    cancelEventsForIntent: (intentId) => {
      if (isWaitUserEventsStoreAvailable()) cancelBySessionId(intentId)
    },
    pushFailureEvent: ({ workspacePath, intentId, code, params }) => {
      if (!isWaitUserEventsStoreAvailable()) return
      // A manual Start-work cleanup failure has no real session to reference; the intent
      // OBJECT id goes into `session_id` as the best available identifier. The reverse
      // lookup of `intentId`/`intentTitle` may resolve it (via last_work_session_id) or
      // yield null — either way the event renders; only the derived intent name varies.
      createEvent({
        workspacePath,
        sessionKind: 'intent',
        sessionId: intentId,
        status: 'todo',
        toolName: GIT_CLEANUP_EVENT_TOOL,
        toolInput: { code, ...(params ? { params } : {}) },
      })
    },
    broadcastIntents,
    broadcastWaitUserEvents,
    publishPrEvent,
  }

  // ── run:bound ────────────────────────────────────────────────────────
  // Matched via `getRuntime`. Two branches: intent comm-sessions (pending
  // →real re-key + hidden-set update) vs normal/work sessions (mode persist
  // + optional manual-start_development linkage).
  eventBus.subscribe('run:bound', ({ prevId, realId }) => {
    // `realId` is current for the pending→real path; `prevId` as fallback
    // for the resume edge (where bindPending does NOT re-key).
    const rt = getRuntime(realId) ?? getRuntime(prevId)
    if (!rt) return // idempotent no-op for unknown sessions

    if (rt.sessionKind === 'intent' && getRuntime(realId)) {
      // ── Intent-communication session ──
      // Guard: getRuntime(realId) must exist (genuine pending→real path).
      // On the resume edge prevId is already real — `rebindChatSession`
      // would wrongly re-key the chat row to an ephemeral retry sid; skip.
      if (prevId !== realId) rebindChatSession(prevId, realId)
      // Refine linkage: back-fill the originating intent's `intent_session_id`
      // with the real comm session id so the detail's `intent session` tab can
      // reopen it. takePendingIntentLink consumes the pending→intent entry
      // registered by the refine_intent handler (absent for new_intent_session).
      const refiningIntentId = takePendingIntentLink(prevId)
      if (refiningIntentId) {
        setIntentSessionId(refiningIntentId, realId)
        broadcastIntents(rt.workspacePath)
      }
      const vendor = resolveSessionVendor(realId)
      deleteByVendorId(resolveSessionVendor(prevId), prevId)
      upsertBoundRow({
        sessionId: realId,
        workspacePath: rt.workspacePath,
        vendor,
        agentId: getSessionAgentId(realId) ?? '',
        title: 'New Intent',
        sessionKind: 'intent',
        ownerKind: refiningIntentId ? 'intent' : null,
        ownerId: refiningIntentId ?? null,
      })
      broadcastIntentSessions(rt.workspacePath)
    } else if (rt.sessionKind === 'spec') {
      // ── Spec-authoring session ──
      // Link the real spec session id back onto the originating intent so the
      // ledger's spec_session_id reflects the live session. takePendingSpecLink
      // consumes the pending→intent entry registered by the write_spec handler.
      const intentId = takePendingSpecLink(prevId)
      if (intentId) {
        const intent = getIntent(intentId)
        const oldSpecSessionId = intent?.specSessionId ?? null
        if (oldSpecSessionId && oldSpecSessionId !== realId) {
          updateRowOwner({
            sessionId: oldSpecSessionId,
            vendor: resolveSessionVendor(oldSpecSessionId),
            ownerKind: null,
            ownerId: null,
          })
        }
        setSpecSessionId(intentId, realId)
        const vendor = resolveSessionVendor(realId)
        deleteByVendorId(resolveSessionVendor(prevId), prevId)
        upsertBoundRow({
          sessionId: realId,
          workspacePath: rt.workspacePath,
          vendor,
          agentId: getSessionAgentId(realId) ?? '',
          title: intent?.title ?? 'New session',
          sessionKind: 'spec',
          ownerKind: 'intent',
          ownerId: intentId,
        })
        broadcastIntents(rt.workspacePath)
      }
    } else {
      // ── Normal work session ──
      setSessionMode(realId, rt.mode)

      // Manual start_development linkage: flip owning intent to in_progress.
      const intentId = takePendingDevLink(prevId)
      if (intentId) {
        setLastWorkSession(intentId, realId)
        releaseDevLaunch(intentId)
        // Record the work session start in intent_sessions (fire-and-forget
        // on the DB write — the insert is synchronous but cheap).
        insertIntentSession(intentId, realId, resolveSessionVendor(realId))
        updateRowOwner({
          sessionId: realId,
          vendor: resolveSessionVendor(realId),
          ownerKind: 'intent',
          ownerId: intentId,
        })
        // Intent row may not yet reflect db updates (only in the store).
        // Calling getIntent to check is safe but ultimately `updateStatus`
        // is the idempotent operation: setting to the same value just
        // bumps updated_at.
        const intent = getIntent(intentId)
        if (intent && intent.status !== 'in_progress') {
          updateStatus(intentId, 'in_progress')
          publishIntentStatusTransition(rt.workspacePath, intent, intent.status, 'in_progress')
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
  // Broadcast session list refresh always. For `work` sessionKind runs, also
  // match against intent `lastWorkSessionId` to refresh intent status and
  // forward to the project's automation controller.
  eventBus.subscribe('run:settled', ({ sessionId, workspacePath, reason, sessionKind }) => {
    // Always refresh the session list (title / order / status).
    broadcastSessions(workspacePath)

    if (sessionKind !== 'work') return // only work runs affect intent state

    const unboundIntentId = clearPendingDevLink(sessionId)
    if (unboundIntentId) releaseDevLaunch(unboundIntentId)

    // Match settled session to an intent's lastWorkSessionId.
    // Scan the workspace's intents — O(n) per settle; n is small (active
    // intents are typically < 50 per workspace). A reverse-map is not
    // justified until this shows up in a profile.
    const intents = listIntents(workspacePath)
    const matched = intents.find((r) => r.lastWorkSessionId === sessionId)
    if (!matched) {
      // Not an intent-linked session — nothing more to do.
      return
    }

    // Fire-and-forget: write the session conclusion to intent_sessions.
    // Must NOT block the run:settled handler (no await).
    // Errors are caught internally; a failed write is logged but harmless.
    void writeIntentSessionConclusion(sessionId, matched.id, reason, workspacePath)

    // Refresh the intent list for clients tracking this project.
    broadcastIntents(workspacePath)

    // Manual vs automation split (MSC-R1): automation drives its own commit/PR
    // in `notifyTurnSettled`; a session NOT owned by the active orchestrator is a
    // manual Start-Work session, so run the session-end Git/PR cleanup for it.
    // Fire-and-forget — must not block the run:settled handler.
    if (!isIntentDrivenByWorkflow(workspacePath, matched.id)) {
      void runManualDevCleanup(matched.id, workspacePath, cleanupDeps, sessionId)
        .then((outcome) => {
          if (outcome.kind === 'failed') {
            const intent = getIntent(matched.id)
            if (intent) publishIntentLifecycle(workspacePath, intent, 'failed')
          }
        })
        .catch((err) => {
          console.error('[c3:intent-cleanup] manual dev cleanup failed:', err)
        })
    }

    // Forward to the automation controller (no-op if automation is idle).
    notifyTurnSettled(workspacePath, sessionId, reason, matched.id)
  })

  // ── run:settled (sessionKind=discussion) — discussion domain ──────────────
  // Broadcast the refreshed discussion list when a discussion run (research
  // or orchestrator) settles. The discussion run starters in
  // `discussion-runs.ts` publish `run:started`/`run:bound` on start and
  // `run:settled` on finish/abort/error; this subscription reacts to the
  // latter to refresh the domain list.
  eventBus.subscribe('run:settled', ({ workspacePath, sessionKind }) => {
    if (sessionKind !== 'discussion') return
    broadcastDiscussions(workspacePath)
  })

  // ── run:settled (sessionKind=automation) — automation domain ──────────────────
  // Broadcast the refreshed automation list when a scheduled execution
  // settles. The automation engine in `scheduler.ts` publishes
  // `run:started`/`run:bound`/`run:settled` with sessionKind='automation' around
  // each `execute()` call; this subscription replaces the old
  // `store.broadcast` call in `dispatchAndTrack`'s `.finally()`.
  eventBus.subscribe('run:settled', ({ workspacePath, sessionKind }) => {
    if (sessionKind !== 'automation') return
    broadcastAutomations(workspacePath)
  })

  // ── run:settled (sessionKind=spec) — spec-link safety-net sweep ───────────────
  // If a spec run settles without ever binding (an error-before-bind edge),
  // clear its pending spec-link entry so the in-memory map never leaks. The
  // happy path already consumed the entry via takePendingSpecLink on bind, so
  // this is an idempotent no-op there.
  eventBus.subscribe('run:settled', ({ sessionId, sessionKind }) => {
    if (sessionKind !== 'spec') return
    clearPendingSpecLink(sessionId)
  })

  // ── run:settled (sessionKind=intent) — intent-link safety-net sweep ───────────
  // If a refine run settles without ever binding (error-before-bind), clear its
  // pending intent-link entry so the in-memory map never leaks. The happy path
  // already consumed the entry via takePendingIntentLink on bind, so this is an
  // idempotent no-op there.
  eventBus.subscribe('run:settled', ({ sessionId, sessionKind }) => {
    if (sessionKind !== 'intent') return
    clearPendingIntentLink(sessionId)
  })

  // ── run:settled (sessionKind=work) — wait-user-involve event cancel ──
  // When a work run settles for ANY reason (complete / error / aborted),
  // cancel all still-todo wait-user-involve events for that session.
  // This is a safety net: if the user closes the tab or the process crashes
  // before resolving a pending permission request, the event won't be stuck
  // in 'todo' forever. Events are keyed by the producing session_id, so only
  // this session's events are affected (other kinds like intent/discussion carry
  // different session_ids and are left untouched).
  // Broadcast the refreshed todo list after cancellation.
  eventBus.subscribe('run:settled', ({ sessionId, workspacePath, sessionKind }) => {
    if (sessionKind !== 'work') return
    if (!isWaitUserEventsStoreAvailable()) return
    cancelBySessionId(sessionId)
    broadcastWaitUserEvents(workspacePath)
  })

  // ── pr:operation (update/success) — intent PR-status reset ────────────────
  // Resident intent-domain consumer, registered alongside the run-lifecycle
  // subscriptions and INDEPENDENT of the Automation dispatch bridge in
  // `scheduler-startup.ts`. When the model publishes `update/success` for an
  // intent whose PR was rejected/failed/closed, reset it back to `reviewing`,
  // log `pr_updated`, and broadcast. All other cases are silently ignored.
  eventBus.subscribe('pr:operation', (payload) => {
    handlePrUpdateEvent(payload, {
      getIntent,
      pathToId,
      setPrStatus,
      safeInsertIntentLog,
      broadcastIntents,
    })
  })
}

// ---------------------------------------------------------------------------
// Fire-and-forget: write the session conclusion to intent_sessions.
// Called from the run:settled subscription when a session is matched to an
// intent's lastWorkSessionId. Must never throw; errors are caught internally
// and logged. Does NOT block run:settled (caller passes `void` on return).
// ---------------------------------------------------------------------------

/**
 * Map a {@link RunEndReason} from the run lifecycle to the
 * {@link IntentDevSessionExitCode} stored in intent_sessions.
 */
function toExitCode(reason: string): IntentDevSessionExitCode {
  switch (reason) {
    case 'complete':
      return 'success'
    case 'error':
      return 'failure'
    case 'aborted':
      return 'cancelled'
    default:
      return 'failure'
  }
}

/**
 * Produce the summary string in JSON-frontmatter + Markdown format.
 * The JSON frontmatter contains structured fields (exitCode, timestamp);
 * the Markdown body contains the files_changed (git diff stat).
 */
function buildSessionSummary(exitCode: string, gitDiff: string): string {
  const now = Date.now()
  const frontmatter = JSON.stringify({ exitCode, timestamp: now })
  const body = gitDiff ? `\n${gitDiff}` : ''
  return `---\n${frontmatter}\n---${body}`
}

/**
 * Fire-and-forget intent_sessions write. Finds the intent session record
 * for the (sessionId, intentId) pair and updates it with:
 *  - exit_code (mapped from the run:settled reason)
 *  - end_at (current timestamp)
 *  - summary containing the git diff snapshot
 *
 * All errors are caught internally. The caller must NOT await this function
 * — it must be fire-and-forget to avoid blocking the run:settled handler.
 */
async function writeIntentSessionConclusion(
  sessionId: string,
  intentId: string,
  reason: string,
  workspacePath: string,
): Promise<void> {
  try {
    // 1. Find the session record inserted at run:bound time.
    const record = getIntentSessionBySessionId(sessionId, intentId)
    if (!record) {
      // No record found — either the insert at run:bound was skipped
      // (degradation) or this session wasn't tracked. Nothing to update.
      return
    }

    // 2. Map exit code.
    const exitCode = toExitCode(reason)

    // 3. Read git diff stat asynchronously.
    const filesChanged = await gitDiffStat(workspacePath).catch(() => '')

    // 4. Build summary.
    const summary = buildSessionSummary(exitCode, filesChanged)

    // 5. Write the conclusion.
    updateIntentSession(record.id, {
      exitCode,
      endAt: Date.now(),
      summary,
    })
  } catch (err) {
    // Fire-and-forget: never let an error propagate to the subscription handler.
    console.error('[c3:intent-session] failed to write session conclusion:', err)
  }
}
