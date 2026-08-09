import type { IntentPr, IntentSpecMode, IntentStatus } from '@ccc/shared/protocol'
import { deriveIntentPrAggregate } from '@ccc/shared'

export type EngineeringProgressState = 'not_started' | 'in_progress' | 'completed' | 'closed'
export type EngineeringProgressStage = 'intent' | 'spec' | 'work' | 'pr'

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
}

export interface EngineeringProgressItem {
  stage: EngineeringProgressStage
  state: EngineeringProgressState
}

function hasValue(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.trim().length > 0
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
  }

  return progress
}
