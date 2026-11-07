/**
 * DSH `session.event` payloads → {@link CanonicalMessage} (ADR-0011/0013).
 * SDK types stay outside this file; events are read defensively from wire JSON.
 */
import type { CanonicalBlock, CanonicalMessage, CanonicalToolResult } from '../types.js'

export interface DshTranslation {
  messages: CanonicalMessage[]
  ended?: { isError: boolean; errorMessage?: string }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

function parseToolInput(args: string): unknown {
  try {
    return JSON.parse(args) as unknown
  } catch {
    return { raw: args }
  }
}

function flattenToText(value: unknown, depth = 0): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (depth > 4) return ''
  if (Array.isArray(value)) {
    return value
      .map((item) => flattenToText(item, depth + 1))
      .filter((text) => text.length > 0)
      .join('\n')
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    for (const key of ['content', 'text', 'message', 'output', 'stdout']) {
      if (record[key] !== undefined) return flattenToText(record[key], depth + 1)
    }
    return Object.values(record)
      .map((item) => flattenToText(item, depth + 1))
      .filter((text) => text.length > 0)
      .join('\n')
  }
  return ''
}

function toolResultContent(message: unknown): { content: string; isError: boolean } {
  if (!isRecord(message)) return { content: '', isError: false }
  const isError = message.isError === true
  const contentBlocks = message.content
  if (Array.isArray(contentBlocks)) {
    const text = contentBlocks
      .map((b) => (isRecord(b) && b.type === 'text' && typeof b.text === 'string' ? b.text : ''))
      .filter(Boolean)
      .join('\n')
    return { content: text, isError }
  }
  if (typeof message.content === 'string') return { content: message.content, isError }
  return { content: flattenToText(message), isError }
}

function assistantBlocks(message: unknown): CanonicalBlock[] {
  if (!isRecord(message)) return []
  const content = message.content
  if (!Array.isArray(content)) return []
  const blocks: CanonicalBlock[] = []
  for (const part of content) {
    if (!isRecord(part)) continue
    if (part.type === 'text' && typeof part.text === 'string') {
      blocks.push({ type: 'text', text: part.text })
      continue
    }
    if (part.type === 'tool_use' || part.type === 'tool-call') {
      const id = str(part.id) ?? str(part.callId) ?? `tool-${blocks.length}`
      const name = str(part.name) ?? 'unknown'
      const input =
        part.input ?? (typeof part.arguments === 'string' ? parseToolInput(part.arguments) : {})
      blocks.push({ type: 'tool_use', id, name, input })
    }
  }
  return blocks
}

export class DshStreamTranslator {
  private sessionId = ''
  private readonly tools = new Map<string, { name: string; input: unknown }>()
  private readonly now = () => Date.now()

  setSessionId(id: string): void {
    this.sessionId = id
  }

  private wrap(blocks: CanonicalBlock[]): CanonicalMessage {
    return {
      vendor: 'dsh',
      sessionId: this.sessionId,
      role: 'assistant',
      ts: this.now(),
      blocks,
    }
  }

  translateSessionEvent(envelope: unknown): DshTranslation {
    if (!isRecord(envelope)) return { messages: [] }
    const type = str(envelope.type)
    const data = isRecord(envelope.data) ? envelope.data : envelope

    if (type === 'assistant/message') {
      const message = data.message ?? data
      const blocks = assistantBlocks(message)
      if (blocks.length === 0) return { messages: [] }
      return { messages: [this.wrap(blocks)] }
    }

    if (type === 'tool/call') {
      const callId = str(data.callId) ?? str(data.id) ?? `call-${this.tools.size}`
      const name = str(data.name) ?? 'unknown'
      const input =
        typeof data.arguments === 'string' ? parseToolInput(data.arguments) : (data.arguments ?? {})
      this.tools.set(callId, { name, input })
      return {
        messages: [this.wrap([{ type: 'tool_use', id: callId, name, input }])],
      }
    }

    if (type === 'tool/result') {
      const callId = str(data.callId) ?? str(data.id)
      const prior = callId ? this.tools.get(callId) : undefined
      const { content, isError } = toolResultContent(data.message)
      const result: CanonicalToolResult = { content, isError }
      const id = callId ?? `orphan-${this.tools.size}`
      return {
        messages: [
          this.wrap([
            {
              type: 'tool_use',
              id,
              name: prior?.name ?? 'unknown',
              input: prior?.input ?? {},
              result,
            },
          ]),
        ],
      }
    }

    if (type === 'turn/end') {
      const reason = isRecord(data.reason) ? data.reason : data
      const kind = str(isRecord(reason) ? reason.kind : undefined)
      const isError = kind === 'error' || kind === 'aborted'
      const errorMessage =
        isError && isRecord(reason) && typeof reason.reason === 'string'
          ? reason.reason
          : isError
            ? kind
            : undefined
      return { messages: [], ended: { isError, errorMessage } }
    }

    return { messages: [] }
  }
}
