/**
 * Unit coverage for the automation viewer stream: the PURE Claude SDK → wire
 * translator, and the pre-session-id buffer that flushes on `bind()`.
 */
import { describe, it, expect, afterEach } from 'vitest'
import type { ServerToClient } from '@ccc/shared/protocol'
import { translateClaudeSdkMessage, AutomationViewerStream } from './viewer-stream.js'
import { addViewer, ensureRuntime, getRuntime, removeRuntime, setStatus } from '../../runs.js'

describe('translateClaudeSdkMessage', () => {
  it('translates an assistant text block to assistant_text', () => {
    const out = translateClaudeSdkMessage({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'hi' }] },
    })
    expect(out).toEqual([{ type: 'assistant_text', text: 'hi' }])
  })

  it('translates an assistant tool_use block to tool_use', () => {
    const out = translateClaudeSdkMessage({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { cmd: 'ls' } }] },
    })
    expect(out).toEqual([
      { type: 'tool_use', toolUseId: 't1', toolName: 'Bash', input: { cmd: 'ls' } },
    ])
  })

  it('translates a user tool_result block to tool_result', () => {
    const out = translateClaudeSdkMessage({
      type: 'user',
      message: {
        content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok', is_error: false }],
      },
    })
    expect(out).toEqual([{ type: 'tool_result', toolUseId: 't1', content: 'ok', isError: false }])
  })

  it('translates a result message to a complete turn_end', () => {
    expect(translateClaudeSdkMessage({ type: 'result' })).toEqual([
      { type: 'turn_end', reason: 'complete' },
    ])
  })

  it('yields nothing for the system init frame', () => {
    expect(translateClaudeSdkMessage({ type: 'system', session_id: 's1' })).toEqual([])
  })

  it('splits a multi-block assistant message into one event per block', () => {
    const out = translateClaudeSdkMessage({
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'thinking' },
          { type: 'tool_use', id: 't2', name: 'Read', input: {} },
        ],
      },
    })
    expect(out.map((e) => e.type)).toEqual(['assistant_text', 'tool_use'])
  })
})

const SID = 'viewer-stream-session'

afterEach(() => {
  removeRuntime(SID)
})

describe('AutomationViewerStream', () => {
  it('buffers pre-session-id events and flushes them on bind', () => {
    const received: ServerToClient[] = []
    const stream = new AutomationViewerStream((sid) => {
      ensureRuntime(sid, '/ws', 'default', [], 'automation', undefined, 'background')
      addViewer(sid, (e) => received.push(e))
      setStatus(sid, 'running')
    })

    // Produced BEFORE the session id is known — parked in the buffer.
    expect(stream.bound).toBe(false)
    stream.push({ type: 'assistant_text', text: 'before' })
    stream.pushAll([{ type: 'tool_use', toolUseId: 't1', toolName: 'Read', input: {} }])
    expect(received).toHaveLength(0)

    // Binding registers the runtime and flushes the buffered events in order.
    stream.bind(SID)
    expect(stream.bound).toBe(true)
    expect(received.map((e) => e.type)).toEqual(['assistant_text', 'tool_use'])

    // After binding, events go straight through to the viewer.
    stream.push({ type: 'turn_end', reason: 'complete' })
    expect(received.map((e) => e.type)).toEqual(['assistant_text', 'tool_use', 'turn_end'])

    // The runtime buffer records the full ordered stream for later replay.
    expect(getRuntime(SID)?.buffer.map((e) => e.type)).toEqual([
      'assistant_text',
      'tool_use',
      'turn_end',
    ])
  })

  it('bind is idempotent', () => {
    let registrations = 0
    const stream = new AutomationViewerStream((sid) => {
      registrations++
      ensureRuntime(sid, '/ws', 'default', [], 'automation', undefined, 'background')
    })
    stream.bind(SID)
    stream.bind(SID)
    expect(registrations).toBe(1)
  })
})
