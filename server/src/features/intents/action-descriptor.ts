/**
 * Intent action-descriptor projection — the send-time "next step" for a blocked
 * intent. Composes vendor-block facts, pending wait-user events, the exhausted
 * spec rework, the SDD approval checkpoint and the hard dependency gate into a
 * single optional {@link ActionDescriptor}.
 *
 * Priority (highest first): vendor block → pending wait-user (Ask / permission)
 * → spec rework exhausted → spec awaiting approval → dependency blocked. Only
 * one descriptor is projected; lower priorities stay latent until the higher one
 * clears. Never persists, never changes gates.
 */
import type { ActionDescriptor, Intent } from '@ccc/shared/protocol'
import { MAX_SPEC_REVIEW_REWORK_ROUNDS } from '@ccc/shared/protocol'
import { getDefaultMainBranch, getGitBranchMode, getSddEnabled } from '../../kernel/config/index.js'
import { resolveWorkspaceRoot } from '../../state.js'
import { findLatestTodoEventForSessionIds } from '../user-involve/store.js'
import { findBlockingDependency } from './dependency-gate.js'
import { readSpecFingerprint } from './spec-review.js'
import { deriveVendorActionDescriptor } from './vendor-block.js'

/**
 * The workspace's whole intent ledger, as the dependency projection needs it to
 * resolve `dependsOn` ids. A function rather than a list so the caller can load
 * it once per send AND only when an intent actually declares a dependency — the
 * projection must not assume the batch it is enriching is the complete ledger
 * (`list_intents` may be status-filtered), or a filtered list and a broadcast
 * would explain the same block differently.
 */
export type WorkspaceIntentsLoader = (workspacePath: string) => Intent[]

/** Session ids that can own a wait-user event for this intent, including intent-level. */
function sessionIdsForIntent(
  intent: Pick<
    Intent,
    'id' | 'intentSessionId' | 'specSessionId' | 'specReviewSessionId' | 'lastWorkSessionId'
  >,
): string[] {
  return [
    intent.id,
    intent.intentSessionId,
    intent.specSessionId,
    intent.specReviewSessionId,
    intent.lastWorkSessionId,
  ].filter((id): id is string => !!id)
}

/**
 * A pending wait-user event for this intent as a deep-link descriptor, or `null`
 * when none is waiting. AskUserQuestion is distinguished from ordinary tool
 * gates by `toolName`; events without a `requestId` (notification-only todos)
 * are ignored — they have no actionable prompt to land on.
 */
function deriveWaitUserActionDescriptor(
  intent: Pick<
    Intent,
    | 'id'
    | 'workspaceId'
    | 'intentSessionId'
    | 'specSessionId'
    | 'specReviewSessionId'
    | 'lastWorkSessionId'
  >,
): ActionDescriptor | null {
  const workspacePath = resolveWorkspaceRoot(intent.workspaceId)
  if (!workspacePath) return null
  const event = findLatestTodoEventForSessionIds(workspacePath, sessionIdsForIntent(intent))
  if (!event || !event.requestId) return null
  if (event.toolName === 'AskUserQuestion') {
    return {
      labelCode: 'ask_user_question_pending',
      target: { type: 'workcenter-event', eventId: event.id },
    }
  }
  return {
    labelCode: 'permission_pending',
    target: { type: 'workcenter-event', eventId: event.id },
  }
}

/**
 * Automatic spec rework is over: the cap has been passed and the conclusion that
 * ended it still asks for changes, so the queue has stopped re-launching the
 * author. Derived from facts that already exist — the round counter, the stored
 * conclusion and the cap constant — so it says nothing the queue does not already
 * act on, and it neither parks nor un-parks anything.
 *
 * The conclusion must still be bound to the spec's live content: once the spec is
 * edited the flow reviews it again by itself, so the block is no longer real. An
 * unreadable spec cannot confirm that binding and therefore shows nothing —
 * unreadable is not unchanged.
 */
function deriveSpecReworkExhaustedActionDescriptor(
  intent: Pick<
    Intent,
    | 'id'
    | 'workspaceId'
    | 'status'
    | 'specPath'
    | 'specApproved'
    | 'specReviewVerdict'
    | 'specReviewFingerprint'
    | 'specReviewReworkRounds'
  >,
): ActionDescriptor | null {
  if (intent.status !== 'todo') return null
  if (!intent.specPath || intent.specApproved) return null
  if (intent.specReviewVerdict !== 'changes_requested') return null
  if (intent.specReviewFingerprint === null) return null
  // Rounds 1..CAP are reworked; only the conclusion after the last allowed rework
  // is the hand-over point — the same boundary the queue parks on.
  if (intent.specReviewReworkRounds <= MAX_SPEC_REVIEW_REWORK_ROUNDS) return null
  const workspacePath = resolveWorkspaceRoot(intent.workspaceId)
  if (!workspacePath || !getSddEnabled(workspacePath)) return null
  if (readSpecFingerprint(workspacePath, intent.specPath) !== intent.specReviewFingerprint) {
    return null
  }
  return {
    labelCode: 'spec_rework_exhausted',
    target: { type: 'intent-spec', intentId: intent.id },
  }
}

/**
 * Spec awaiting human approval: SDD on, todo intent, written but not approved.
 * The jump lands on the intent's spec document tab where the approve action lives.
 */
function deriveSpecApprovalActionDescriptor(
  intent: Pick<Intent, 'id' | 'workspaceId' | 'status' | 'specPath' | 'specApproved'>,
): ActionDescriptor | null {
  if (intent.status !== 'todo') return null
  if (!intent.specPath || intent.specApproved) return null
  const workspacePath = resolveWorkspaceRoot(intent.workspaceId)
  if (!workspacePath || !getSddEnabled(workspacePath)) return null
  return {
    labelCode: 'spec_awaiting_approval',
    target: { type: 'intent-spec', intentId: intent.id },
  }
}

/**
 * The hard dependency gate, restated as guidance: which predecessor the intent is
 * actually waiting for. The verdict is NOT re-invented here — it comes from
 * {@link findBlockingDependency}, the same rule the launch gate and the queue
 * apply, so the guidance can never point at something the gate would let through.
 *
 * Only an intent the gate can still hold back is described: `todo` (a launch is
 * what the gate refuses) and `in_progress` (what the queue keeps refusing to
 * continue). A terminal intent has no next step to give.
 *
 * The target carries the predecessor's id only, and is minted only when that
 * record resolves — the title and status beside it are read from the same
 * `intents` read model by the client, never copied into the descriptor.
 */
function deriveDependencyActionDescriptor(
  intent: Pick<Intent, 'workspaceId' | 'status' | 'dependsOn'>,
  loadWorkspaceIntents: WorkspaceIntentsLoader,
): ActionDescriptor | null {
  if (intent.status !== 'todo' && intent.status !== 'in_progress') return null
  if (intent.dependsOn.length === 0) return null
  const workspacePath = resolveWorkspaceRoot(intent.workspaceId)
  if (!workspacePath) return null
  const blocking = findBlockingDependency({
    dependsOn: intent.dependsOn,
    intents: loadWorkspaceIntents(workspacePath),
    gitBranchMode: getGitBranchMode(workspacePath),
    defaultMainBranch: getDefaultMainBranch(workspacePath),
  })
  if (!blocking) return null
  return {
    labelCode: 'dependency_blocked',
    target: { type: 'intent-detail', intentId: blocking.id },
  }
}

/**
 * The send-time projection: the highest-priority blocked next step for this
 * intent, or `null` when nothing actionable blocks it. Pure over its inputs
 * and the in-memory / store facts it reads — never mutates either side.
 */
export function deriveActionDescriptor(
  intent: Intent,
  loadWorkspaceIntents: WorkspaceIntentsLoader,
): ActionDescriptor | null {
  return (
    deriveVendorActionDescriptor(intent) ??
    deriveWaitUserActionDescriptor(intent) ??
    deriveSpecReworkExhaustedActionDescriptor(intent) ??
    deriveSpecApprovalActionDescriptor(intent) ??
    deriveDependencyActionDescriptor(intent, loadWorkspaceIntents)
  )
}
