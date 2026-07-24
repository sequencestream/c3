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
 * True when any of the intent's three session ids (intent / spec / work) is a
 * non-null id the run registry reports as running. Short-circuit OR; missing,
 * unknown, and stopped ids all count as inactive. Covers all statuses — unlike
 * `runStatus`, it is not gated on `in_progress`.
 */
function deriveSessionActive(r: Intent): boolean {
  return (
    (!!r.intentSessionId && isRunning(r.intentSessionId)) ||
    (!!r.specSessionId && isRunning(r.specSessionId)) ||
    (!!r.lastWorkSessionId && isRunning(r.lastWorkSessionId))
  )
}

/**
 * Enrich a intents list at the send boundary (list / refresh / `intents`
 * broadcast) so every send path derives identical fields:
 *
 * - `sessionActive` — always recomputed from the live registry for EVERY item
 *   regardless of status (see {@link deriveSessionActive}). A transient liveness
 *   signal, never stored or cached.
 * - `runStatus` — only in_progress items are reconciled. Priority order:
 *   1. Work-session process still running → `running`.
 *   2. Cached from the most recent reconcile → `dangling` (or `idle` for
 *      auto-completed items whose status hasn't been re-read yet).
 *   3. Fallback → keep the item's own value (no reconcile data yet).
 *
 * Pure (ADR-0009 R4): read-only over its input, never writes the cache.
 */
export function enrichRunStatus(items: Intent[]): Intent[] {
  return items.map((r) => {
    const sessionActive = deriveSessionActive(r)
    if (r.status !== 'in_progress') return { ...r, sessionActive }
    if (r.lastWorkSessionId && isRunning(r.lastWorkSessionId))
      return { ...r, sessionActive, runStatus: 'running' as const }
    const cached = runStatusCache.get(r.id)
    if (cached) return { ...r, sessionActive, runStatus: cached }
    return { ...r, sessionActive }
  })
}
