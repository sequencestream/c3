/**
 * IM 诊断日志 —— 连接 / 入站 / 出站 / 绑定挑战在终端与 `c3.log` 中的统一格式。
 *
 * 只记元数据，不记验证码明文、消息正文、凭据或令牌。sender 一律用稳定摘要。
 * 时间戳由进程级日志 tee 补齐，本模块不重复打印。
 */
import { createHash } from 'node:crypto'
import type { ImConnectionStatus, ImRobot } from '@ccc/shared/protocol'
import type { ImInboundMessage } from './types.js'

/** Base64url-ish binding token shape — mirrors supervisor, for flags only. */
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{20,48}$/

/** Stable short digest of an external sender id (same width as identity audit). */
export function imSenderDigest(senderId: string): string {
  return createHash('sha256').update(senderId, 'utf8').digest('hex').slice(0, 16)
}

function robotTag(robot: Pick<ImRobot, 'id' | 'name' | 'platform'>): string {
  return `robot=${robot.name} id=${robot.id} platform=${robot.platform}`
}

function shortId(id: string): string {
  if (id.length <= 12) return id
  return `${id.slice(0, 6)}…${id.slice(-4)}`
}

export function formatImConnecting(robot: Pick<ImRobot, 'id' | 'name' | 'platform'>): string {
  return `[im] connecting ${robotTag(robot)}`
}

export function formatImConnected(
  robot: Pick<ImRobot, 'id' | 'name' | 'platform'>,
  status: ImConnectionStatus,
): string {
  return `[im] connected ${robotTag(robot)} state=${status.state} reconnects=${status.reconnectAttempts}`
}

export function formatImConnectionState(
  robot: Pick<ImRobot, 'id' | 'name' | 'platform'>,
  status: ImConnectionStatus,
): string {
  const err = status.lastError ? ` error=${status.lastError.slice(0, 120)}` : ''
  return `[im] connection ${robotTag(robot)} state=${status.state} reconnects=${status.reconnectAttempts}${err}`
}

export function formatImConnectFailed(
  robot: Pick<ImRobot, 'id' | 'name' | 'platform'>,
  detail: string,
): string {
  return `[im] connect_failed ${robotTag(robot)} error=${detail.slice(0, 200)}`
}

export type ImInboundLogFields = {
  robot: Pick<ImRobot, 'id' | 'name' | 'platform'>
  message: ImInboundMessage
}

export function formatImInbound(fields: ImInboundLogFields): string {
  const { robot, message: m } = fields
  const tokenish = TOKEN_SHAPE.test(m.text.trim()) ? 'yes' : 'no'
  return (
    `[im] inbound ${robotTag(robot)} chat=${m.chatType} msg=${shortId(m.messageId)} ` +
    `sender=${imSenderDigest(m.senderId)} chars=${m.text.length} tokenish=${tokenish}` +
    (m.mentionedBot ? ' mentioned=yes' : '')
  )
}

export function formatImInboundIgnored(
  robot: Pick<ImRobot, 'id' | 'name' | 'platform'>,
  reason: string,
  extra?: string,
): string {
  return `[im] inbound_ignored ${robotTag(robot)} reason=${reason}${extra ? ` ${extra}` : ''}`
}

export type ImOutboundLogFields = {
  robot: Pick<ImRobot, 'id' | 'name' | 'platform'>
  category: string
  chatType: 'group' | 'p2p' | 'dm' | 'broadcast'
  noticeKey?: string
  templateKey?: string
  ok: boolean
  reason?: string
  outboundChars?: number
  outMessageId?: string
}

export function formatImOutbound(fields: ImOutboundLogFields): string {
  const key =
    fields.noticeKey != null
      ? ` notice=${fields.noticeKey}`
      : fields.templateKey != null
        ? ` template=${fields.templateKey}`
        : ''
  const outcome = fields.ok
    ? `ok chars=${fields.outboundChars ?? 0}`
    : `refused reason=${fields.reason ?? 'unknown'}`
  const outMsg = fields.outMessageId ? ` out=${shortId(fields.outMessageId)}` : ''
  return (
    `[im] outbound ${robotTag(fields.robot)} category=${fields.category}${key} ` +
    `chat=${fields.chatType} ${outcome}${outMsg}`
  )
}

export function formatImChallengeCreated(fields: {
  robotId: string
  subject: string
  accountNamespace: string
  challengeId: string
  expiresAt: number
}): string {
  return (
    `[im] challenge_created subject=${fields.subject} ns=${fields.accountNamespace} ` +
    `robotId=${fields.robotId} challenge=${shortId(fields.challengeId)} ` +
    `expires_in_ms=${Math.max(0, fields.expiresAt - Date.now())}`
  )
}

export function formatImChallengeCancelled(fields: {
  robotId: string
  subject: string
  challengeId: string
}): string {
  return (
    `[im] challenge_cancelled subject=${fields.subject} robotId=${fields.robotId} ` +
    `challenge=${shortId(fields.challengeId)}`
  )
}

export function formatImChallengeConsume(fields: {
  robotId: string
  accountNamespace: string
  senderId: string
  ok: boolean
  reason?: string
  bindingId?: string
  subject?: string
}): string {
  const base =
    `[im] challenge_consume robotId=${fields.robotId} ns=${fields.accountNamespace} ` +
    `sender=${imSenderDigest(fields.senderId)}`
  if (fields.ok) {
    return `${base} result=ok subject=${fields.subject ?? '?'} binding=${shortId(fields.bindingId ?? '')}`
  }
  return `${base} result=failed reason=${fields.reason ?? 'failed'}`
}

export function formatImBindingControl(fields: {
  robot: Pick<ImRobot, 'id' | 'name' | 'platform'>
  chatType: 'group' | 'p2p'
  path: 'use_dm' | 'consume'
  result?: 'ok' | 'failed' | 'rate_limited'
}): string {
  const result = fields.result ? ` result=${fields.result}` : ''
  return (
    `[im] binding_control ${robotTag(fields.robot)} chat=${fields.chatType} ` +
    `path=${fields.path}${result}`
  )
}

export function formatImProviderSkip(fields: {
  robotId: string
  reason: string
  messageType?: string
  chatType?: string
}): string {
  const type = fields.messageType ? ` type=${fields.messageType}` : ''
  const chat = fields.chatType ? ` chat=${fields.chatType}` : ''
  return `[im] provider_skip robotId=${fields.robotId} reason=${fields.reason}${type}${chat}`
}

export function logImConnecting(robot: Pick<ImRobot, 'id' | 'name' | 'platform'>): void {
  console.log(formatImConnecting(robot))
}

export function logImConnected(
  robot: Pick<ImRobot, 'id' | 'name' | 'platform'>,
  status: ImConnectionStatus,
): void {
  console.log(formatImConnected(robot, status))
}

export function logImConnectionState(
  robot: Pick<ImRobot, 'id' | 'name' | 'platform'>,
  status: ImConnectionStatus,
): void {
  console.log(formatImConnectionState(robot, status))
}

export function logImConnectFailed(
  robot: Pick<ImRobot, 'id' | 'name' | 'platform'>,
  detail: string,
): void {
  console.error(formatImConnectFailed(robot, detail))
}

export function logImInbound(fields: ImInboundLogFields): void {
  console.log(formatImInbound(fields))
}

export function logImInboundIgnored(
  robot: Pick<ImRobot, 'id' | 'name' | 'platform'>,
  reason: string,
  extra?: string,
): void {
  console.log(formatImInboundIgnored(robot, reason, extra))
}

export function logImOutbound(fields: ImOutboundLogFields): void {
  const line = formatImOutbound(fields)
  if (fields.ok) console.log(line)
  else console.warn(line)
}

export function logImChallengeCreated(
  fields: Parameters<typeof formatImChallengeCreated>[0],
): void {
  console.log(formatImChallengeCreated(fields))
}

export function logImChallengeCancelled(
  fields: Parameters<typeof formatImChallengeCancelled>[0],
): void {
  console.log(formatImChallengeCancelled(fields))
}

export function logImChallengeConsume(
  fields: Parameters<typeof formatImChallengeConsume>[0],
): void {
  const line = formatImChallengeConsume(fields)
  if (fields.ok) console.log(line)
  else console.warn(line)
}

export function logImBindingControl(fields: Parameters<typeof formatImBindingControl>[0]): void {
  console.log(formatImBindingControl(fields))
}

export function logImProviderSkip(fields: Parameters<typeof formatImProviderSkip>[0]): void {
  console.log(formatImProviderSkip(fields))
}
