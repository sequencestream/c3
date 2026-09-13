import type {
  IntentFixStatus,
  IntentImpactLevel,
  IntentPr,
  IntentReviewStatus,
  IntentSpecMode,
  IntentStatus,
} from '@ccc/shared/protocol'
import { deriveIntentPrAggregate, needsReview } from '@ccc/shared'

export type EngineeringProgressState = 'not_started' | 'in_progress' | 'completed' | 'closed'
export type EngineeringProgressStage = 'intent' | 'spec' | 'work' | 'pr' | 'review' | 'fix'

export interface EngineeringProgressInput {
  status: IntentStatus
  specPath?: string | null
  specStatus?: 'raw' | 'pending' | 'approved'
  specSessionId?: string | null
  /**
   * The intent's resolved spec mode. `fast` means "no spec stage up front" — the
   * document, if any, is reverse-authored after a work turn settles — so the spec
   * segment is omitted until such a document actually exists.
   */
  effectiveSpecMode?: IntentSpecMode
  lastWorkSessionId?: string | null
  /** Every PR the intent owns; the PR stage reads its aggregate, never one row. */
  prs?: IntentPr[]
  /** The intent's impact grade; decides whether the PR review segment appears. */
  impactLevel?: IntentImpactLevel | null
  /** The PR AI review conclusion; `null` when the PR was never reviewed. */
  reviewStatus?: IntentReviewStatus | null
  /** The session that ran the fix round; non-null binds a fix segment. */
  fixSessionId?: string | null
  /** Whether the fix round concluded; `null` when no fix was started. */
  fixStatus?: IntentFixStatus | null
}

export interface EngineeringProgressItem {
  stage: EngineeringProgressStage
  state: EngineeringProgressState
}

function hasValue(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.trim().length > 0
}

/** `true` when the nullable field is neither `null` nor absent (`undefined`). */
function isPresent<T>(value: T | null | undefined): value is T {
  return value !== null && value !== undefined
}

function reviewState(
  reviewStatus: IntentReviewStatus | null | undefined,
): EngineeringProgressState {
  if (reviewStatus === 'pending') return 'in_progress'
  if (reviewStatus === 'approved') return 'completed'
  if (reviewStatus === 'rejected') return 'closed'
  return 'not_started'
}

function fixState(fixStatus: IntentFixStatus | null | undefined): EngineeringProgressState {
  if (fixStatus === 'pending') return 'in_progress'
  if (fixStatus === 'fixed') return 'completed'
  return 'not_started'
}

export function deriveIntentEngineeringProgress(
  intent: EngineeringProgressInput,
  sddEnabled: boolean,
  workspaceGitBranchMode?: 'worktree' | 'current-branch',
): EngineeringProgressItem[] {
  const progress: EngineeringProgressItem[] = [
    {
      stage: 'intent',
      state: intent.status === 'draft' ? 'in_progress' : 'completed',
    },
  ]

  const hasSpecPath = hasValue(intent.specPath)
  const hasSpecEvidence = hasSpecPath || hasValue(intent.specSessionId)
  // A `fast` intent has no spec stage to walk through: it goes straight to work
  // and only gets a document reverse-authored afterwards. Showing an empty
  // "规范 / 未开始" segment for it would announce a step that will never be taken.
  // Once such a document does exist the segment comes back, because there is then
  // a real approval step to see — the same "has spec data" rule the spec tabs use.
  if (sddEnabled && (intent.effectiveSpecMode !== 'fast' || hasSpecEvidence)) {
    progress.push({
      stage: 'spec',
      state:
        intent.specStatus === 'approved' && hasSpecPath
          ? 'completed'
          : hasSpecEvidence
            ? 'in_progress'
            : 'not_started',
    })
  }

  const prs = intent.prs ?? []
  const hasWorkEvidence = hasValue(intent.lastWorkSessionId) || prs.length > 0
  const hasActiveWorkStatus = ['in_progress', 'blocked', 'failed'].includes(intent.status)
  progress.push({
    stage: 'work',
    state:
      intent.status === 'done'
        ? 'completed'
        : hasWorkEvidence || hasActiveWorkStatus
          ? 'in_progress'
          : 'not_started',
  })

  if (workspaceGitBranchMode === 'worktree') {
    // One aggregate for the whole stage: an intent with several PRs still shows a
    // single PR segment, and "still under review" outranks any terminal row.
    const aggregate = deriveIntentPrAggregate(prs)
    let state: EngineeringProgressState = 'not_started'
    if (aggregate !== null) {
      if (aggregate === 'merged') state = 'completed'
      else if (['rejected', 'failed', 'closed'].includes(aggregate)) state = 'closed'
      else state = 'in_progress'
    }
    progress.push({ stage: 'pr', state })

    // Review follows the PR. It appears only when the intent actually goes through
    // the review loop (`needsReview` — L5 skips the first review) AND there is PR
    // evidence to review: a PR row, or a conclusion already written by the relay.
    // `reviewStatus` alone drives the state.
    if (
      needsReview(intent.impactLevel ?? null) &&
      (prs.length > 0 || isPresent(intent.reviewStatus))
    ) {
      progress.push({ stage: 'review', state: reviewState(intent.reviewStatus) })
    }

    // Fix only exists after a rejected review; a bound fix session or a written
    // conclusion is what makes the segment appear. `fixStatus` alone drives the
    // state — there is no separate "fix needed" field.
    if (hasValue(intent.fixSessionId) || isPresent(intent.fixStatus)) {
      progress.push({ stage: 'fix', state: fixState(intent.fixStatus) })
    }
  }

  return progress
}
