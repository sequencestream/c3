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
 */
import type {
  ActionDescriptor,
  ActionLabelCode,
  ActionTarget,
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
} as const satisfies Record<ActionLabelCode, LocaleKey>

/** Where it goes, as the button label. */
export const ACTION_BUTTON_KEYS = {
  'system-settings-agent': 'intent.blocked.openAgentSettings.label',
  'intent-spec': 'intent.blocked.openSpecApproval.label',
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

/** The i18n key for a descriptor's prompt text. */
export function actionMessageKey(labelCode: ActionLabelCode): LocaleKey {
  return ACTION_MESSAGE_KEYS[labelCode]
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
