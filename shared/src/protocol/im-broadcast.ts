/**
 * L0 IM proactive broadcast — closed vocabulary and audit shapes.
 *
 * These types configure which server-side domain facts may become IM template
 * messages. They are NOT generic automation event types and never appear in
 * {@link import('../event-catalog.js').EVENT_CATALOG}.
 */

/** Closed L0 broadcast kinds — one registered template each. */
export const IM_BROADCAST_TYPES = [
  'intent_parked',
  'intent_silent_timeout',
  'intent_retry_exhausted',
  'intent_spec_awaiting_approval',
  'permission_queued',
  'delivery_review_required',
  'delivery_mainline_drift',
] as const
export type ImBroadcastType = (typeof IM_BROADCAST_TYPES)[number]

/** Allowed template field keys — any other key rejects the whole render. */
export const IM_BROADCAST_FIELD_KEYS = [
  'eventType',
  'objectType',
  'objectId',
  'objectTitle',
  'statusCode',
  'reasonCode',
  'count',
  'occurredAt',
  'deepLink',
] as const
export type ImBroadcastFieldKey = (typeof IM_BROADCAST_FIELD_KEYS)[number]

/** Outbound audit content categories — distinct from {@link ImTurnOutcome}. */
export const IM_OUTBOUND_CATEGORIES = [
  'reply',
  'fixed_notice',
  'binding_notice',
  'broadcast',
] as const
export type ImOutboundCategory = (typeof IM_OUTBOUND_CATEGORIES)[number]

/** Target channel for one guarded outbound attempt. */
export const IM_OUTBOUND_TARGET_KINDS = ['inbound_reply', 'p2p_dm', 'group'] as const
export type ImOutboundTargetKind = (typeof IM_OUTBOUND_TARGET_KINDS)[number]

/** One unified outbound audit row (metadata only — never body or deep link). */
export interface ImOutboundAuditLog {
  id: string
  robotId: string
  category: ImOutboundCategory
  /** L0 source kind when category is `broadcast`. */
  sourceEventKind: ImBroadcastType | null
  /** Idempotency key for broadcast dedup. */
  idempotencyKey: string | null
  targetKind: ImOutboundTargetKind
  /** Redacted target id (chat or sender). */
  targetRef: string
  objectWorkspace: string | null
  templateKey: string | null
  result: 'sent' | 'refused' | 'zero_targets' | 'platform_failed'
  refuseReason: string | null
  outboundChars: number
  platformMessageId: string | null
  at: number
}

/** Strong-typed L0 candidate — closed union, server domain code only. */
export type ImBroadcastCandidate =
  | {
      kind: 'intent_parked'
      intentId: string
      parkReason: string
      parkedAt: number
      idempotencyKey: string
    }
  | {
      kind: 'intent_silent_timeout'
      intentId: string
      silentSince: number
      idempotencyKey: string
    }
  | {
      kind: 'intent_retry_exhausted'
      intentId: string
      failureCount: number
      parkedAt: number
      idempotencyKey: string
    }
  | {
      kind: 'intent_spec_awaiting_approval'
      intentId: string
      specFingerprint: string
      idempotencyKey: string
    }
  | {
      kind: 'permission_queued'
      requestId: string
      idempotencyKey: string
    }
  | {
      kind: 'delivery_review_required'
      deliveryId: string
      statusVersion: number
      idempotencyKey: string
    }
  | {
      kind: 'delivery_mainline_drift'
      deliveryId: string
      baseSha: string
      headSha: string
      idempotencyKey: string
    }
