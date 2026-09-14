/**
 * The merge CREDENTIAL: who is allowed to let c3 land a PR by itself.
 *
 * `automate = true`, `status = reviewing` and `reviewStatus = approved` are
 * necessary conditions and nothing more. Every one of them can be produced by a
 * human typing into the intent detail, and a human approval means "I will merge
 * this", not "a machine may merge it". So the authority to merge rests on a
 * separate, positively recorded fact:
 *
 *   1. when the QUEUE claims a review round it writes a {@link QueueReviewClaim}
 *      naming its own session and pinning the PR set (forge, repo, number, head /
 *      base branch, head SHA) it is about to have reviewed;
 *   2. only the server-bound session of THAT claim, concluding `approved`, turns
 *      the claim into a {@link QueueMergeGrant};
 *   3. the grant is re-validated against the live ledger on every pass, and
 *      against the forge itself immediately before any merge command.
 *
 * Nothing here reads an MCP argument. A caller that names a session id is naming
 * one — it is not proving it holds one.
 *
 * Everything in this module is either a pure reduction over facts or a write to
 * the queue's own scheduling metadata. It never writes intent or PR business
 * state, and it never calls the forge (the executor does that, with the identity
 * this module pinned).
 */
import type { Intent, IntentPr } from '@ccc/shared/protocol'
import { activeIntentPrs } from '@ccc/shared'
import type { QueueIntentMeta, QueueMergeGrant, QueuePrIdentity } from '../../kernel/queue/index.js'
import { getQueueIntentMetaById, putQueueIntentMeta } from './queue-store.js'

/** Why a credential does not authorize a merge; `null` when it does. */
export type MergeDenial =
  | null
  | 'no_grant'
  | 'phase_consumed'
  | 'automation_off'
  | 'not_reviewing'
  | 'not_approved'
  | 'session_changed'
  | 'pr_set_changed'

/** Short, displayable Chinese text for each denial — used in decision/todo detail. */
export const MERGE_DENIAL_TEXT: Readonly<Record<Exclude<MergeDenial, null>, string>> = {
  no_grant: '没有队列评审产生的合并凭据',
  phase_consumed: '合并凭据已被消费或已交回人工',
  automation_off: '意图已关闭自动化',
  not_reviewing: '意图已不在 reviewing 阶段',
  not_approved: '评审结论已不是 approved',
  session_changed: '评审会话已变化,凭据不再对应当前结论',
  pr_set_changed: 'PR 集合或 head/base 已变化',
}

/** Stable ordering key for one PR row / pinned identity. */
function identityKey(p: { forge: string | null; repo: string | null; number: string }): string {
  return `${p.forge ?? '?'}|${p.repo ?? '?'}|${p.number}`
}

/** Pin one live PR row as an identity, with the head commit the caller read. */
export function prIdentityOf(pr: IntentPr, headSha: string | null): QueuePrIdentity {
  return {
    forge: pr.forge,
    repo: pr.repo,
    number: pr.number,
    headBranch: pr.headBranch,
    baseBranch: pr.baseBranch,
    headSha,
  }
}

/**
 * The intent's active PRs in the ONE order every merge pass uses. Sorting by the
 * identity key (not by insertion time) is what makes a partially completed batch
 * resumable: the same set always produces the same sequence, so "the first three
 * landed" stays a meaningful statement across passes.
 */
export function orderedActivePrs(intent: Intent): IntentPr[] {
  return activeIntentPrs(intent.prs).sort((a, b) => identityKey(a).localeCompare(identityKey(b)))
}

/**
 * Does the grant still describe the SAME PRs the intent holds now?
 *
 * Set equality on the identity key plus head / base branch agreement. A PR added,
 * replaced or re-targeted after the approval was granted means the approval never
 * covered the current state, whatever its conclusion still says. The head COMMIT
 * is deliberately not compared here — it is re-read from the forge right before
 * the merge, because a local ledger row does not know about a push.
 */
function prSetMatches(grant: QueueMergeGrant, intent: Intent): boolean {
  const live = orderedActivePrs(intent)
  if (live.length !== grant.prs.length) return false
  const pinned = new Map(grant.prs.map((p) => [identityKey(p), p]))
  for (const pr of live) {
    const p = pinned.get(identityKey(pr))
    if (!p) return false
    if (p.headBranch !== pr.headBranch || p.baseBranch !== pr.baseBranch) return false
  }
  return true
}

/**
 * Whether this intent's persisted credential still authorizes an automatic merge.
 * Pure over (intent, meta): the same inputs always give the same verdict, so the
 * kernel fact, the sweep and the executor's pre-flight all read one rule.
 */
export function mergeDenial(intent: Intent, meta: QueueIntentMeta): MergeDenial {
  if (!meta.mergeGrant) return 'no_grant'
  if (meta.mergePhase !== 'pending') return 'phase_consumed'
  if (!intent.automate) return 'automation_off'
  if (intent.status !== 'reviewing') return 'not_reviewing'
  if (intent.reviewStatus !== 'approved') return 'not_approved'
  if (intent.reviewSessionId !== meta.mergeGrant.reviewSessionId) return 'session_changed'
  if (!prSetMatches(meta.mergeGrant, intent)) return 'pr_set_changed'
  return null
}

export function mergeAuthorized(intent: Intent, meta: QueueIntentMeta): boolean {
  return mergeDenial(intent, meta) === null
}

/**
 * A merge attempt is persisted as unfinished — the restart-recovery fact.
 *
 * Both `running` (a command may be in flight) and `awaiting_sync` (a command
 * returned, the forge has not confirmed) qualify, because a process that dies in
 * either state leaves the same question open: did it land? Neither may be
 * answered by re-sending, so both route to the read-only reconcile.
 */
export function mergeRecoveryPending(meta: QueueIntentMeta): boolean {
  return meta.mergePhase === 'running' || meta.mergePhase === 'awaiting_sync'
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/**
 * Record that the QUEUE owns this review round, pinning the PR set it is about to
 * have reviewed. Called at claim time — before any conclusion exists — so the
 * provenance can never be reconstructed after the fact from a conclusion.
 *
 * A new claim RESETS the merge phase: the previous round's credential, its failed
 * attempt and its hand-back all belonged to code that has since been re-reviewed.
 */
export function recordQueueReviewClaim(input: {
  workspacePath: string
  intentId: string
  sessionId: string
  prs: readonly QueuePrIdentity[]
  now?: number
}): boolean {
  const now = input.now ?? Date.now()
  const prev = getQueueIntentMetaById(input.intentId)
  return putQueueIntentMeta(input.workspacePath, {
    ...prev,
    intentId: input.intentId,
    reviewClaim: { sessionId: input.sessionId, prs: [...input.prs], claimedAt: now },
    mergeGrant: null,
    mergePhase: 'none',
    mergeDetail: null,
    mergeStartedAt: null,
    updatedAt: now,
  })
}

/**
 * Follow the claim's session id when the vendor replaces the `pending:`
 * placeholder with a real one. Owner-safe: a bind callback that arrives after a
 * newer claim took the round writes nothing.
 */
export function bindQueueReviewClaimSession(
  workspacePath: string,
  intentId: string,
  pendingSessionId: string,
  realSessionId: string,
): boolean {
  const prev = getQueueIntentMetaById(intentId)
  if (!prev.reviewClaim || prev.reviewClaim.sessionId !== pendingSessionId) return false
  return putQueueIntentMeta(workspacePath, {
    ...prev,
    intentId,
    reviewClaim: { ...prev.reviewClaim, sessionId: realSessionId },
    updatedAt: Date.now(),
  })
}

export type GrantOutcome =
  /** A fresh credential now authorizes the merge. */
  | 'issued'
  /** The same trusted session repeated the same conclusion; nothing was reset. */
  | 'unchanged'
  /** This call is not the queue's review round — no credential, merge stays manual. */
  | 'not_queue_review'
  /** A credential existed but its attempt already ran or a human took over. */
  | 'already_consumed'
  | 'store_unavailable'

/**
 * Turn the current review claim into a merge credential, in the same call that
 * persists the `approved` conclusion.
 *
 * `callerSessionId` must be the session the SERVER bound to this relay run — never
 * a value the model supplied. A caller outside the queue's review round gets
 * `not_queue_review`: its backfill still lands (manual backfill is unchanged), it
 * simply grants no authority.
 */
export function issueMergeGrant(input: {
  workspacePath: string
  intentId: string
  callerSessionId: string
  now?: number
}): GrantOutcome {
  const now = input.now ?? Date.now()
  const prev = getQueueIntentMetaById(input.intentId)
  const claim = prev.reviewClaim
  if (!claim || claim.sessionId !== input.callerSessionId) return 'not_queue_review'
  // A repeated backfill from the SAME session must not rewind an attempt that
  // already ran, or a hand-back a human now owns.
  if (prev.mergePhase !== 'none' && prev.mergePhase !== 'pending') return 'already_consumed'
  if (prev.mergePhase === 'pending' && prev.mergeGrant?.reviewSessionId === input.callerSessionId) {
    return 'unchanged'
  }
  const ok = putQueueIntentMeta(input.workspacePath, {
    ...prev,
    intentId: input.intentId,
    mergeGrant: {
      reviewSessionId: input.callerSessionId,
      prs: [...claim.prs],
      grantedAt: now,
    },
    mergePhase: 'pending',
    mergeDetail: null,
    mergeStartedAt: null,
    updatedAt: now,
  })
  return ok ? 'issued' : 'store_unavailable'
}

/**
 * Drop a credential that no longer describes reality. Leaves a `handed_back` or
 * `completed` phase alone — those record what actually happened to a merge, and
 * only a NEW review round (which rewrites the claim) clears them.
 */
export function invalidateMergeGrant(
  workspacePath: string,
  intentId: string,
  detail: string,
): boolean {
  const prev = getQueueIntentMetaById(intentId)
  if (prev.mergePhase === 'handed_back' || prev.mergePhase === 'completed') return false
  if (!prev.mergeGrant && prev.mergePhase === 'none') return false
  return putQueueIntentMeta(workspacePath, {
    ...prev,
    intentId,
    mergeGrant: null,
    mergePhase: 'none',
    mergeDetail: detail,
    mergeStartedAt: null,
    updatedAt: Date.now(),
  })
}

/**
 * Drop every credential whose intent has moved out from under it, once per pass.
 *
 * This is what makes "switching automation off revokes the authorization" true
 * even though nothing calls us when the switch is flipped: the credential is
 * re-justified against the live ledger every tick, and one that cannot be
 * re-justified is deleted rather than merely ignored. A `running` phase is never
 * swept — its attempt is recovered, not revoked.
 */
export function sweepMergeGrants(workspacePath: string, intents: readonly Intent[]): number {
  let dropped = 0
  for (const intent of intents) {
    const meta = getQueueIntentMetaById(intent.id)
    if (meta.mergePhase !== 'pending') continue
    const denial = mergeDenial(intent, meta)
    if (denial === null) continue
    if (invalidateMergeGrant(workspacePath, intent.id, MERGE_DENIAL_TEXT[denial])) dropped += 1
  }
  return dropped
}
