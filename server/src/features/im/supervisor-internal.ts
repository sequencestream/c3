import type { ImConnectionStatus, ImRobot } from '@ccc/shared/protocol'
import { join } from 'node:path'
import { c3HomeDir } from '../../kernel/config/paths.js'
import { redactSecrets } from '../../kernel/security/index.js'
import {
  sendGuarded,
  type OutboundContent,
  type OutboundTarget,
  type RawImSend,
  type RobotMessageRef,
  type RobotRenderContext,
} from './outbound-guard.js'
import { resolveRobotRenderContext } from './robot-message-registry.js'
import type { ImInboundMessage, ImProviderCapabilities } from './types.js'
import { failContextTurn } from './robot-store.js'

export interface RobotHandle {
  status: () => ImConnectionStatus
  close: () => Promise<void>
  maxOutboundChars: number
  rawSend: RawImSend
  sendOutbound: (
    content: OutboundContent,
    target: OutboundTarget,
    renderContext: RobotRenderContext,
  ) => Promise<Awaited<ReturnType<typeof sendGuarded>>>
}

/** Base64url-ish token shape (128-bit ≈ 22 chars; allow a small range). */
export const TOKEN_SHAPE = /^[A-Za-z0-9_-]{20,48}$/

export function robotWorkdir(name: string): string {
  return join(c3HomeDir(), 'robots', name)
}

export function errText(err: unknown): string {
  return redactSecrets(err instanceof Error ? err.message : String(err)).slice(0, 200)
}

export function targetOf(m: ImInboundMessage): OutboundTarget {
  return { chatId: m.chatId, chatType: m.chatType, senderId: m.senderId }
}

export function renderCtx(r: ImRobot, subject?: string | null): RobotRenderContext {
  return resolveRobotRenderContext({ subject, robotLocale: r.locale })
}

export function fail(contextTurnId: string): void {
  try {
    failContextTurn(contextTurnId)
  } catch (e) {
    console.error('[c3][im] context failure:', errText(e))
  }
}

export async function fixed(
  h: RobotHandle,
  message: RobotMessageRef,
  t: OutboundTarget,
  ctx: RobotRenderContext,
) {
  return h.sendOutbound({ category: 'fixed_notice', message }, t, ctx)
}

export async function bindingNotice(
  h: RobotHandle,
  message: RobotMessageRef,
  t: OutboundTarget,
  ctx: RobotRenderContext,
) {
  return h.sendOutbound({ category: 'binding_notice', message, origin: t }, t, ctx)
}

export function identityRequiredRef(chatType: 'group' | 'p2p'): RobotMessageRef {
  if (chatType === 'group') {
    return {
      key: 'binding.identityRequiredGroup',
      params: { nav: { kind: 'webEntry' } },
    }
  }
  return {
    key: 'binding.identityRequired',
    params: { nav: { kind: 'webEntry' } },
  }
}

export function wrapHandle(
  robotId: string,
  c: { status: () => ImConnectionStatus; send: RawImSend; close: () => Promise<void> },
  capabilities: ImProviderCapabilities,
): RobotHandle {
  return {
    status: c.status,
    close: c.close,
    maxOutboundChars: capabilities.maxOutboundChars,
    rawSend: c.send,
    sendOutbound: (content, target, renderContext) =>
      sendGuarded({
        robotId,
        target,
        content,
        maxOutboundChars: capabilities.maxOutboundChars,
        renderContext,
        rawSend: c.send,
      }),
  }
}
