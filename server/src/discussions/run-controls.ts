/**
 * Discussion run controls — feature-private live state (server refactor 2/3a).
 *
 * Moved out of the `server.ts` startup closure (ADR-0009 slice 2/3 "real moves"):
 * the live discussion/research run maps are discussion-private — only the
 * `discussions` feature and the discussion run starters read them — so by the
 * hard rule "transport-shared vs feature-private", they belong to this feature
 * module, NOT to the shared `KernelContext`. Exposed as a narrow function API (no
 * raw `Map`s leak across the boundary). Behavior is unchanged from the closure.
 */
import type { Discussion } from '@ccc/shared/protocol'

/**
 * Per-run control for a live discussion orchestration. `abort` tears it down
 * (server teardown); `paused` + `resumeWaiters` implement a pause gate the loop
 * awaits at each round boundary (no new speech while paused) — resume and abort
 * both wake the waiters so neither resume nor teardown can hang on a paused loop.
 */
export interface DiscussionRunControl {
  abort: AbortController
  paused: boolean
  resumeWaiters: Array<() => void>
}

/**
 * Live discussion-engine runs, keyed by discussion id. A present entry is the
 * "already running" re-entry guard for `start_discussion` / `continue_discussion`.
 */
const discussionRuns = new Map<string, DiscussionRunControl>()

/**
 * Live research runs, keyed by discussion id. A present entry means the read-only
 * research agent is still working (its abort controller tears it down on teardown).
 * The map's presence IS the liveness: settle (success/fail/dead process) deletes it.
 */
const researchRuns = new Map<string, AbortController>()

/** The live run control for a discussion (the re-entry guard reads this). */
export function getDiscussionRun(id: string): DiscussionRunControl | undefined {
  return discussionRuns.get(id)
}

/** Whether a discussion currently has a live orchestration run. */
export function hasDiscussionRun(id: string): boolean {
  return discussionRuns.has(id)
}

/** Register a discussion's live run control. */
export function setDiscussionRun(id: string, ctrl: DiscussionRunControl): void {
  discussionRuns.set(id, ctrl)
}

/** Drop a discussion's run control on settle/teardown. */
export function deleteDiscussionRun(id: string): void {
  discussionRuns.delete(id)
}

/** Register a discussion's live research run (its abort controller). */
export function setResearchRun(id: string, abort: AbortController): void {
  researchRuns.set(id, abort)
}

/** Drop a discussion's research run on settle/teardown. */
export function deleteResearchRun(id: string): void {
  researchRuns.delete(id)
}

/**
 * Live run-state snapshot for a discussion list: id → `running`/`paused` for
 * every listed discussion that currently has an active run (absent = no live
 * run, falls back to status). Rides the `discussions` message so a refresh/
 * reconnect reconciles background runs accurately — `discussion_run_status` only
 * fires on transitions and is missed by a freshly-(re)connected view.
 */
export function discussionRunSnapshot(items: Discussion[]): Record<string, 'running' | 'paused'> {
  const snapshot: Record<string, 'running' | 'paused'> = {}
  for (const d of items) {
    const ctrl = discussionRuns.get(d.id)
    if (ctrl) snapshot[d.id] = ctrl.paused ? 'paused' : 'running'
  }
  return snapshot
}

/**
 * Research-phase companion to `discussionRunSnapshot` — id → `running` for every
 * listed discussion with a live research run. Rides the `discussions` send so a
 * refresh/reconnect mid-research rebuilds the research phase (the transition-only
 * `research_run_status` is missed by a freshly-(re)connected view).
 */
export function researchRunSnapshot(items: Discussion[]): Record<string, 'running'> {
  const snapshot: Record<string, 'running'> = {}
  for (const d of items) if (researchRuns.has(d.id)) snapshot[d.id] = 'running'
  return snapshot
}
