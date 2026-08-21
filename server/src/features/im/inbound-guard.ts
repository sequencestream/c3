/**
 * Inbound persistence guards for robot context: credential shapes and the
 * Unicode code-point ceiling. A hit refuses the whole message — no truncate,
 * no run, no body write.
 */
import { ROBOT_CONTEXT_MAX_CODEPOINTS, type ImInputRejectReason } from '@ccc/shared/protocol'
import { detectCredentialShape } from '../memory/content-guard.js'

export function codePointCount(value: string): number {
  return Array.from(value).length
}

export function truncateCodePoints(value: string, max: number): string {
  const points = Array.from(value)
  if (points.length <= max) return value
  return points.slice(0, max).join('')
}

export type InboundGuardResult =
  { ok: true } | { ok: false; reason: ImInputRejectReason; notice: string }

/** Fixed notices — never echo the matched content. */
export const INBOUND_CREDENTIAL_NOTICE = '疑似凭据,未处理也未保存。'
export const INBOUND_TOO_LONG_NOTICE = `消息过长(超过 ${ROBOT_CONTEXT_MAX_CODEPOINTS} 个字符),未处理也未保存。`

export function screenInbound(text: string): InboundGuardResult {
  if (detectCredentialShape(text)) {
    return { ok: false, reason: 'credential', notice: INBOUND_CREDENTIAL_NOTICE }
  }
  if (codePointCount(text) > ROBOT_CONTEXT_MAX_CODEPOINTS) {
    return { ok: false, reason: 'too_long', notice: INBOUND_TOO_LONG_NOTICE }
  }
  return { ok: true }
}
