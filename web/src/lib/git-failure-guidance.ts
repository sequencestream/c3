/*
 * git-failure-guidance — the client half of the Git / forge failure contract.
 *
 * The server sends a stable reason code plus a retry target, never a sentence:
 * this module is the single place that turns the code into the localized repair
 * instruction and the retry into a button label, so the dialog cannot describe
 * the same failure two different ways.
 *
 * It is also the trust boundary. A frame is untrusted input: `normalizeGuidance`
 * accepts ONLY a well-formed payload whose reason and retry action are members of
 * the closed protocol unions, and returns `null` for everything else. The dialog
 * then falls back to the plain translated error and renders no button — an
 * unrecognized descriptor must never produce an action the user cannot judge.
 */
import { GIT_ACTION_FAILURE_REASONS, INTENT_RETRY_ACTIONS } from '@ccc/shared/protocol'
import type {
  GitActionFailureGuidance,
  GitActionFailureReason,
  IntentRetryAction,
} from '@ccc/shared/protocol'
import type { LocaleKey } from '@/i18n'

/**
 * What to DO about each failure, as the instruction shown to the user. Every
 * line asks the user to act — c3 has repaired nothing, and the copy never
 * suggests otherwise.
 *
 * `unknown` has no entry on purpose: with no identified cause there are no
 * defensible steps, so the raw error is shown by itself instead of a guess.
 */
export const GUIDANCE_MESSAGE_KEYS = {
  worktree_branch_or_path_taken: 'intent.gitFailure.worktreeBranchOrPathTaken',
  repo_conflict_unresolved: 'intent.gitFailure.repoConflictUnresolved',
  filesystem_denied: 'intent.gitFailure.filesystemDenied',
  forge_cli_unavailable: 'intent.gitFailure.forgeCliUnavailable',
  remote_permission_denied: 'intent.gitFailure.remotePermissionDenied',
  push_rejected: 'intent.gitFailure.pushRejected',
  network_unreachable: 'intent.gitFailure.networkUnreachable',
  commit_hook_rejected: 'intent.gitFailure.commitHookRejected',
  forge_create_rejected: 'intent.gitFailure.forgeCreateRejected',
} as const satisfies Record<Exclude<GitActionFailureReason, 'unknown'>, LocaleKey>

/** The retry button's label, one per allowed action. */
export const RETRY_BUTTON_KEYS = {
  'start-development': 'intent.gitFailure.retryStartDevelopment.label',
  'create-pr': 'intent.gitFailure.retryCreatePr.label',
} as const satisfies Record<IntentRetryAction, LocaleKey>

/** The i18n key for a reason's repair instruction, or `null` for `unknown`. */
export function guidanceMessageKey(reason: GitActionFailureReason): LocaleKey | null {
  return reason === 'unknown' ? null : GUIDANCE_MESSAGE_KEYS[reason]
}

/** The i18n key for a retry action's button label. */
export function retryButtonKey(action: IntentRetryAction): LocaleKey {
  return RETRY_BUTTON_KEYS[action]
}

function isReason(value: unknown): value is GitActionFailureReason {
  return (GIT_ACTION_FAILURE_REASONS as readonly string[]).includes(value as string)
}

function isRetryAction(value: unknown): value is IntentRetryAction {
  return (INTENT_RETRY_ACTIONS as readonly string[]).includes(value as string)
}

/**
 * Validate an incoming guidance payload. Returns it unchanged when every field
 * is well-formed and both codes are inside their closed union, else `null`.
 * A missing `detail` is normalized to the empty string — absent detail is a
 * display case (the dialog shows its stable fallback), not a reason to drop the
 * whole guidance.
 */
export function normalizeGuidance(raw: unknown): GitActionFailureGuidance | null {
  if (!raw || typeof raw !== 'object') return null
  const g = raw as Partial<GitActionFailureGuidance>
  if (!isReason(g.reason)) return null
  const retry = g.retry
  if (!retry || typeof retry !== 'object') return null
  if (retry.type !== 'intent-action') return null
  if (typeof retry.intentId !== 'string' || retry.intentId === '') return null
  if (!isRetryAction(retry.action)) return null
  return {
    reason: g.reason,
    detail: typeof g.detail === 'string' ? g.detail : '',
    retry: { type: 'intent-action', intentId: retry.intentId, action: retry.action },
  }
}
