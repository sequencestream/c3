import type { ChatMsg } from './chat-types'

export const CHAT_BOTTOM_TOLERANCE_PX = 24

export interface ScrollMetrics {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
}

export function isNearBottom(
  metrics: ScrollMetrics,
  tolerancePx = CHAT_BOTTOM_TOLERANCE_PX,
): boolean {
  return metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight <= tolerancePx
}

export function chatScrollKey(messages: ChatMsg[]): string {
  const last = messages.at(-1)
  return `${messages.length}:${last ? lastMessageSignature(last) : 'empty'}`
}

function lastMessageSignature(message: ChatMsg): string {
  switch (message.kind) {
    case 'user':
    case 'assistant':
    case 'system':
      return `${message.id}:${message.kind}:${message.text}`
    case 'tool-result':
      return `${message.id}:${message.kind}:${message.content}`
    case 'tool-use':
      return `${message.id}:${message.kind}:${message.toolName}:${safeStringify(message.input)}`
    case 'permission':
      return `${message.id}:${message.kind}:${message.requestId}:${message.decision ?? 'pending'}`
    case 'consensus':
      return `${message.id}:${message.kind}:${message.toolName}:${safeStringify(message.outcome)}`
  }
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}
