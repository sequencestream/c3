/**
 * OpenCode → canonical translation (ADR-0013, 2026-06-06-003). Pins the part→block
 * mapping (text, tool with embedded result), the whole-message read shape, and the
 * stream translator's role stamping.
 */
import { describe, expect, it } from 'vitest'
import type { Message, Part } from '@opencode-ai/sdk'
import { messageToCanonical, partToBlock, OpencodeStreamTranslator } from './translate.js'

function textPart(id: string, text: string, extra: Partial<Part> = {}): Part {
  return { id, sessionID: 's', messageID: 'm', type: 'text', text, ...extra } as Part
}
function toolPart(callID: string, tool: string, state: unknown): Part {
  return {
    id: `prt_${callID}`,
    sessionID: 's',
    messageID: 'm',
    type: 'tool',
    callID,
    tool,
    state,
  } as Part
}

describe('partToBlock', () => {
  it('maps a text part to a text block keyed by part id', () => {
    expect(partToBlock(textPart('p1', 'hello'))).toEqual({ type: 'text', text: 'hello', id: 'p1' })
  })

  it('skips synthetic / ignored text', () => {
    expect(partToBlock(textPart('p1', 'x', { synthetic: true }))).toBeNull()
    expect(partToBlock(textPart('p2', 'x', { ignored: true }))).toBeNull()
  })

  it('maps a completed tool part to tool_use with an embedded result (keyed by callID)', () => {
    const block = partToBlock(
      toolPart('call_1', 'bash', {
        status: 'completed',
        input: { cmd: 'ls' },
        output: 'file.txt',
        title: 'ls',
        metadata: {},
        time: { start: 0, end: 1 },
      }),
    )
    expect(block).toMatchObject({
      type: 'tool_use',
      id: 'call_1',
      name: 'bash',
      input: { cmd: 'ls' },
      result: { content: 'file.txt', isError: false },
    })
  })

  it('maps an errored tool part to an error result', () => {
    const block = partToBlock(
      toolPart('call_2', 'bash', { status: 'error', input: {}, error: 'boom', time: { start: 0 } }),
    )
    expect(block).toMatchObject({
      type: 'tool_use',
      id: 'call_2',
      result: { content: 'boom', isError: true },
    })
  })

  it('leaves a running tool with no result yet (back-filled later)', () => {
    const block = partToBlock(
      toolPart('call_3', 'bash', { status: 'running', input: { cmd: 'x' } }),
    )
    expect(block).toMatchObject({ type: 'tool_use', id: 'call_3' })
    expect((block as { result?: unknown }).result).toBeUndefined()
  })
})

describe('messageToCanonical', () => {
  it('assembles a canonical message from a stored info+parts row', () => {
    const info = { id: 'm', sessionID: 'ses', role: 'assistant', time: { created: 123 } } as Message
    const msg = messageToCanonical(info, [textPart('p1', 'hi')])
    expect(msg).toMatchObject({
      vendor: 'opencode',
      sessionId: 'ses',
      role: 'assistant',
      ts: 123,
      blocks: [{ type: 'text', text: 'hi', id: 'p1' }],
    })
  })
})

describe('OpencodeStreamTranslator', () => {
  it('stamps the recorded message role onto a translated part', () => {
    const t = new OpencodeStreamTranslator()
    t.noteMessage({ id: 'm', sessionID: 'ses', role: 'user', time: { created: 0 } } as Message)
    const msg = t.translatePart(textPart('p1', 'hey'), 'ses', 999)
    expect(msg).toMatchObject({ role: 'user', sessionId: 'ses', ts: 999 })
  })

  it('defaults an unknown message role to assistant', () => {
    const t = new OpencodeStreamTranslator()
    const msg = t.translatePart(textPart('p1', 'hey'), 'ses', 1)
    expect(msg?.role).toBe('assistant')
  })
})
