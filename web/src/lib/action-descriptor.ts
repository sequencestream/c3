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
import type { ActionLabelCode, ActionTarget, VendorId } from '@ccc/shared/protocol'
import type { LocaleKey } from '@/i18n'

/** What went wrong, as the prompt text shown to the user. */
export const ACTION_MESSAGE_KEYS = {
  vendor_auth_invalid: 'intent.blocked.vendorAuthInvalid',
  vendor_quota_exhausted: 'intent.blocked.vendorQuotaExhausted',
} as const satisfies Record<ActionLabelCode, LocaleKey>

/** Where it goes, as the button label. */
export const ACTION_BUTTON_KEYS = {
  'system-settings-agent': 'intent.blocked.openAgentSettings.label',
} as const satisfies Record<ActionTarget['type'], LocaleKey>

/** The i18n key for a descriptor's prompt text. */
export function actionMessageKey(labelCode: ActionLabelCode): LocaleKey {
  return ACTION_MESSAGE_KEYS[labelCode]
}

/** The i18n key for a descriptor's button label. */
export function actionButtonKey(target: ActionTarget): LocaleKey {
  return ACTION_BUTTON_KEYS[target.type]
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
 * The single target dispatcher: turn a wire target into the panel instruction.
 * Both the list and the detail route their click through here, so one descriptor
 * can never navigate two different ways.
 */
export function toSystemSettingsTarget(target: ActionTarget): SystemSettingsTarget {
  // The wire union has exactly one arm today. A second arm cannot slip through
  // silently: it would have to survive this destructure AND appear in
  // ACTION_BUTTON_KEYS above, both of which fail to compile until it is handled.
  const { vendor, agentId } = target
  return { tab: 'agent', vendor, agentId }
}
