import type { IntentPrStatus, IntentStatus } from '@ccc/shared/protocol'

export type EngineeringProgressState = 'not_started' | 'in_progress' | 'completed' | 'closed'
export type EngineeringProgressStage = 'intent' | 'spec' | 'work' | 'pr'

export interface EngineeringProgressInput {
  status: IntentStatus
  specPath?: string | null
  specApproved?: boolean
  specSessionId?: string | null
  lastWorkSessionId?: string | null
  prId?: string | null
  prStatus?: IntentPrStatus | null
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

  if (sddEnabled) {
    const hasSpecPath = hasValue(intent.specPath)
    const hasSpecEvidence = hasSpecPath || hasValue(intent.specSessionId)
    progress.push({
      stage: 'spec',
      state:
        intent.specApproved === true && hasSpecPath
          ? 'completed'
          : hasSpecEvidence
            ? 'in_progress'
            : 'not_started',
    })
  }

  const hasWorkEvidence = hasValue(intent.lastWorkSessionId) || hasValue(intent.prId)
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
    let state: EngineeringProgressState = 'not_started'
    if (hasValue(intent.prId)) {
      if (intent.prStatus === 'merged') state = 'completed'
      else if (['rejected', 'failed', 'closed'].includes(intent.prStatus ?? '')) state = 'closed'
      else state = 'in_progress'
    }
    progress.push({ stage: 'pr', state })
  }

  return progress
}
