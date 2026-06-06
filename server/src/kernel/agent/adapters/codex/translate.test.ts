/**
 * Codex translation tests (2026-06-06-005) — item → canonical block keying and the
 * structural preApproved stamp (every Codex tool is auto-allowed by the launch-time
 * gate; there is no c3 approval point, 008 NO-GO).
 */
import { describe, it, expect } from 'vitest'
import type { ThreadItem } from '@openai/codex-sdk'
import { itemToBlock, itemToCanonical } from './translate.js'

describe('itemToBlock', () => {
  it('maps an agent_message to a text block keyed by item id', () => {
    const item: ThreadItem = { id: 'i1', type: 'agent_message', text: 'hello' }
    expect(itemToBlock(item)).toEqual({ type: 'text', text: 'hello', id: 'i1' })
  })

  it('maps a reasoning item to a thinking block', () => {
    const item: ThreadItem = { id: 'i2', type: 'reasoning', text: 'pondering' }
    expect(itemToBlock(item)).toEqual({ type: 'thinking', thinking: 'pondering', id: 'i2' })
  })

  it('maps a completed command_execution to tool_use with embedded result', () => {
    const item: ThreadItem = {
      id: 'c1',
      type: 'command_execution',
      command: 'ls -la',
      aggregated_output: 'file.txt',
      exit_code: 0,
      status: 'completed',
    }
    expect(itemToBlock(item)).toMatchObject({
      type: 'tool_use',
      id: 'c1',
      name: 'shell',
      input: { command: 'ls -la' },
      result: { content: 'file.txt', isError: false },
    })
  })

  it('leaves a running command_execution with no result yet (back-filled later)', () => {
    const item: ThreadItem = {
      id: 'c2',
      type: 'command_execution',
      command: 'sleep 1',
      aggregated_output: '',
      status: 'in_progress',
    }
    const block = itemToBlock(item)
    expect(block).toMatchObject({ type: 'tool_use', id: 'c2', name: 'shell' })
    expect((block as { result?: unknown }).result).toBeUndefined()
  })

  it('marks a failed command_execution result as an error', () => {
    const item: ThreadItem = {
      id: 'c3',
      type: 'command_execution',
      command: 'false',
      aggregated_output: 'boom',
      exit_code: 1,
      status: 'failed',
    }
    expect(itemToBlock(item)).toMatchObject({
      type: 'tool_use',
      result: { content: 'boom', isError: true, vendorExtra: { exitCode: 1, status: 'failed' } },
    })
  })

  it('maps a file_change to an apply_patch tool_use with a change summary', () => {
    const item: ThreadItem = {
      id: 'f1',
      type: 'file_change',
      changes: [
        { path: 'a.ts', kind: 'update' },
        { path: 'b.ts', kind: 'add' },
      ],
      status: 'completed',
    }
    expect(itemToBlock(item)).toMatchObject({
      type: 'tool_use',
      id: 'f1',
      name: 'apply_patch',
      result: { content: 'update a.ts\nadd b.ts', isError: false },
    })
  })

  it('maps an mcp_tool_call, flattening text content into the result', () => {
    const item: ThreadItem = {
      id: 'm1',
      type: 'mcp_tool_call',
      server: 'srv',
      tool: 'fetch',
      arguments: { url: 'x' },
      result: { content: [{ type: 'text', text: 'ok' }], structured_content: null },
      status: 'completed',
    } as ThreadItem
    expect(itemToBlock(item)).toMatchObject({
      type: 'tool_use',
      id: 'm1',
      name: 'srv/fetch',
      input: { url: 'x' },
      result: { content: 'ok', isError: false },
    })
  })

  it('surfaces a non-fatal error item as a text block', () => {
    const item: ThreadItem = { id: 'e1', type: 'error', message: 'rate limited' }
    expect(itemToBlock(item)).toMatchObject({ type: 'text', text: 'rate limited', id: 'e1' })
  })

  it('returns null for a todo_list (no canonical analogue)', () => {
    const item: ThreadItem = {
      id: 't1',
      type: 'todo_list',
      items: [{ text: 'do x', completed: false }],
    }
    expect(itemToBlock(item)).toBeNull()
  })
})

describe('itemToCanonical preApproved stamping', () => {
  it('stamps preApproved on a tool item (Codex auto-allows via launch-time gate)', () => {
    const item: ThreadItem = {
      id: 'c1',
      type: 'command_execution',
      command: 'ls',
      aggregated_output: '',
      status: 'in_progress',
    }
    const msg = itemToCanonical(item, 'thread_1', 123)
    expect(msg).toMatchObject({
      vendor: 'codex',
      sessionId: 'thread_1',
      role: 'assistant',
      ts: 123,
    })
    expect(msg?.preApproved).toBe(true)
  })

  it('does NOT stamp preApproved on a plain text message', () => {
    const item: ThreadItem = { id: 'i1', type: 'agent_message', text: 'hi' }
    const msg = itemToCanonical(item, 'thread_1', 1)
    expect(msg?.preApproved).toBeUndefined()
  })

  it('returns null when the item has no canonical block', () => {
    const item: ThreadItem = { id: 't1', type: 'todo_list', items: [] }
    expect(itemToCanonical(item, 'thread_1', 1)).toBeNull()
  })
})
