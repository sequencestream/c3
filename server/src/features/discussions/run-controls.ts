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
import type { ResearchStreamItem } from './research.js'

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
 * Abort every live run bound to ONE discussion — its orchestration loop and/or its
 * read-only research run — and report which were actually alive. The teardown entry
 * for `cancel_discussion`: same abort path {@link abortAllRuns} uses for shutdown, so
 * the settle rules that already key off `signal.aborted` apply unchanged (the
 * orchestrator appends nothing more and writes no conclusion; the research run neither
 * writes back its half-finished findings nor auto-starts an orchestration).
 *
 * A paused loop is woken too, so it observes the abort instead of parking on its gate.
 * Idempotent: each run's own settle path removes its registry entry, so a second call
 * reports `false` for both.
 */
export function abortDiscussionRuns(id: string): { discussion: boolean; research: boolean } {
  const ctrl = discussionRuns.get(id)
  if (ctrl) {
    ctrl.abort.abort()
    const waiters = ctrl.resumeWaiters.splice(0)
    for (const wake of waiters) wake()
  }
  const research = researchRuns.get(id)
  if (research) research.abort()
  return { discussion: !!ctrl, research: !!research }
}

/**
 * Abort every live orchestration + research run. The graceful-shutdown path calls
 * this BEFORE it awaits anything: the vendor children die with this process, and a
 * run that settles with its abort flag unset looks exactly like a normal completion
 * — the research settle rule would then write a half-finished output back as the
 * findings AND auto-start an orchestration that the very same shutdown is about to
 * kill (leaving a dangling `in_progress` discussion with no messages).
 *
 * Paused loops are woken too, so a paused orchestration observes the abort instead
 * of parking on its gate forever. Idempotent: each run's own settle path removes
 * its entry, so a second call sees an empty map.
 */
export function abortAllRuns(): { discussions: number; research: number } {
  const discussions = discussionRuns.size
  for (const ctrl of discussionRuns.values()) {
    ctrl.abort.abort()
    const waiters = ctrl.resumeWaiters.splice(0)
    for (const wake of waiters) wake()
  }
  const research = researchRuns.size
  for (const abort of researchRuns.values()) abort.abort()
  return { discussions, research }
}

/**
 * Bounded runtime transcript of a live research run's visible items, keyed by
 * discussion id. Holds the items broadcast so far so a reconnect/refresh
 * mid-research can replay them on the `discussion_detail` snapshot — the items
 * are never persisted, and the buffer is dropped when the run settles. Bounded so
 * a chatty run can't grow it without limit (oldest items drop first; the tail —
 * the most recent activity — is what the reconnecting view needs most).
 */
const researchTranscripts = new Map<string, ResearchStreamItem[]>()

/** Max retained research items per discussion (oldest drop past this). */
const RESEARCH_TRANSCRIPT_CAP = 500

/** Append one broadcast research item to the discussion's runtime transcript (bounded). */
export function appendResearchTranscript(id: string, item: ResearchStreamItem): void {
  const buf = researchTranscripts.get(id)
  if (buf) {
    buf.push(item)
    if (buf.length > RESEARCH_TRANSCRIPT_CAP) buf.splice(0, buf.length - RESEARCH_TRANSCRIPT_CAP)
  } else {
    researchTranscripts.set(id, [item])
  }
}

/** Snapshot of a discussion's runtime research transcript (empty when none/ended). */
export function getResearchTranscript(id: string): ResearchStreamItem[] {
  return researchTranscripts.get(id) ?? []
}

/** Drop a discussion's runtime research transcript on settle/teardown. */
export function clearResearchTranscript(id: string): void {
  researchTranscripts.delete(id)
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
