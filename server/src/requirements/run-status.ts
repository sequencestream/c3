/**
 * Requirement run-status — feature-private derived state (server refactor 2/3a).
 *
 * Moved out of the `server.ts` startup closure (ADR-0009 slice 2/3 "real moves"):
 * the runStatus cache and the dead-session de-dup map are requirement-private —
 * only the `requirements` feature and the requirement broadcast read them — so by
 * the hard rule "transport-shared vs feature-private", they belong to this feature
 * module, NOT to the shared `KernelContext`. Exposed as a narrow function API (no
 * raw `Map`s leak across the boundary). Behavior is unchanged from the closure.
 */
import type { Requirement, RequirementRunStatus } from '@ccc/shared/protocol'
import { isRunning } from '../runs.js'

/**
 * Per-requirement runStatus cache, populated by reconcileInProgress on
 * open_requirement_chat and consumed by `enrichRunStatus` during requirement
 * broadcasts. This is a DERIVED-field cache (runStatus is not stored in the DB);
 * the key is requirement id, and entries are overwritten on each fresh reconcile.
 * Cleared when a requirement leaves in_progress.
 */
const runStatusCache = new Map<string, RequirementRunStatus>()

/**
 * Dead-session de-dup for reconcile (perf). Maps requirement id → the
 * `lastDevSessionId` we last ran the completion judge against while its process
 * was dead. Judging a dead session is an LLM call that yields the same verdict
 * every time, yet open_requirement_chat fires on every entry, refresh, and WS
 * reconnect — so we skip a requirement whose CURRENT dead session is already
 * recorded here. A live process (re-derived cheaply) or a brand-new session id
 * (differs from the record) still gets (re)judged. Cleared when a requirement
 * leaves in_progress.
 */
const judgedSessions = new Map<string, string>()

/** Cache the derived runStatus for a requirement (used by `enrichRunStatus`). */
export function cacheRunStatus(id: string, status: RequirementRunStatus): void {
  runStatusCache.set(id, status)
}

/** Drop a requirement's cached runStatus (when it leaves in_progress). */
export function clearRunStatus(id: string): void {
  runStatusCache.delete(id)
}

/** The dead session last judged for a requirement (de-dup key), if any. */
export function getJudgedSession(id: string): string | undefined {
  return judgedSessions.get(id)
}

/** Record the dead session last judged for a requirement (de-dup). */
export function setJudgedSession(id: string, sessionId: string): void {
  judgedSessions.set(id, sessionId)
}

/** Drop a requirement's judged-session record (when it leaves in_progress). */
export function clearJudgedSession(id: string): void {
  judgedSessions.delete(id)
}

/**
 * Enrich a requirements list with the correct (derived) runStatus for each
 * in_progress item. Priority order:
 * 1. Process still running in the runtime registry → `running`.
 * 2. Cached from the most recent reconcile → `dangling` (or `idle` for
 *    auto-completed items whose status hasn't been re-read yet).
 * 3. Fallback → `idle` (no reconcile data — first entry or status changed).
 *
 * Pure (ADR-0009 R4): read-only over its input, never writes the cache.
 */
export function enrichRunStatus(items: Requirement[]): Requirement[] {
  return items.map((r) => {
    if (r.status !== 'in_progress') return r
    if (r.lastDevSessionId && isRunning(r.lastDevSessionId))
      return { ...r, runStatus: 'running' as const }
    const cached = runStatusCache.get(r.id)
    if (cached) return { ...r, runStatus: cached }
    return r
  })
}
