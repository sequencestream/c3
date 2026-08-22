/**
 * Publish helpers for the closed `im:broadcast_candidate` topic.
 *
 * Domain code calls these after authoritative facts commit. Failures here are
 * fire-and-forget — they never roll back the underlying state change.
 */
import type { ImBroadcastCandidate } from '@ccc/shared/protocol'
import type { EventBus } from '../../kernel/events/event-bus.js'

let bus: EventBus | null = null

export function wireBroadcastCandidateBus(eventBus: EventBus): void {
  bus = eventBus
}

export function publishBroadcastCandidate(candidate: ImBroadcastCandidate): void {
  if (!bus) return
  try {
    bus.publish('im:broadcast_candidate', candidate)
  } catch (err) {
    console.warn(
      '[c3][im] broadcast candidate publish failed (non-fatal):',
      err instanceof Error ? err.message : String(err),
    )
  }
}

export function intentParkedKey(intentId: string, parkedAt: number, reason: string): string {
  return `intent_parked:${intentId}:${parkedAt}:${reason}`
}

export function intentSilentTimeoutKey(intentId: string, silentSince: number): string {
  return `intent_silent_timeout:${intentId}:${silentSince}`
}

export function intentRetryExhaustedKey(
  intentId: string,
  failureCount: number,
  parkedAt: number,
): string {
  return `intent_retry_exhausted:${intentId}:${failureCount}:${parkedAt}`
}

export function intentSpecPendingKey(intentId: string, fingerprint: string): string {
  return `intent_spec_pending:${intentId}:${fingerprint}`
}

export function permissionQueuedKey(requestId: string): string {
  return `permission_queued:${requestId}`
}

export function deliveryReviewKey(deliveryId: string, statusVersion: number): string {
  return `delivery_review:${deliveryId}:${statusVersion}`
}

export function deliveryDriftKey(deliveryId: string, baseSha: string, headSha: string): string {
  return `delivery_drift:${deliveryId}:${baseSha}:${headSha}`
}
