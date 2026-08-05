/**
 * Intent action-descriptor projection — the send-time "next step" for a blocked
 * intent. Composes vendor-block facts, pending wait-user events, the exhausted
 * spec rework and the SDD approval checkpoint into a single optional
 * {@link ActionDescriptor}.
 *
 * Priority (highest first): vendor block → pending wait-user (Ask / permission)
 * → spec rework exhausted → spec awaiting approval. Only one descriptor is
 * projected; lower priorities stay latent until the higher one clears. Never
 * persists, never changes gates.
 */
import type { ActionDescriptor, Intent } from '@ccc/shared/protocol'
import { MAX_SPEC_REVIEW_REWORK_ROUNDS } from '@ccc/shared/protocol'
import { getSddEnabled } from '../../kernel/config/index.js'
import { resolveWorkspaceRoot } from '../../state.js'
import { findLatestTodoEventForSessionIds } from '../user-involve/store.js'
import { readSpecFingerprint } from './spec-review.js'
import { deriveVendorActionDescriptor } from './vendor-block.js'

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
    | 'specStatus'
    | 'specReviewVerdict'
    | 'specReviewFingerprint'
    | 'specReviewReworkRounds'
  >,
): ActionDescriptor | null {
  if (intent.status !== 'todo') return null
  // Only an authored-but-unapproved spec can be stuck in rework: a `raw` one is
  // never reviewed, and an `approved` one is past the question.
  if (!intent.specPath || intent.specStatus !== 'pending') return null
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
 * Spec awaiting human approval: SDD on, todo intent, and the spec status is
 * `pending` — a document with real content that nobody has approved yet. The jump
 * lands on the intent's spec document tab where the approve action lives.
 *
 * `pending` is the WHOLE condition. A `raw` intent has a `spec_path` from the
 * moment `write_spec` seeds the file, so deriving this from the path plus the
 * approval boolean used to send a human to review a document that had not been
 * written yet.
 */
function deriveSpecApprovalActionDescriptor(
  intent: Pick<Intent, 'id' | 'workspaceId' | 'status' | 'specStatus'>,
): ActionDescriptor | null {
  if (intent.status !== 'todo') return null
  if (intent.specStatus !== 'pending') return null
  const workspacePath = resolveWorkspaceRoot(intent.workspaceId)
  if (!workspacePath || !getSddEnabled(workspacePath)) return null
  return {
    labelCode: 'spec_awaiting_approval',
    target: { type: 'intent-spec', intentId: intent.id },
  }
}

/**
 * The send-time projection: the highest-priority blocked next step for this
 * intent, or `null` when nothing actionable blocks it. Pure over its inputs
 * and the in-memory / store facts it reads — never mutates either side.
 */
export function deriveActionDescriptor(intent: Intent): ActionDescriptor | null {
  return (
    deriveVendorActionDescriptor(intent) ??
    deriveWaitUserActionDescriptor(intent) ??
    deriveSpecReworkExhaustedActionDescriptor(intent) ??
    deriveSpecApprovalActionDescriptor(intent)
  )
}
