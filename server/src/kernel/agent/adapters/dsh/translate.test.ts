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
    expect(out.messages[0].blocks[0]).toEqual({ type: 'text', text: 'hello' })
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
    expect(block.type).toBe('tool_use')
    if (block.type === 'tool_use') {
      expect(block.name).toBe('write')
      expect(block.result?.content).toBe('ok')
    }
  })

  it('signals turn/end', () => {
    const tr = new DshStreamTranslator()
    const out = tr.translateSessionEvent({
      type: 'turn/end',
      data: { reason: { kind: 'completed' } },
    })
    expect(out.ended?.isError).toBe(false)
  })
})
