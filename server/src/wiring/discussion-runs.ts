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
 * `startDiscussionRun` additionally publishes the DOMAIN lifecycle pair
 * `discussion:lifecycle` (`phase='start'` / `'end'` + terminal reason). It is the
 * single boundary all three start entries share — MCP `start_discussion`, the Web
 * UI start, and `continue_discussion`'s new round / dangling recovery — so the
 * pair is emitted once per orchestration attempt without any per-entry code.
 * `startResearchRun` is a separate preparation stage and publishes NEITHER.
 *
 * IMPORTANT (kernel boundary, ADR-0009 R1/R2/R6):
 * - This module lives in `wiring/`. It imports features (engine + store +
 *   run-controls) and the broadcast bag. It does NOT import ws/HTTP semantics
 *   and does NOT touch the kernel registry directly.
 */
import type { Discussion, RunEndReason, VendorId } from '@ccc/shared/protocol'
import type { DiscussionLifecyclePhase } from '@ccc/shared'
import { resolveWorkspaceRoot } from '../state.js'
import type { EventBus, EventBusEvents } from '../kernel/events/event-bus.js'
import type { VendorAdapter } from '../kernel/agent/adapters/types.js'
import {
  canAutoStartDiscussion,
  researchDiscussionContext,
  resolveResearchAgent,
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
  setDiscussionResearchSessionId,
} from '../features/discussions/store.js'
import { emit, ensureRuntime, finalizeRun, getRuntime, setStatus } from '../runs.js'
import { freezeSessionAgent } from '../kernel/agent-config/index.js'
import {
  deleteByVendorId,
  touchByOwner,
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
 * Projection title for a discussion's research session. Same `<discussion> · <role>`
 * shape as the per-agent sessions above, so the sessions page's 「讨论」 category
 * reads consistently; the role segment is the fixed researcher marker rather than an
 * agent display name (research is not any participant's session).
 */
function researchSessionTitle(discussionTitle: string): string {
  return `${discussionTitle} · Research`
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

/** The two run starters the long-lived `KernelContext` exposes, plus the research settle rule. */
export interface DiscussionRuns {
  startDiscussionRun: (discussion: Discussion) => void
  startResearchRun: (discussion: Discussion) => void
  /**
   * The single settle rule for a research session's turn — applied identically to
   * the first, unattended pass and to every user follow-up. See
   * {@link createDiscussionRuns} for the semantics.
   */
  settleResearchTurn: (discussionId: string, researchResult: string, ok: boolean) => void
}

/**
 * The final assistant text of a session's LAST turn, read back from its runtime
 * buffer — the research write-back's text source for a follow-up turn (the first
 * pass captures the same value inline as it streams). Turn-scoped: a `user_text`
 * event resets the accumulator, so an earlier turn's findings never leak into a
 * later, empty one. The claude path emits one `assistant_text` per whole assistant
 * message, so "last one wins" is the same rule the unattended pass applies.
 */
function finalAssistantText(sessionId: string): string {
  const rt = getRuntime(sessionId)
  if (!rt) return ''
  let text = ''
  for (const ev of rt.buffer) {
    if (ev.type === 'user_text') text = ''
    else if (ev.type === 'assistant_text') text = ev.text
  }
  return text.trim()
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

  /**
   * The freshest persisted record for a discussion, falling back to the snapshot
   * this run started from when the store is unavailable, the row is gone, or the
   * read throws. Used at the settle boundary so `discussion:end` reports the
   * metadata/title as persisted at settle time.
   */
  const latestDiscussion = (snapshot: Discussion): Discussion => {
    try {
      return getDiscussion(snapshot.id) ?? snapshot
    } catch {
      return snapshot
    }
  }

  /**
   * Publish one discussion orchestration boundary. Assembling or publishing it
   * must never affect the orchestration outcome or the run cleanup, so the whole
   * body is guarded (the bus itself already isolates subscriber errors).
   */
  const publishDiscussionLifecycle = (
    discussion: Discussion,
    phase: DiscussionLifecyclePhase,
    reason?: RunEndReason,
  ): void => {
    try {
      const workspacePath = resolveWorkspaceRoot(discussion.workspaceId)
      if (!workspacePath) return
      eventBus.publish('discussion:lifecycle', {
        workspacePath,
        phase,
        discussionId: discussion.id,
        title: discussion.title,
        discussionType: discussion.type,
        metadata: discussion.metadata ?? {},
        ...(reason ? { reason } : {}),
      })
    } catch (err) {
      console.warn(`[c3] discussion lifecycle publish failed: ${errMsg(err)}`)
    }
  }

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
    // The domain boundary all three entries (MCP start, Web UI start, continue's
    // new round / dangling recovery) funnel through — one `discussion:start` per
    // orchestration attempt, alongside (never instead of) the generic run events.
    publishDiscussionLifecycle(discussion, 'start')

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
          touchByOwner('discussion', discussionId)
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
        // Exactly one `discussion:end` on the single settle path, whatever the
        // terminal reason. It must never break the run cleanup below, so the
        // record re-read and the publish are both fault-tolerant.
        publishDiscussionLifecycle(latestDiscussion(discussion), 'end', settledReason)
        deleteDiscussionRun(discussion.id)
        broadcastDiscussionRunStatus(discussion.id, 'ended')
      })
  }

  /**
   * The ONE settle rule for a research session's turn — the first unattended pass
   * and every user follow-up go through this and nothing else:
   *
   *  1. A non-empty final text REPLACES `researchResult`; an empty or failed turn
   *     leaves the previous value untouched (a bad follow-up can never clobber good
   *     findings).
   *  2. The refreshed discussion list is pushed, so the 「研究」 markdown tab updates
   *     in place with no manual refresh.
   *  3. The auto-start guard is re-evaluated on the FRESHEST record — a still-draft
   *     discussion with no live run starts its orchestration. That keeps the initial
   *     auto-start, lets a follow-up rescue a research that failed first time round,
   *     and cannot re-trigger on an already-running or finished discussion.
   *
   * `ok=false` (the turn threw / was aborted) skips only step 3: a failed research
   * never auto-starts, leaving the draft for the manual Start fallback.
   */
  const settleResearchTurn = (discussionId: string, researchResult: string, ok: boolean): void => {
    const text = researchResult.trim()
    if (text) {
      try {
        setDiscussionResearchResult(discussionId, text)
      } catch (err) {
        console.warn(`[c3] discussion research write-back failed: ${errMsg(err)}`)
      }
    }
    const latest = getDiscussion(discussionId)
    if (!latest) return
    broadcastDiscussions(resolveWorkspaceRoot(latest.workspaceId)!)
    if (!ok) return
    if (canAutoStartDiscussion(latest, hasDiscussionRun(discussionId))) {
      startDiscussionRun(latest)
    }
  }

  // Start the read-only research run for a freshly-created discussion as an
  // observable run (mirrors `startDiscussionRun`): register liveness, broadcast
  // `running`, stream each turn, and on settle apply the shared research settle
  // rule. Fire-and-forget — research never blocks creation.
  //
  // The run is ALSO a first-class session: as soon as the vendor reports its
  // session id we persist it on the discussion, freeze the session→agent fact,
  // register a `SessionRuntime` under it (so the 「研究会话」 tab shows the
  // unattended run live, with a working Stop) and project a session-metadata row
  // (so it is listed under the sessions page's 「讨论」 category). The runtime-only
  // research stream + liveness broadcasts are kept untouched alongside it, so
  // 「过程会话」 renders exactly as before.
  //
  // Publishes `run:started`/`run:bound`/`run:settled` with sessionKind='discussion'
  // on the kernel event bus. The `ended`-before-auto-start order means the
  // right pane switches research → discussion in one batch; a failed research
  // broadcasts `ended` without auto-start, surfacing the manual Start fallback.
  const startResearchRun = (discussion: Discussion): void => {
    const workspacePath = resolveWorkspaceRoot(discussion.workspaceId)!
    // The research executor, resolved ONCE up front — organizer-first with the
    // orchestration loop's criterion, and an explicit claude fallback (the loop
    // is claude-hardwired). This single result drives the first turn, the
    // session→agent freeze, and the bound-row projection below, so executor,
    // frozen value and index row can never diverge even if the agent registry
    // changes between launch and the vendor's session-id report.
    const researchAgent = resolveResearchAgent(discussion)
    const abort = new AbortController()
    // Fresh runtime transcript for this run (clears any stale buffer from a prior
    // aborted run on the same discussion id).
    clearResearchTranscript(discussion.id)
    setResearchRun(discussion.id, abort)
    broadcastResearchRunStatus(discussion.id, 'running')

    // Publish research run lifecycle events (2026-06-08-010).
    eventBus.publish('run:started', {
      sessionId: discussion.id,
      workspacePath,
      sessionKind: 'discussion',
      runKind: 'internal',
    })
    eventBus.publish('run:bound', {
      prevId: discussion.id,
      realId: discussion.id,
      workspacePath,
    })

    // Session identity for this run, bound the moment the vendor reports it. Wire
    // events emitted before that point (there are normally none) are held and
    // flushed on bind, so the runtime's buffer is the complete run.
    let researchSessionId: string | null = null
    const beforeBind: Parameters<typeof emit>[1][] = []
    const bindResearchSession = (sessionId: string): void => {
      if (researchSessionId) return
      researchSessionId = sessionId
      try {
        setDiscussionResearchSessionId(discussion.id, sessionId)
        // Freeze the session→agent fact onto the SAME single-resolved agent that
        // runs the first turn, so a follow-up resolves that identical claude
        // identity (and its store scope) and can actually resume this vendor
        // session.
        freezeSessionAgent(sessionId, sessionId, researchAgent.id, workspacePath, 'host')
        const rt = ensureRuntime(
          sessionId,
          workspacePath,
          'default',
          [],
          'discussion',
          undefined,
          'internal',
        )
        // The research marker (see `SessionRuntime.researchDiscussionId`): what makes
        // the read-only research profile apply to this session's follow-up turns.
        rt.researchDiscussionId = discussion.id
        rt.run = { abort, handle: null }
        setStatus(sessionId, 'running')
        upsertBoundRow({
          sessionId,
          workspacePath,
          vendor: researchAgent.vendor,
          agentId: researchAgent.id,
          title: researchSessionTitle(getDiscussion(discussion.id)?.title ?? discussion.title),
          sessionKind: 'discussion',
          ownerKind: 'discussion',
          ownerId: discussion.id,
        })
        for (const ev of beforeBind) emit(sessionId, ev)
        beforeBind.length = 0
        // Push the list so the open discussion learns its `researchSessionId` and
        // can render (and select) the 「研究会话」 tab while the run is still live.
        broadcastDiscussions(workspacePath)
      } catch (err) {
        console.warn(`[c3] discussion research session bind failed: ${errMsg(err)}`)
      }
    }
    // Tear the runtime's in-flight run down (idempotent). Keeps the runtime itself
    // so a viewer's replay survives; the session is reopened from the vendor's own
    // transcript once the runtime is eventually dropped.
    const releaseResearchSession = (): void => {
      if (!researchSessionId) return
      const rt = getRuntime(researchSessionId)
      if (rt) rt.run = null
      finalizeRun(researchSessionId)
    }

    void researchDiscussionContext(discussion, researchAgent, {
      signal: abort.signal,
      onSessionId: bindResearchSession,
      onWire: (ev) => {
        if (researchSessionId) emit(researchSessionId, ev)
        else beforeBind.push(ev)
      },
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
          workspacePath,
          reason,
          sessionKind: 'discussion',
          runKind: 'internal',
        })

        releaseResearchSession()
        deleteResearchRun(discussion.id)
        // Research ended → the right pane leaves the research phase, so the runtime
        // transcript is no longer needed (and `researchStates` no longer lists it).
        clearResearchTranscript(discussion.id)
        broadcastResearchRunStatus(discussion.id, 'ended')
        // One rule for both lifecycles: write back the findings, push the list, and
        // re-evaluate auto-start. An aborted run counts as failed — it never
        // auto-starts, leaving the draft for the manual Start fallback.
        settleResearchTurn(discussion.id, researchResult, reason === 'complete')
      })
      .catch((err) => {
        // Defensive: research itself swallows its run error (returns ok=false),
        // so this only fires on a wiring fault. Ensure settled fires for liveness.
        eventBus.publish('run:settled', {
          sessionId: discussion.id,
          workspacePath,
          reason: 'error',
          sessionKind: 'discussion',
          runKind: 'internal',
        })
        releaseResearchSession()
        deleteResearchRun(discussion.id)
        clearResearchTranscript(discussion.id)
        broadcastResearchRunStatus(discussion.id, 'ended')
        console.warn(`[c3] discussion research wiring error: ${errMsg(err)}`)
      })
  }

  return { startDiscussionRun, startResearchRun, settleResearchTurn }
}

/**
 * Read a research session's final text off its runtime and apply the shared settle
 * rule. This is the FOLLOW-UP half of the research write-back: the turn ran through
 * the generic session path, so the only thing the discussion domain has to add is
 * "take what the researcher just said and make it the findings".
 */
export function settleResearchSessionRun(
  runs: Pick<DiscussionRuns, 'settleResearchTurn'>,
  discussionId: string,
  sessionId: string,
  reason: RunEndReason,
): void {
  runs.settleResearchTurn(discussionId, finalAssistantText(sessionId), reason === 'complete')
}
