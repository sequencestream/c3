/**
 * Intent action-descriptor projection — the send-time "next step" for a blocked
 * intent. Composes vendor-block facts, pending wait-user events, and the SDD
 * approval checkpoint into a single optional {@link ActionDescriptor}.
 *
 * Priority (highest first): vendor block → pending wait-user (Ask / permission)
 * → spec awaiting approval. Only one descriptor is projected; lower priorities
 * stay latent until the higher one clears. Never persists, never changes gates.
 */
import type { ActionDescriptor, Intent } from '@ccc/shared/protocol'
import { getSddEnabled } from '../../kernel/config/index.js'
import { resolveWorkspaceRoot } from '../../state.js'
import { findLatestTodoEventForSessionIds } from '../user-involve/store.js'
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
 * The send-time projection: the highest-priority blocked next step for this
 * intent, or `null` when nothing actionable blocks it. Pure over its inputs
 * and the in-memory / store facts it reads — never mutates either side.
 */
export function deriveActionDescriptor(intent: Intent): ActionDescriptor | null {
  return (
    deriveVendorActionDescriptor(intent) ??
    deriveWaitUserActionDescriptor(intent) ??
    deriveSpecApprovalActionDescriptor(intent)
  )
}
