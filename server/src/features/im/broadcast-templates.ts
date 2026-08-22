/**
 * Registered L0 broadcast templates and strict field validation.
 *
 * Each event kind maps to one template key and an explicit field subset from
 * {@link IM_BROADCAST_FIELD_KEYS}. Unknown fields, free-text keys, objects and
 * arrays reject the whole render — nothing is silently dropped.
 */
import type { ImBroadcastFieldKey, ImBroadcastType } from '@ccc/shared/protocol'
import { IM_BROADCAST_FIELD_KEYS } from '@ccc/shared/protocol'
import { detectCredentialShape } from '../memory/content-guard.js'

export const BROADCAST_TITLE_MAX_CODEPOINTS = 120

export type TemplateFieldValues = Partial<Record<ImBroadcastFieldKey, string | number>>

export type TemplateRenderInput = {
  kind: ImBroadcastType
  /** Full projection for in-scope recipients. */
  fields: TemplateFieldValues
  /** Category-level downgrade when group scope hides object details. */
  groupDowngrade?: boolean
}

export type TemplateRenderResult =
  | { ok: true; templateKey: string; text: string }
  | {
      ok: false
      reason: 'unknown_kind' | 'extra_field' | 'invalid_type' | 'credential' | 'title_too_long'
    }

type TemplateDef = {
  key: string
  allowed: readonly ImBroadcastFieldKey[]
  render: (fields: TemplateFieldValues, downgrade: boolean) => string
}

const DOWNGRADE_TEXT: Record<ImBroadcastType, string> = {
  intent_parked: 'c3：有自动化意图已停驻，请到 Web 查看。',
  intent_silent_timeout: 'c3：有意图长时间无进展，请到 Web 查看。',
  intent_retry_exhausted: 'c3：有意图重试已耗尽并停驻，请到 Web 查看。',
  intent_spec_awaiting_approval: 'c3：有规格待审批，请到 Web 查看。',
  permission_queued: 'c3：有待处理权限请求，请到 Web 查看。',
  delivery_review_required: 'c3：有交付待验证，请到 Web 查看。',
  delivery_mainline_drift: 'c3：有交付分支与主线出现漂移，请到 Web 查看。',
}

function line(parts: string[]): string {
  return parts.filter(Boolean).join(' ')
}

const TEMPLATES: Record<ImBroadcastType, TemplateDef> = {
  intent_parked: {
    key: 'intent.parked',
    allowed: [
      'eventType',
      'objectType',
      'objectId',
      'objectTitle',
      'reasonCode',
      'occurredAt',
      'deepLink',
    ],
    render: (f, d) =>
      d
        ? DOWNGRADE_TEXT.intent_parked
        : line([
            'c3：意图已停驻',
            str(f.objectTitle),
            str(f.reasonCode) ? `(${str(f.reasonCode)})` : '',
            link(f.deepLink),
          ]),
  },
  intent_silent_timeout: {
    key: 'intent.silent_timeout',
    allowed: ['eventType', 'objectType', 'objectId', 'objectTitle', 'occurredAt', 'deepLink'],
    render: (f, d) =>
      d
        ? DOWNGRADE_TEXT.intent_silent_timeout
        : line(['c3：意图长时间无进展', str(f.objectTitle), link(f.deepLink)]),
  },
  intent_retry_exhausted: {
    key: 'intent.retry_exhausted',
    allowed: [
      'eventType',
      'objectType',
      'objectId',
      'objectTitle',
      'count',
      'occurredAt',
      'deepLink',
    ],
    render: (f, d) =>
      d
        ? DOWNGRADE_TEXT.intent_retry_exhausted
        : line([
            'c3：意图重试已耗尽',
            str(f.objectTitle),
            f.count != null ? `(第 ${f.count} 次)` : '',
            link(f.deepLink),
          ]),
  },
  intent_spec_awaiting_approval: {
    key: 'intent.spec_pending',
    allowed: ['eventType', 'objectType', 'objectId', 'objectTitle', 'deepLink'],
    render: (f, d) =>
      d
        ? DOWNGRADE_TEXT.intent_spec_awaiting_approval
        : line(['c3：规格待审批', str(f.objectTitle), link(f.deepLink)]),
  },
  permission_queued: {
    key: 'permission.queued',
    allowed: ['eventType', 'objectType', 'objectId', 'objectTitle', 'deepLink'],
    render: (f, d) =>
      d
        ? DOWNGRADE_TEXT.permission_queued
        : line(['c3：权限请求待处理', str(f.objectTitle) || str(f.objectId), link(f.deepLink)]),
  },
  delivery_review_required: {
    key: 'delivery.review_required',
    allowed: ['eventType', 'objectType', 'objectId', 'objectTitle', 'statusCode', 'deepLink'],
    render: (f, d) =>
      d
        ? DOWNGRADE_TEXT.delivery_review_required
        : line(['c3：交付待验证', str(f.objectTitle), link(f.deepLink)]),
  },
  delivery_mainline_drift: {
    key: 'delivery.mainline_drift',
    allowed: ['eventType', 'objectType', 'objectId', 'objectTitle', 'deepLink'],
    render: (f, d) =>
      d
        ? DOWNGRADE_TEXT.delivery_mainline_drift
        : line(['c3：交付分支与主线出现漂移', str(f.objectTitle), link(f.deepLink)]),
  },
}

function str(v: string | number | undefined): string {
  if (v == null) return ''
  return String(v).trim()
}

function link(v: string | number | undefined): string {
  const s = str(v)
  return s ? `\n${s}` : ''
}

function codePointCount(text: string): number {
  return [...text].length
}

/** Validate declared fields only, then render. */
export function renderBroadcastTemplate(input: TemplateRenderInput): TemplateRenderResult {
  const def = TEMPLATES[input.kind]
  if (!def) return { ok: false, reason: 'unknown_kind' }

  const allowed = new Set(def.allowed)
  for (const key of Object.keys(input.fields)) {
    if (!(IM_BROADCAST_FIELD_KEYS as readonly string[]).includes(key)) {
      return { ok: false, reason: 'extra_field' }
    }
    if (!allowed.has(key as ImBroadcastFieldKey)) {
      return { ok: false, reason: 'extra_field' }
    }
    const val = input.fields[key as ImBroadcastFieldKey]
    if (val != null && typeof val !== 'string' && typeof val !== 'number') {
      return { ok: false, reason: 'invalid_type' }
    }
  }

  const title = input.fields.objectTitle
  if (typeof title === 'string' && codePointCount(title) > BROADCAST_TITLE_MAX_CODEPOINTS) {
    return { ok: false, reason: 'title_too_long' }
  }

  const text = def.render(input.fields, input.groupDowngrade === true)
  if (detectCredentialShape(text)) return { ok: false, reason: 'credential' }

  return { ok: true, templateKey: def.key, text }
}

/** Server-generated read-only deep links — never accept caller URLs. */
export function buildDeepLink(
  baseUrl: string | undefined,
  objectType: 'intent' | 'delivery' | 'todo',
  objectId: string,
): string | undefined {
  if (!baseUrl) return undefined
  const trimmed = baseUrl.replace(/\/+$/, '')
  if (!/^https?:\/\//i.test(trimmed)) return undefined
  switch (objectType) {
    case 'intent':
      return `${trimmed}/intents/${encodeURIComponent(objectId)}`
    case 'delivery':
      return `${trimmed}/deliveries/${encodeURIComponent(objectId)}`
    case 'todo':
      return `${trimmed}/workcenter`
    default:
      return undefined
  }
}
