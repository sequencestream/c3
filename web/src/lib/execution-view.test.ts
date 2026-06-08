import { describe, it, expect } from 'vitest'
import type { TranscriptItem } from '@ccc/shared/protocol'
import { transcriptItemToChat, transcriptToChat } from './execution-view'
import type { ChatBody, ChatMsg } from './chat-types'

describe('transcriptItemToChat', () => {
  it('maps user kind', () => {
    const item: TranscriptItem = { kind: 'user', text: 'hello' }
    const result = transcriptItemToChat(item)
    expect(result).toEqual<ChatBody>({ kind: 'user', text: 'hello' })
  })

  it('maps assistant kind', () => {
    const item: TranscriptItem = { kind: 'assistant', text: 'Hi there!' }
    const result = transcriptItemToChat(item)
    expect(result).toEqual<ChatBody>({ kind: 'assistant', text: 'Hi there!' })
  })

  it('maps tool_use kind', () => {
    const item: TranscriptItem = {
      kind: 'tool_use',
      toolUseId: 'tu1',
      toolName: 'bash',
      input: { command: 'ls -la' },
    }
    const result = transcriptItemToChat(item)
    expect(result).toEqual<ChatBody>({
      kind: 'tool-use',
      toolUseId: 'tu1',
      toolName: 'bash',
      input: { command: 'ls -la' },
    })
  })

  it('maps tool_result kind', () => {
    const item: TranscriptItem = {
      kind: 'tool_result',
      toolUseId: 'tu1',
      content: 'file1.txt\nfile2.txt',
      isError: false,
    }
    const result = transcriptItemToChat(item)
    expect(result).toEqual<ChatBody>({
      kind: 'tool-result',
      toolUseId: 'tu1',
      content: 'file1.txt\nfile2.txt',
      isError: false,
    })
  })

  it('maps tool_result with error flag', () => {
    const item: TranscriptItem = {
      kind: 'tool_result',
      toolUseId: 'tu2',
      content: 'command not found',
      isError: true,
    }
    const result = transcriptItemToChat(item)
    expect(result).toEqual<ChatBody>({
      kind: 'tool-result',
      toolUseId: 'tu2',
      content: 'command not found',
      isError: true,
    })
  })

  it('maps notice kind to system', () => {
    const item: TranscriptItem = {
      kind: 'notice',
      text: '— No response this turn (the model only thought) —',
    }
    const result = transcriptItemToChat(item)
    expect(result).toEqual<ChatBody>({
      kind: 'system',
      text: '— No response this turn (the model only thought) —',
    })
  })
})

describe('transcriptToChat', () => {
  it('maps multiple items with auto-incrementing ids', () => {
    const items: TranscriptItem[] = [
      { kind: 'user', text: 'hello' },
      { kind: 'assistant', text: 'world' },
      { kind: 'tool_use', toolUseId: 't1', toolName: 'read', input: { path: '/tmp' } },
      { kind: 'tool_result', toolUseId: 't1', content: 'done', isError: false },
    ]
    const result = transcriptToChat(items)
    expect(result).toHaveLength(4)
    expect(result[0]).toEqual<ChatMsg>({ kind: 'user', text: 'hello', id: 0 })
    expect(result[1]).toEqual<ChatMsg>({ kind: 'assistant', text: 'world', id: 1 })
    expect(result[2]).toEqual<ChatMsg>({
      kind: 'tool-use',
      toolUseId: 't1',
      toolName: 'read',
      input: { path: '/tmp' },
      id: 2,
    })
    expect(result[3]).toEqual<ChatMsg>({
      kind: 'tool-result',
      toolUseId: 't1',
      content: 'done',
      isError: false,
      id: 3,
    })
  })

  it('returns empty array for null', () => {
    expect(transcriptToChat(null)).toEqual([])
  })

  it('returns empty array for undefined', () => {
    expect(transcriptToChat(undefined)).toEqual([])
  })

  it('returns empty array for empty input', () => {
    expect(transcriptToChat([])).toEqual([])
  })
})
