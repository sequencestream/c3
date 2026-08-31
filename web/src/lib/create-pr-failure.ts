import { activeIntentPrs, type Intent } from '@ccc/shared'

/** Error codes emitted by the manual `create_pr` gate chain. */
export const CREATE_PR_FAILURE_CODES = [
  'intent.prCreateFailed',
  'intent.prCreateNotWorktree',
  'intent.prCreateNoBranch',
  'intent.prCreateNoChanges',
] as const

export type CreatePrFailureCode = (typeof CREATE_PR_FAILURE_CODES)[number]

export function isCreatePrFailureCode(code: string): code is CreatePrFailureCode {
  return (CREATE_PR_FAILURE_CODES as readonly string[]).includes(code)
}

/** Context captured when a manual `create_pr` run fails. */
export interface CreatePrFailureContext {
  intentId: string
  deliveryId?: string
}

/**
 * Whether the failure dialog may offer「关联已有 PR」: the failure came from
 * `create_pr`, and the target `(intentId, deliveryId)` still has no active PR row.
 */
export function canOfferLinkExistingPr(
  ctx: CreatePrFailureContext | null,
  intents: readonly Intent[],
): boolean {
  if (!ctx) return false
  const intent = intents.find((i) => i.id === ctx.intentId)
  if (!intent) return false
  const targetDeliveryId = ctx.deliveryId ?? null
  return !activeIntentPrs(intent.prs).some((pr) => pr.deliveryId === targetDeliveryId)
}
