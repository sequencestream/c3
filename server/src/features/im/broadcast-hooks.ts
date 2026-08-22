/**
 * Domain-side L0 broadcast publish points — call after authoritative facts commit.
 */
import type { QueueReasonCode } from '../../kernel/queue/index.js'
import { QUEUE_MAX_ATTEMPTS } from '../../kernel/queue/index.js'
import {
  intentParkedKey,
  intentRetryExhaustedKey,
  intentSilentTimeoutKey,
  intentSpecPendingKey,
  permissionQueuedKey,
  deliveryReviewKey,
  deliveryDriftKey,
  publishBroadcastCandidate,
} from './broadcast-publish.js'

export function maybePublishIntentParked(
  intentId: string,
  reason: QueueReasonCode,
  _detail: string,
  parkedAt: number = Date.now(),
): void {
  if (reason === 'max_attempts_reached') return
  publishBroadcastCandidate({
    kind: 'intent_parked',
    intentId,
    parkReason: reason,
    parkedAt,
    idempotencyKey: intentParkedKey(intentId, parkedAt, reason),
  })
}

export function maybePublishIntentRetryExhausted(
  intentId: string,
  failureCount: number,
  parkedAt: number = Date.now(),
): void {
  if (failureCount < QUEUE_MAX_ATTEMPTS) return
  publishBroadcastCandidate({
    kind: 'intent_retry_exhausted',
    intentId,
    failureCount,
    parkedAt,
    idempotencyKey: intentRetryExhaustedKey(intentId, failureCount, parkedAt),
  })
}

export function maybePublishSilentTimeout(intentId: string, silentSince: number): void {
  publishBroadcastCandidate({
    kind: 'intent_silent_timeout',
    intentId,
    silentSince,
    idempotencyKey: intentSilentTimeoutKey(intentId, silentSince),
  })
}

export function maybePublishSpecAwaitingApproval(intentId: string, specFingerprint: string): void {
  publishBroadcastCandidate({
    kind: 'intent_spec_awaiting_approval',
    intentId,
    specFingerprint,
    idempotencyKey: intentSpecPendingKey(intentId, specFingerprint),
  })
}

export function maybePublishPermissionQueued(requestId: string): void {
  if (requestId.startsWith('queue:')) return
  publishBroadcastCandidate({
    kind: 'permission_queued',
    requestId,
    idempotencyKey: permissionQueuedKey(requestId),
  })
}

export function maybePublishDeliveryReviewRequired(
  deliveryId: string,
  statusVersion: number,
): void {
  publishBroadcastCandidate({
    kind: 'delivery_review_required',
    deliveryId,
    statusVersion,
    idempotencyKey: deliveryReviewKey(deliveryId, statusVersion),
  })
}

export function maybePublishDeliveryMainlineDrift(
  deliveryId: string,
  baseSha: string,
  headSha: string,
): void {
  publishBroadcastCandidate({
    kind: 'delivery_mainline_drift',
    deliveryId,
    baseSha,
    headSha,
    idempotencyKey: deliveryDriftKey(deliveryId, baseSha, headSha),
  })
}
