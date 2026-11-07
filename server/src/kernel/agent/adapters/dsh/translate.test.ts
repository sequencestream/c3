import { describe, expect, it } from 'vitest'
import { DshStreamTranslator } from './translate.js'

describe('DshStreamTranslator', () => {
  it('maps assistant/message text blocks', () => {
    const tr = new DshStreamTranslator()
    tr.setSessionId('s1')
    const out = tr.translateSessionEvent({
      type: 'assistant/message',
      data: {
        message: { content: [{ type: 'text', text: 'hello' }] },
      },
    })
    expect(out.messages).toHaveLength(1)
    expect(out.messages[0].blocks[0]).toMatchObject({ type: 'text', text: 'hello' })
  })

  it('gives every assistant message its own text span id', () => {
    // The wire emitter forwards only the growth beyond what it already sent for
    // a given text id, so sharing one id across messages truncates everything
    // after the first. Ids therefore have to differ per event (and per block).
    const tr = new DshStreamTranslator()
    const textId = (envelope: Record<string, unknown>): unknown => {
      const out = tr.translateSessionEvent(envelope)
      return (out.messages[0].blocks[0] as { id?: unknown }).id
    }
    const message = (text: string): Record<string, unknown> => ({
      type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text }] } },
    })

    const withSeq = [
      textId({ ...message('one'), seq: 7 }),
      textId({ ...message('two'), seq: 9 }),
      textId({ ...message('three'), seq: 11 }),
    ]
    expect(withSeq).toEqual(['dsh-7-0', 'dsh-9-0', 'dsh-11-0'])

    const withoutSeq = [textId(message('a')), textId(message('b'))]
    expect(withoutSeq[0]).not.toBe(withoutSeq[1])
  })

  it('gives two text blocks inside one message distinct ids', () => {
    const tr = new DshStreamTranslator()
    const out = tr.translateSessionEvent({
      type: 'assistant/message',
      seq: 3,
      data: {
        message: {
          content: [
            { type: 'text', text: 'a' },
            { type: 'text', text: 'b' },
          ],
        },
      },
    })
    const ids = out.messages[0].blocks.map((b) => (b.type === 'text' ? b.id : undefined))
    expect(ids).toEqual(['dsh-3-0', 'dsh-3-1'])
  })

  it('folds tool/call and tool/result', () => {
    const tr = new DshStreamTranslator()
    tr.setSessionId('s1')
    tr.translateSessionEvent({
      type: 'tool/call',
      data: { callId: 'c1', name: 'write', arguments: '{"path":"a"}' },
    })
    const result = tr.translateSessionEvent({
      type: 'tool/result',
      data: {
        callId: 'c1',
        message: { content: [{ type: 'text', text: 'ok' }], isError: false },
      },
    })
    const block = result.messages[0].blocks[0]
    expect(block).toMatchObject({
      type: 'tool_use',
      id: 'c1',
      name: 'write',
      result: { content: 'ok', isError: false },
    })
  })

  it('pairs a tool/result by the tool message call id and keeps the call name', () => {
    const tr = new DshStreamTranslator()
    tr.setSessionId('s1')
    tr.translateSessionEvent({
      type: 'tool/call',
      data: { callId: 'call_00', name: 'read', arguments: '{"path":"a.ts"}' },
    })
    const result = tr.translateSessionEvent({
      type: 'tool/result',
      data: {
        turn: 1,
        step: 1,
        message: {
          role: 'tool',
          toolCallId: 'call_00',
          source: { kind: 'tool', callId: 'call_00' },
          isError: false,
          content: [{ type: 'text', text: 'file' }],
        },
      },
    })
    expect(result.messages[0].blocks[0]).toMatchObject({
      type: 'tool_use',
      id: 'call_00',
      name: 'read',
      input: { path: 'a.ts' },
      result: { content: 'file', isError: false },
    })
  })

  it('signals turn/end', () => {
    const tr = new DshStreamTranslator()
    const out = tr.translateSessionEvent({
      type: 'turn/end',
      data: { reason: { kind: 'completed' } },
    })
    expect(out.ended?.isError).toBe(false)
  })

  it('carries the provider failure text of an errored turn', () => {
    const tr = new DshStreamTranslator()
    const out = tr.translateSessionEvent({
      type: 'turn/end',
      data: {
        reason: {
          kind: 'error',
          error: { message: 'rate limited', code: 'RATE_LIMIT', status: 429 },
        },
      },
    })
    expect(out.ended).toEqual({ isError: true, errorMessage: 'rate limited' })
  })

  it('carries the cancel cause of an aborted turn', () => {
    const tr = new DshStreamTranslator()
    const aborted = (reason: unknown) =>
      tr.translateSessionEvent({ type: 'turn/end', data: { reason: { kind: 'aborted', reason } } })
        .ended

    expect(aborted('user')).toEqual({ isError: true, errorMessage: 'user' })
    // The legacy cancel cause is an object; fall back to the stable kind.
    expect(aborted({ kind: 'legacy' })).toEqual({ isError: true, errorMessage: 'aborted' })
  })

  it('exposes the recorded tool input for the approval channel', () => {
    const tr = new DshStreamTranslator()
    tr.translateSessionEvent({
      type: 'tool/call',
      data: { callId: 'c9', name: 'shell', arguments: '{"command":"ls"}' },
    })
    expect(tr.toolInput('c9')).toEqual({ command: 'ls' })
    expect(tr.toolInput('missing')).toBeUndefined()
  })
})
