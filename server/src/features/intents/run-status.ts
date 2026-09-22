/**
 * Intent run-status — feature-private derived state (server refactor 2/3a).
 *
 * Moved out of the `server.ts` startup closure (ADR-0009 slice 2/3 "real moves"):
 * the runStatus cache and the dead-session de-dup map are intent-private —
 * only the `intents` feature and the intent broadcast read them — so by
 * the hard rule "transport-shared vs feature-private", they belong to this feature
 * module, NOT to the shared `KernelContext`. Exposed as a narrow function API (no
 * raw `Map`s leak across the boundary). Behavior is unchanged from the closure.
 */
import type { Intent, IntentRunStatus } from '@ccc/shared/protocol'
import { isRunning } from '../../runs.js'
import { deriveActionDescriptor, type WorkspaceIntentsLoader } from './action-descriptor.js'
import { isSpecOccupancyAlive } from './spec-occupancy.js'
import { listIntents } from './store.js'

/**
 * Per-intent runStatus cache, populated by reconcileInProgress on
 * open_intent_session and consumed by `enrichRunStatus` during intent
 * broadcasts. This is a DERIVED-field cache (runStatus is not stored in the DB);
 * the key is intent id, and entries are overwritten on each fresh reconcile.
 * Cleared when a intent leaves in_progress.
 */
const runStatusCache = new Map<string, IntentRunStatus>()

/**
 * Dead-session de-dup for reconcile (perf). Maps intent id → the
 * `lastWorkSessionId` we last ran the completion judge against while its process
 * was dead. Judging a dead session is an LLM call that yields the same verdict
 * every time, yet open_intent_session fires on every entry, refresh, and WS
 * reconnect — so we skip a intent whose CURRENT dead session is already
 * recorded here. A live process (re-derived cheaply) or a brand-new session id
 * (differs from the record) still gets (re)judged. Cleared when a intent
 * leaves in_progress.
 */
const judgedSessions = new Map<string, string>()

/** Cache the derived runStatus for a intent (used by `enrichRunStatus`). */
export function cacheRunStatus(id: string, status: IntentRunStatus): void {
  runStatusCache.set(id, status)
}

/** Drop a intent's cached runStatus (when it leaves in_progress). */
export function clearRunStatus(id: string): void {
  runStatusCache.delete(id)
}

/** The dead session last judged for a intent (de-dup key), if any. */
export function getJudgedSession(id: string): string | undefined {
  return judgedSessions.get(id)
}

/** Record the dead session last judged for a intent (de-dup). */
export function setJudgedSession(id: string, sessionId: string): void {
  judgedSessions.set(id, sessionId)
}

/** Drop a intent's judged-session record (when it leaves in_progress). */
export function clearJudgedSession(id: string): void {
  judgedSessions.delete(id)
}

/**
 * True when any of the intent's four session ids (intent / spec / spec review /
 * work) is a non-null id the run registry reports as running. Short-circuit OR;
 * missing, unknown, and stopped ids all count as inactive. Covers all statuses —
 * unlike `runStatus`, it is not gated on `in_progress`.
 */
function deriveSessionActive(r: Intent): boolean {
  return (
    (!!r.intentSessionId && isRunning(r.intentSessionId)) ||
    (!!r.specSessionId && isRunning(r.specSessionId)) ||
    (!!r.specReviewSessionId && isRunning(r.specReviewSessionId)) ||
    (!!r.lastWorkSessionId && isRunning(r.lastWorkSessionId))
  )
}

/**
 * Whether one relay phase's session field is still held by the relay — the
 * send-time projection of {@link isSpecOccupancyAlive}, which is verbatim the
 * rule the queue kernel's `probeRelayRunFacts` consumes.
 *
 * It is deliberately NOT `isRunning` (what {@link deriveSessionActive} answers
 * for the four session kinds): between a phase's claim and the vendor's bind the
 * field holds a `pending:` placeholder with no live process at all, and that
 * whole window must read as occupied or the UI would offer a second launch on a
 * worktree an agent is already about to enter. Reading it through the same
 * function the kernel uses is what keeps "the button is hidden" and "the queue
 * considers the phase busy" one fact, never two derivations that can drift.
 *
 * A stale `pending:` (row gone, or older than the grace window) reports `false`:
 * the launch died, the phase is recoverable, and the human must be able to
 * re-trigger the SAME round.
 */
export function deriveRelayPhaseInFlight(sessionId: string | null): boolean {
  if (!sessionId) return false
  return isSpecOccupancyAlive(sessionId, isRunning, Date.now())
}

/**
 * A per-send ledger reader for the dependency projection: the workspace's WHOLE
 * intent list, loaded at most once per workspace per enrich pass and only when an
 * intent actually declares a dependency. The batch being enriched cannot serve as
 * the ledger — `list_intents` may be status-filtered, and a predecessor filtered
 * out of the view is still a predecessor.
 */
function workspaceIntentsLoader(): WorkspaceIntentsLoader {
  const loaded = new Map<string, Intent[]>()
  return (workspacePath) => {
    const hit = loaded.get(workspacePath)
    if (hit) return hit
    const list = listIntents(workspacePath)
    loaded.set(workspacePath, list)
    return list
  }
}

/**
 * Enrich a intents list at the send boundary (list / refresh / `intents`
 * broadcast) so every send path derives identical fields:
 *
 * - `sessionActive` — always recomputed from the live registry for EVERY item
 *   regardless of status (see {@link deriveSessionActive}). A transient liveness
 *   signal, never stored or cached.
 * - `reviewInFlight` / `fixInFlight` — always recomputed for EVERY item from the
 *   relay occupancy rule (see {@link deriveRelayPhaseInFlight}), so the manual relay
 *   entry point in the title bar reads occupancy from the SAME boundary that the
 *   queue kernel derives its own facts at. Without this the client would have to
 *   guess from `reviewStatus === 'pending'`, which is exactly the value a dead
 *   launch leaves behind.
 * - `actionDescriptor` — always re-derived for EVERY item from blocked-state
 *   facts (vendor / wait-user / spec approval / dependency gate — see
 *   {@link deriveActionDescriptor}); `null` when nothing blocks the intent.
 *   Deriving it here — the one send boundary — is what makes list, refresh and
 *   broadcast show the same next step.
 * - `runStatus` — only in_progress items are reconciled. Priority order:
 *   1. Work-session process still running → `running`.
 *   2. Cached from the most recent reconcile → `dangling` (or `idle` for
 *      auto-completed items whose status hasn't been re-read yet).
 *   3. Fallback → keep the item's own value (no reconcile data yet).
 *
 * Pure (ADR-0009 R4): read-only over its input, never writes the cache.
 */
export function enrichRunStatus(items: Intent[]): Intent[] {
  const loadWorkspaceIntents = workspaceIntentsLoader()
  return items.map((r) => {
    const sessionActive = deriveSessionActive(r)
    const actionDescriptor = deriveActionDescriptor(r, loadWorkspaceIntents)
    const reviewInFlight = deriveRelayPhaseInFlight(r.reviewSessionId)
    const fixInFlight = deriveRelayPhaseInFlight(r.fixSessionId)
    const base = { ...r, sessionActive, reviewInFlight, fixInFlight, actionDescriptor }
    if (r.status !== 'in_progress') return base
    if (r.lastWorkSessionId && isRunning(r.lastWorkSessionId))
      return { ...base, runStatus: 'running' as const }
    const cached = runStatusCache.get(r.id)
    if (cached) return { ...base, runStatus: cached }
    return base
  })
}
