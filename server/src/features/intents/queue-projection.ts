/**
 * The queue control layer's read models.
 *
 * Two projections live here: the coarse `WorkflowStatus` a workspace broadcasts,
 * and the per-intent queue detail the queue page renders. Both are derived —
 * from the kernel's output, the persisted scheduling metadata and the decision
 * log — so a projection can never become a second source of truth.
 *
 * This is control-layer code, not an action executor: nothing here writes queue
 * state or starts anything.
 */
import type { WorkflowStatus } from '@ccc/shared/protocol'
import type { QueueDecision, QueueReconcileOutput } from '../../kernel/queue/index.js'
import { emptyQueueIntentMeta, relayEngaged } from '../../kernel/queue/index.js'
import { activeIntentPrs } from '@ccc/shared'
import { getGitBranchMode } from '../../kernel/config/index.js'
import { pathToName } from '../../state.js'
import { mergeAuthorized, mergeRecoveryPending } from './merge-authority.js'
import { isStoreAvailable, listIntents } from './store.js'
import {
  getQueueControl,
  getQueueIntentMeta,
  latestQueueDecisionByIntent,
  type QueueControlRow,
} from './queue-store.js'

// ---------------------------------------------------------------------------
// WorkflowStatus
// ---------------------------------------------------------------------------

export function idleStatus(workspacePath: string): WorkflowStatus {
  return {
    workspaceName: pathToName(workspacePath)!,
    state: 'idle',
    currentIntentId: null,
    currentSessionId: null,
    awaitingPermission: false,
    error: null,
    completedIds: [],
    startedAt: null,
    checkpointConsensus: null,
  }
}

/**
 * Fold one pass's output onto the workspace status, in place. `fixing` is the
 * controller's own view of its in-flight runs — the kernel has no notion of a
 * lint-repair turn, so that phase can only be observed here.
 */
export function projectStatus(
  status: WorkflowStatus,
  output: QueueReconcileOutput,
  control: QueueControlRow,
  fixing: boolean,
): void {
  status.state = fixing ? 'fixing' : output.state
  status.currentIntentId = output.currentIntentId
  status.currentSessionId = output.currentSessionId
  status.awaitingPermission = output.awaitingPermission
  status.startedAt = control.startedAt
  // The kernel isolates failures per intent, so the queue as a whole no longer
  // carries a stop reason. The most recent park is what a user needs to see.
  const parked = output.decisions.find((d) => d.action === 'park')
  status.error = parked ? `${parked.reason}: ${parked.detail}` : null
}

// ---------------------------------------------------------------------------
// Queue detail
// ---------------------------------------------------------------------------

/** The queue's per-intent view for the queue page. */
export interface QueueIntentView {
  intentId: string
  title: string
  blockedReason: string
  blockedDetail: string
  nextWakeupAt: number | null
  lastAction: string
  lastDecidedAt: number | null
  attemptCount: number
  backoffCount: number
  backoffUntil: number | null
  parked: boolean
  parkReason: string | null
  parkDetail: string | null
  forceSkipped: boolean
  /**
   * Place in the line while the concurrency gate holds this intent back; `null`
   * otherwise. Unlike the fields above it NEVER falls back to the persisted
   * decision log: a stale position would keep claiming a place the queue has
   * already re-sorted.
   */
  queuePosition: number | null
}

export interface QueueDetailView {
  state: WorkflowStatus['state']
  tickId: string
  nextWakeupAt: number | null
  items: QueueIntentView[]
}

/**
 * Build the queue detail projection. The live snapshot (this workspace's state,
 * tick id and latest in-memory decisions) is passed in by the control layer; the
 * persisted metadata and the decision log are read here. An intent the queue has
 * never touched projects as zero-value metadata rather than being omitted.
 */
export function buildQueueDetail(
  workspacePath: string,
  live: {
    state: WorkflowStatus['state']
    tickId: string
    nextWakeupAt: number | null
    decisions: readonly QueueDecision[]
  },
): QueueDetailView {
  const control = getQueueControl(workspacePath)
  const meta = getQueueIntentMeta(workspacePath)
  const latest = latestQueueDecisionByIntent(workspacePath)
  const decisions = new Map(live.decisions.map((d) => [d.intentId, d]))
  const skipped = new Set(control.forceSkipped)
  const intents = isStoreAvailable() ? listIntents(workspacePath) : []
  const worktreeMode = getGitBranchMode(workspacePath) === 'worktree'

  // The SAME candidate rule the scheduler applies: development candidates plus
  // intents whose work is done but whose PR is still in the review → fix relay.
  // An intent waiting on (or parked by) its review must keep its row here, or the
  // page would claim the queue is finished while it is still driving that PR.
  const items: QueueIntentView[] = intents
    .filter((r) => {
      const m = meta[r.id] ?? emptyQueueIntentMeta(r.id)
      return (
        (r.automate && (r.status === 'todo' || r.status === 'in_progress')) ||
        relayEngaged({
          worktreeMode,
          automate: r.automate,
          status: r.status,
          hasActivePr: activeIntentPrs(r.prs).length > 0,
          reviewStatus: r.reviewStatus,
          impactLevel: r.impactLevel,
          // An approved intent the queue is still landing stays on the page: the
          // merge is queue work, and hiding it would claim the queue is finished
          // while it is talking to a forge.
          mergeAuthorized: mergeAuthorized(r, m),
          mergeRecovery: mergeRecoveryPending(m),
        })
      )
    })
    .map((r) => {
      const m = meta[r.id] ?? emptyQueueIntentMeta(r.id)
      const d = decisions.get(r.id)
      const prev = latest[r.id]
      return {
        intentId: r.id,
        title: r.title,
        blockedReason: d?.reason ?? prev?.blockedGate ?? '',
        blockedDetail: d?.detail ?? prev?.rejectReason ?? '',
        nextWakeupAt: d?.nextWakeupAt ?? prev?.nextWakeupAt ?? null,
        lastAction: d?.action ?? prev?.action ?? '',
        lastDecidedAt: prev?.decidedAt ?? null,
        attemptCount: m.failureCount,
        backoffCount: m.backoffCount,
        backoffUntil: m.backoffUntil,
        parked: m.parked,
        parkReason: m.parkReason,
        parkDetail: m.parkDetail,
        forceSkipped: skipped.has(r.id),
        queuePosition: d?.queuePosition ?? null,
      }
    })

  return { state: live.state, tickId: live.tickId, nextWakeupAt: live.nextWakeupAt, items }
}
