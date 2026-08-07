/**
 * Delivery facts as the SCHEDULING gates read them, plus the one rule that says
 * when a delivery forbids new writes.
 *
 * Shared for the same reason the dependency criterion is: the queue kernel and
 * the manual admission gate must give the same answer, and the kernel may not
 * import features (ADR-0009). Pure data in, verdict out.
 */
import type { DeliveryStatus } from './protocol.js'

/** One delivery, reduced to what the gates and their explanations need. */
export interface DeliveryGateFact {
  id: string
  title: string
  status: DeliveryStatus
}

/**
 * Delivery statuses during which NO new write session may start for an
 * associated intent.
 *
 * - `verifying` / `verified` — the integrated result is being (or has been)
 *   verified; merging more code into it would invalidate the conclusion that
 *   was reached about a specific tree.
 * - `delivered` / `cancelled` — terminal. There is nothing left to write into.
 *
 * `planned` and `integrating` are the writable states: that is exactly the
 * window a delivery exists to collect work in.
 */
export const DELIVERY_WRITE_BLOCKING_STATUSES: readonly DeliveryStatus[] = [
  'verifying',
  'verified',
  'delivered',
  'cancelled',
]

/** Whether this delivery status forbids new writes. */
export function isDeliveryWriteBlocked(status: DeliveryStatus): boolean {
  return DELIVERY_WRITE_BLOCKING_STATUSES.includes(status)
}

/**
 * The first of an intent's deliveries that forbids new writes, or `null` when
 * none does. STRICTEST reading on purpose: an intent linked to several
 * deliveries is blocked as soon as ANY of them is closed to writes — a write
 * lands on one branch but the intent belongs to all of them, so the safe answer
 * is the most restrictive one. A delivery id the snapshot does not know is
 * ignored (it cannot be shown to be blocking).
 */
export function findWriteBlockingDelivery(
  deliveryIds: readonly string[],
  deliveries: readonly DeliveryGateFact[],
): DeliveryGateFact | null {
  const byId = new Map(deliveries.map((d) => [d.id, d]))
  for (const id of deliveryIds) {
    const delivery = byId.get(id)
    if (delivery && isDeliveryWriteBlocked(delivery.status)) return delivery
  }
  return null
}
