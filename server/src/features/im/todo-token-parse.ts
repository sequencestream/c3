/**
 * Parse and classify inbound todo token commands.
 *
 * Order: c3todo_ prefix is checked before identity binding TOKEN_SHAPE.
 */
import { TODO_TOKEN_PREFIX } from '@ccc/shared/protocol'

export interface ParsedTodoCommand {
  kind: 'token_only' | 'full_command' | 'malformed'
  token?: string
  answerId?: string
}

const ANSWER_ID = /^[a-z][a-z0-9_]{0,31}$/

export function parseTodoInbound(text: string): ParsedTodoCommand | null {
  const trimmed = text.trim()
  if (!trimmed.startsWith(TODO_TOKEN_PREFIX)) return null
  const rest = trimmed.slice(TODO_TOKEN_PREFIX.length)
  if (!rest) return { kind: 'malformed' }
  const space = rest.indexOf(' ')
  if (space < 0) {
    if (!rest.match(/^[A-Za-z0-9_-]{20,64}$/)) return { kind: 'malformed' }
    return { kind: 'token_only', token: trimmed }
  }
  const tokenPart = TODO_TOKEN_PREFIX + rest.slice(0, space)
  const answerPart = rest.slice(space + 1).trim()
  if (rest.slice(space + 1) !== answerPart || answerPart.includes(' ')) {
    return { kind: 'malformed' }
  }
  if (!ANSWER_ID.test(answerPart)) return { kind: 'malformed' }
  return { kind: 'full_command', token: tokenPart, answerId: answerPart }
}

export function extractTodoTokenPlaintext(fullToken: string): string {
  return fullToken.trim()
}
