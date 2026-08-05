/*
 * action-descriptor — the client half of the derived next-step contract.
 *
 * The server sends stable codes, never sentences: `labelCode` says WHICH blocked
 * situation this is, `target.type` says WHERE the action goes. This module is the
 * single place that turns those codes into i18n keys, so the list and the detail
 * cannot drift into describing the same block two different ways.
 *
 * Both maps are exhaustive by construction (`satisfies Record<…>`): adding an arm
 * to either union fails to compile until its copy exists.
 *
 * A target that names another intent carries its id and nothing else, so any
 * business field shown next to the prompt (a predecessor's title and status) is
 * resolved here from the intents the view already holds — never copied off the
 * wire, where it could go stale.
 */
import type {
  ActionDescriptor,
  ActionLabelCode,
  ActionTarget,
  Intent,
  IntentStatus,
  SystemSettingsAgentTarget,
  VendorId,
} from '@ccc/shared/protocol'
import type { LocaleKey } from '@/i18n'

/** What went wrong, as the prompt text shown to the user. */
export const ACTION_MESSAGE_KEYS = {
  vendor_auth_invalid: 'intent.blocked.vendorAuthInvalid',
  vendor_quota_exhausted: 'intent.blocked.vendorQuotaExhausted',
  spec_awaiting_approval: 'intent.blocked.specAwaitingApproval',
  spec_rework_exhausted: 'intent.blocked.specReworkExhausted',
  permission_pending: 'intent.blocked.permissionPending',
  ask_user_question_pending: 'intent.blocked.askUserQuestionPending',
  dependency_blocked: 'intent.blocked.dependencyBlocked',
} as const satisfies Record<ActionLabelCode, LocaleKey>

/**
 * Status label i18n keys, shared with the list/detail filter dropdown. A
 * predecessor's status travels as one of these keys — never an English string —
 * so the caller localizes it with its own `t` and a non-English interface does
 * not end up with mixed-language copy.
 */
const STATUS_KEYS: Record<IntentStatus, LocaleKey> = {
  draft: 'intent.filter.draft.label',
  todo: 'intent.filter.todo.label',
  in_progress: 'intent.filter.inProgress.label',
  done: 'intent.filter.done.label',
  cancelled: 'intent.filter.cancelled.label',
  blocked: 'intent.filter.blocked.label',
  failed: 'intent.filter.failed.label',
}

/** Where it goes, as the button label. */
export const ACTION_BUTTON_KEYS = {
  'system-settings-agent': 'intent.blocked.openAgentSettings.label',
  'intent-spec': 'intent.blocked.openSpecApproval.label',
  'intent-detail': 'intent.blocked.openPredecessorIntent.label',
  'workcenter-event': 'intent.blocked.openWorkcenterEvent.label',
} as const satisfies Record<ActionTarget['type'], LocaleKey>

/**
 * Situations whose button says something else than its target's default. The
 * same spec tab is "approve this spec" after a passing review and "take this
 * over by hand" once automatic rework is done — one destination, two asks.
 */
const ACTION_BUTTON_OVERRIDE_KEYS: Partial<Record<ActionLabelCode, LocaleKey>> = {
  spec_rework_exhausted: 'intent.blocked.takeOverSpec.label',
}

/**
 * The blocked states that show the review's own words underneath the prompt, and
 * the copy to fall back on when the reviewer left no rationale. The reason itself
 * is never invented — an empty one says so plainly.
 */
const ACTION_BLOCKER_FALLBACK_KEYS: Partial<Record<ActionLabelCode, LocaleKey>> = {
  spec_rework_exhausted: 'intent.blocked.specReworkExhaustedNoReason',
}

/**
 * The intent a descriptor points at, as far as the prompt text needs it. The
 * server sends the id only, so this is resolved from the very same `intents` the
 * view is rendering — the title and status shown can never be staler than the
 * list beside them.
 */
export type ActionTargetIntent = Pick<Intent, 'title' | 'status'>

/**
 * The intent a descriptor's target names, looked up in what the client can
 * currently see; `null` when the target names no intent, or when that intent is
 * outside the current view (e.g. a status-filtered list).
 */
export function actionTargetIntent(
  descriptor: ActionDescriptor | null,
  byId: ReadonlyMap<string, ActionTargetIntent>,
): ActionTargetIntent | null {
  if (!descriptor || descriptor.target.type !== 'intent-detail') return null
  return byId.get(descriptor.target.intentId) ?? null
}

/** A descriptor's prompt text as an i18n key plus the values it interpolates. */
export interface ActionMessage {
  key: LocaleKey
  named?: Record<string, string>
  /**
   * i18n key for the predecessor's status, when the message interpolates it.
   * Kept out of `named` because it is a key, not a literal: the caller resolves
   * it through its own `t` so the copy follows the current locale.
   */
  statusKey?: LocaleKey
}

/**
 * The i18n key (and named values) for a descriptor's prompt text.
 *
 * Most codes are a plain key. `dependency_blocked` names a predecessor, so it
 * interpolates that intent's title and status — and falls back to a copy that
 * claims neither when the predecessor is out of view, rather than printing a
 * bare id. The status is handed over as an i18n key ({@link ActionMessage.statusKey})
 * that the caller localizes, never an English string. A `done` predecessor blocks
 * only because it is not on the mainline yet (worktree mode), so its copy says
 * exactly that instead of asking to "finish" something already finished.
 */
export function actionMessage(
  labelCode: ActionLabelCode,
  targetIntent?: ActionTargetIntent | null,
): ActionMessage {
  if (labelCode === 'dependency_blocked') {
    if (!targetIntent) return { key: 'intent.blocked.dependencyBlockedUnresolved' }
    const named = { title: targetIntent.title }
    const statusKey = STATUS_KEYS[targetIntent.status]
    return targetIntent.status === 'done'
      ? { key: 'intent.blocked.dependencyBlockedDone', named, statusKey }
      : { key: ACTION_MESSAGE_KEYS.dependency_blocked, named, statusKey }
  }
  return { key: ACTION_MESSAGE_KEYS[labelCode] }
}

/** The i18n key for a descriptor's button label. */
export function actionButtonKey(descriptor: ActionDescriptor): LocaleKey {
  return (
    ACTION_BUTTON_OVERRIDE_KEYS[descriptor.labelCode] ?? ACTION_BUTTON_KEYS[descriptor.target.type]
  )
}

/**
 * The fallback copy key for this situation's blocker summary, or `null` when it
 * shows no summary at all.
 */
export function actionBlockerFallbackKey(labelCode: ActionLabelCode): LocaleKey | null {
  return ACTION_BLOCKER_FALLBACK_KEYS[labelCode] ?? null
}

/**
 * A one-shot instruction for the system-settings panel: which tab to land on and
 * what to locate there. It is the panel's own contract, deliberately separate
 * from the wire {@link ActionTarget} — the panel knows about tabs, the protocol
 * does not.
 */
export interface SystemSettingsTarget {
  tab: 'agent'
  vendor: VendorId
  agentId: string
}

/**
 * Turn a `system-settings-agent` wire target into the panel instruction. Callers
 * must narrow the wire union first — other arms navigate elsewhere.
 */
export function toSystemSettingsTarget(target: SystemSettingsAgentTarget): SystemSettingsTarget {
  return { tab: 'agent', vendor: target.vendor, agentId: target.agentId }
}
