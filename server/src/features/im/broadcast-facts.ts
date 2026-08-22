/**
 * Resolve authoritative domain facts for L0 broadcast templates.
 *
 * Workspace name and object titles always come from the store at render time —
 * never from the candidate payload or generic events.
 */
import type { ImBroadcastCandidate, ImBroadcastType } from '@ccc/shared/protocol'
import { loadSettings } from '../../kernel/config/index.js'
import { getIntent } from '../intents/store.js'
import { getDelivery } from '../deliveries/store.js'
import { getEventByRequestId } from '../user-involve/store.js'
import { buildDeepLink, type TemplateFieldValues } from './broadcast-templates.js'

export type ResolvedBroadcastFacts = {
  kind: ImBroadcastType
  workspaceName: string
  idempotencyKey: string
  fields: TemplateFieldValues
}

export function resolveBroadcastFacts(
  candidate: ImBroadcastCandidate,
): ResolvedBroadcastFacts | null {
  const baseUrl = loadSettings().baseUrl

  switch (candidate.kind) {
    case 'intent_parked':
    case 'intent_silent_timeout':
    case 'intent_retry_exhausted':
    case 'intent_spec_awaiting_approval': {
      const intent = getIntent(candidate.intentId)
      if (!intent) return null
      const fields: TemplateFieldValues = {
        eventType: candidate.kind,
        objectType: 'intent',
        objectId: intent.id,
        objectTitle: intent.title,
        deepLink: buildDeepLink(baseUrl, 'intent', intent.id),
      }
      if (candidate.kind === 'intent_parked') {
        fields.reasonCode = candidate.parkReason
        fields.occurredAt = candidate.parkedAt
      }
      if (candidate.kind === 'intent_silent_timeout') {
        fields.occurredAt = candidate.silentSince
      }
      if (candidate.kind === 'intent_retry_exhausted') {
        fields.count = candidate.failureCount
        fields.occurredAt = candidate.parkedAt
      }
      return {
        kind: candidate.kind,
        workspaceName: intent.workspaceName,
        idempotencyKey: candidate.idempotencyKey,
        fields,
      }
    }
    case 'permission_queued': {
      const row = getEventByRequestId(candidate.requestId)
      if (!row || row.status !== 'todo') return null
      if (row.requestId?.startsWith('queue:')) return null
      return {
        kind: candidate.kind,
        workspaceName: row.workspaceName,
        idempotencyKey: candidate.idempotencyKey,
        fields: {
          eventType: candidate.kind,
          objectType: 'todo',
          objectId: row.id,
          objectTitle: row.title ?? row.toolName ?? row.id,
          deepLink: buildDeepLink(baseUrl, 'todo', row.id),
        },
      }
    }
    case 'delivery_review_required':
    case 'delivery_mainline_drift': {
      const delivery = getDelivery(candidate.deliveryId)
      if (!delivery) return null
      const fields: TemplateFieldValues = {
        eventType: candidate.kind,
        objectType: 'delivery',
        objectId: delivery.id,
        objectTitle: delivery.title,
        deepLink: buildDeepLink(baseUrl, 'delivery', delivery.id),
      }
      if (candidate.kind === 'delivery_review_required') {
        fields.statusCode = 'verifying'
      }
      return {
        kind: candidate.kind,
        workspaceName: delivery.workspaceName,
        idempotencyKey: candidate.idempotencyKey,
        fields,
      }
    }
    default:
      return null
  }
}
