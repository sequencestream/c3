/**
 * A session's DELIVERY CONTEXT — the fact that decides what "my base" is.
 *
 * Before deliveries, a work session's base was always the workspace mainline, so
 * the intent alone determined everything. It no longer does: an intent may
 * belong to several deliveries, and each delivery is a different branch to root
 * a worktree on and a different answer to "is my dependency's output visible to
 * me". The context is therefore resolved ONCE per launch, persisted with the
 * session record, and reused verbatim by resume — never re-guessed.
 *
 * Resolution never picks for the user when a real choice exists: zero
 * associations means no context (the pre-delivery behaviour, unchanged), exactly
 * one is a FACT rather than a guess, and two or more is refused so the caller
 * asks. Same shape as `resolvePrTarget` in `pr-target.ts`, on purpose: an
 * intent must not be able to open a PR toward a delivery it could not develop
 * against.
 */
import type { Delivery, Intent } from '@ccc/shared/protocol'
import { pathToId } from '../../state.js'
import { getDelivery, listDeliveries } from '../deliveries/store.js'

/** Resolved context, or the rejection code the caller hands back. */
export type DeliveryContextResult =
  { ok: true; delivery: Delivery | null } | { ok: false; code: string }

/**
 * The delivery context an intent implies BY ITSELF, with no explicit choice: its
 * one association, or `null` when it has none — and also `null` when it has
 * several, because there is nothing to imply then.
 *
 * Used by the read-only projections (the action descriptor) and by the spec
 * launch gate, neither of which can ask the user: with several associations they
 * fall back to the delivery-less criterion rather than picking one. A launch that
 * WRITES code never uses this — it goes through {@link resolveSessionDeliveryContext},
 * which refuses instead.
 */
export function impliedDeliveryContextId(intent: Pick<Intent, 'linkedDeliveries'>): string | null {
  return intent.linkedDeliveries.length === 1 ? intent.linkedDeliveries[0].id : null
}

/**
 * Resolve the delivery context for a session that is about to write code.
 *
 * - An explicit `requestedDeliveryId` wins, and is validated exactly as a PR
 *   target is: the delivery must exist, belong to THIS workspace, and already be
 *   linked to the intent. An unlinked delivery would let a session develop
 *   against a branch the intent detail never shows it belongs to.
 * - Without one: zero associations → no context; exactly one → that one; two or
 *   more → `intent.deliveryContextRequired`. Never a default.
 */
export function resolveSessionDeliveryContext(
  workspacePath: string,
  intent: Pick<Intent, 'linkedDeliveries'>,
  requestedDeliveryId?: string | null,
): DeliveryContextResult {
  const linked = intent.linkedDeliveries
  let deliveryId: string | null
  if (requestedDeliveryId) {
    deliveryId = requestedDeliveryId
  } else if (linked.length === 0) {
    deliveryId = null
  } else if (linked.length === 1) {
    deliveryId = linked[0].id
  } else {
    return { ok: false, code: 'intent.deliveryContextRequired' }
  }

  if (deliveryId === null) return { ok: true, delivery: null }

  const delivery = getDelivery(deliveryId)
  if (!delivery || delivery.workspaceId !== pathToId(workspacePath)) {
    return { ok: false, code: 'intent.deliveryContextUnknown' }
  }
  if (!linked.some((d) => d.id === deliveryId)) {
    return { ok: false, code: 'intent.deliveryContextNotLinked' }
  }
  return { ok: true, delivery }
}

/**
 * Every delivery of a workspace, reduced to the gate fact shape. Read once per
 * evaluation at the boundary so the pure criteria stay pure.
 */
export function deliveryGateFacts(workspacePath: string): {
  id: string
  title: string
  status: Delivery['status']
}[] {
  return listDeliveries(workspacePath).map((d) => ({ id: d.id, title: d.title, status: d.status }))
}
