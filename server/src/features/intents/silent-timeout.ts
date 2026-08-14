/**
 * Silent-timeout detection — the lowest-priority arm of `Intent.actionDescriptor`.
 *
 * "Nothing is happening" is the one failure the queue cannot describe: a park, a
 * backoff, a gate and a crash all leave a record, but an intent that simply stops
 * moving leaves none, so it reads as healthy forever. This module names that state
 * and nothing else — it detects and prompts, it never retries, restarts, resets or
 * un-parks anything.
 *
 * It is a **read-only projection over facts that already exist**: the ledger row,
 * the run registry's liveness, the persisted queue metadata and the queue decision
 * log. `kernel/queue` keeps owning scheduling; nothing here injects a gate, a
 * reason or an action into it, and nothing here is stored.
 *
 * Two rules do the real work:
 *  - **Only unexplained silence counts.** Every known wait — park, backoff,
 *    cooldown, any gate, force-skip, a human decision, the spec phase, a paused or
 *    idle queue — suppresses the prompt, so a more specific and more actionable
 *    explanation is never buried under a vague one.
 *  - **Repeating yourself is not progress.** A periodic tick that re-reaches the
 *    same conclusion must not renew the window, otherwise a stalled intent would
 *    stay "fresh" forever. Only the instant a fact actually CHANGED counts.
 */
import type { ActionDescriptor, Intent, IntentStatus } from '@ccc/shared/protocol'
import type { QueueReasonCode, QueueRunState } from '../../kernel/queue/index.js'
import { QUEUE_REASON_CODES } from '../../kernel/queue/index.js'
import { isAwaitingPermission, sessionLastActivityAt } from '../../runs.js'
import { resolveWorkspaceRoot } from '../../state.js'
import {
  getQueueControl,
  getQueueIntentMetaById,
  listQueueDecisionsForIntent,
  type QueueDecisionRow,
} from './queue-store.js'

/**
 * How long an intent may show no progress before the silence itself is reported.
 * The single server-side source of the window: clients render the conclusion and
 * never time anything themselves. Deliberately generous — a false "it is stuck"
 * on a slow but healthy intent costs more trust than a late true one.
 */
export const SILENT_TIMEOUT_MS = 30 * 60_000

/**
 * How far back the decision log is scanned when dating the current conclusion.
 * The log is already written deduplicated, so a handful of rows is plenty; a run
 * of identical rows longer than this dates the conclusion later than it really
 * began, which can only DELAY a prompt, never fabricate one.
 */
const DECISION_SCAN_LIMIT = 50

/**
 * The queue reasons that mean "the queue believes this intent is being driven
 * right now". Every other reason names a wait the user can already see — a gate, a
 * park, a backoff, a cooldown, a force-skip, a spec phase, a human decision, an
 * unreadable snapshot — and those states are explained, not silent.
 */
const DRIVING_QUEUE_REASONS: ReadonlySet<QueueReasonCode> = new Set<QueueReasonCode>([
  'selected',
  'attached_running',
  'resumed',
  'running',
])

/** Everything the judgement reads, so it can be exercised against a fixed clock. */
export interface SilentTimeoutFacts {
  now: number
  automate: boolean
  status: IntentStatus
  queueState: QueueRunState
  /** When the workspace's queue was started; `null` when it never was. */
  queueStartedAt: number | null
  forceSkipped: boolean
  parked: boolean
  /** No retry before this instant; `null` when not backing off. */
  backoffUntil: number | null
  /** Self-excitation guard deadline; `null` when none. */
  cooldownUntil: number | null
  /** Any of the intent's sessions is paused on an undecided permission prompt. */
  awaitingPermission: boolean
  /** The reason of the queue's current conclusion; `null` when it has none. */
  latestReason: QueueReasonCode | null
  /** Last ledger change for this intent (epoch ms). */
  ledgerUpdatedAt: number | null
  /** Most recent activity across the intent's runs; `null` when none is known. */
  runActivityAt: number | null
  /** Last change to the intent's persisted scheduling metadata. */
  metaUpdatedAt: number | null
  /** When the queue's CURRENT conclusion first appeared (deduplicated). */
  decisionChangedAt: number | null
}

/**
 * The most recent of a set of observed instants, or `null` when none is usable.
 * A missing fact and a zero-valued one are both "never observed" (the zero-value
 * queue metadata of an intent the queue has never touched carries `updatedAt: 0`).
 */
function latestFact(...instants: readonly (number | null | undefined)[]): number | null {
  let latest: number | null = null
  for (const at of instants) {
    if (typeof at !== 'number' || !Number.isFinite(at) || at <= 0) continue
    if (latest === null || at > latest) latest = at
  }
  return latest
}

/**
 * When the queue's current conclusion for this intent first appeared. `rows` is
 * newest-first; walking back over the identical ones is what stops a periodic
 * tick from renewing the silent window — re-deciding the same thing is not
 * progress, so only the instant the verdict CHANGED counts.
 */
export function decisionChangedAt(rows: readonly QueueDecisionRow[]): number | null {
  const newest = rows[0]
  if (!newest) return null
  let changedAt = newest.decidedAt
  for (const row of rows) {
    if (
      row.action !== newest.action ||
      row.blockedGate !== newest.blockedGate ||
      row.rejectReason !== newest.rejectReason
    ) {
      break
    }
    changedAt = row.decidedAt
  }
  return latestFact(changedAt)
}

/**
 * The judgement itself: is this intent silently stuck at `facts.now`?
 *
 * Pure and total — every "cannot tell" path answers `false`, so a missing fact, a
 * clock that jumped backwards and a timestamp from the future all stay quiet
 * rather than inventing a prompt.
 */
export function isSilentTimeout(facts: SilentTimeoutFacts): boolean {
  // Only automated, still-open intents under a RUNNING queue are being waited on
  // at all. An idle or paused queue is not trying to make progress, and a terminal
  // intent has none left to make.
  if (!facts.automate) return false
  if (facts.status !== 'todo' && facts.status !== 'in_progress') return false
  if (facts.queueState !== 'running') return false

  // Known waits, each already visible elsewhere.
  if (facts.parked || facts.forceSkipped || facts.awaitingPermission) return false
  if (facts.backoffUntil !== null && facts.backoffUntil > facts.now) return false
  if (facts.cooldownUntil !== null && facts.cooldownUntil > facts.now) return false
  // No conclusion at all means the queue has not said anything about this intent,
  // which is not evidence of silence — it is absence of evidence.
  if (facts.latestReason === null || !DRIVING_QUEUE_REASONS.has(facts.latestReason)) return false

  const lastProgressAt = latestFact(
    facts.ledgerUpdatedAt,
    facts.runActivityAt,
    facts.metaUpdatedAt,
    facts.decisionChangedAt,
    // Starting the queue IS a scheduling change: without it, an intent untouched
    // for days would be reported the moment its queue starts running.
    facts.queueStartedAt,
  )
  if (lastProgressAt === null) return false
  // `>=` makes the threshold itself a timeout. A future `lastProgressAt` yields a
  // negative elapsed, which can never reach the window — the "no false report on a
  // skewed clock" rule falls out of the comparison rather than needing a branch.
  return facts.now - lastProgressAt >= SILENT_TIMEOUT_MS
}

/**
 * Narrow a decision log's stored reason back to the kernel vocabulary. A row
 * written by an older build can carry a code this build no longer knows; it reads
 * as `null` (no usable conclusion) rather than being trusted as a driving one.
 */
function toReasonCode(raw: string | null): QueueReasonCode | null {
  return (QUEUE_REASON_CODES as readonly string[]).includes(raw ?? '')
    ? (raw as QueueReasonCode)
    : null
}

/** The session ids whose activity counts as progress on this intent. */
function sessionIdsForIntent(intent: Intent): string[] {
  return [
    intent.intentSessionId,
    intent.specSessionId,
    intent.specReviewSessionId,
    intent.lastWorkSessionId,
  ].filter((id): id is string => !!id)
}

/**
 * The silent-timeout arm of the send-time next-step projection: the inspection
 * jump when this intent has gone quiet for no known reason, else `null` so a
 * higher-priority, more specific block keeps the banner.
 *
 * Reads are ordered cheapest-first and bail as early as they can — the decision
 * log is only queried for an intent whose in-memory facts are ALREADY older than
 * the window, since a decision can only move the last-progress instant later.
 */
export function deriveSilentTimeoutActionDescriptor(
  intent: Intent,
  now: number = Date.now(),
): ActionDescriptor | null {
  if (!intent.automate) return null
  if (intent.status !== 'todo' && intent.status !== 'in_progress') return null
  const workspacePath = resolveWorkspaceRoot(intent.workspaceName)
  if (!workspacePath) return null
  const control = getQueueControl(workspacePath)
  if (control.state !== 'running') return null

  const sessionIds = sessionIdsForIntent(intent)
  const meta = getQueueIntentMetaById(intent.id)
  const runActivityAt = latestFact(...sessionIds.map(sessionLastActivityAt))
  const observedProgressAt = latestFact(
    intent.updatedAt,
    runActivityAt,
    meta.updatedAt,
    control.startedAt,
  )
  if (observedProgressAt !== null && now - observedProgressAt < SILENT_TIMEOUT_MS) return null

  const rows = listQueueDecisionsForIntent(intent.id, DECISION_SCAN_LIMIT)
  const facts: SilentTimeoutFacts = {
    now,
    automate: intent.automate,
    status: intent.status,
    queueState: control.state,
    queueStartedAt: control.startedAt,
    forceSkipped: control.forceSkipped.includes(intent.id),
    parked: meta.parked,
    backoffUntil: meta.backoffUntil,
    cooldownUntil: meta.cooldownUntil,
    awaitingPermission: sessionIds.some(isAwaitingPermission),
    latestReason: toReasonCode(rows[0]?.blockedGate ?? null),
    ledgerUpdatedAt: intent.updatedAt,
    runActivityAt,
    metaUpdatedAt: meta.updatedAt,
    decisionChangedAt: decisionChangedAt(rows),
  }

  if (!isSilentTimeout(facts)) return null
  return {
    labelCode: 'silent_timeout',
    target: { type: 'intent-work-session', intentId: intent.id },
  }
}
