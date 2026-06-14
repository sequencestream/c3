/**
 * WireEmitter (2026-06-06-003) — the canonical(upsert) → wire(claude-incremental)
 * diff that lets the existing web console render an OpenCode turn. Text emits only
 * new suffixes; a tool_use emits once, its result once, no duplicates on re-emit.
 */
import { describe, expect, it, vi } from 'vitest'
import type { ServerToClient } from '@ccc/shared/protocol'
import type { CanonicalBlock, CanonicalMessage } from '../agent/adapters/types.js'
import { WireEmitter, makeDriverApprovalHandler } from './run-via-driver.js'

function frame(blocks: CanonicalBlock[], extra?: Partial<CanonicalMessage>): CanonicalMessage {
  return { vendor: 'opencode', sessionId: 's', role: 'assistant', blocks, ts: 0, ...extra }
}

describe('WireEmitter', () => {
  it('emits only the new suffix of a growing text block', () => {
    const out: ServerToClient[] = []
    const e = new WireEmitter((m) => out.push(m))
    e.consume(frame([{ type: 'text', text: 'Hel', id: 't1' }]))
    e.consume(frame([{ type: 'text', text: 'Hello', id: 't1' }]))
    expect(out).toEqual([
      { type: 'assistant_text', text: 'Hel' },
      { type: 'assistant_text', text: 'lo' },
    ])
  })

  it('emits a tool_use once and its result once, ignoring re-emits', () => {
    const out: ServerToClient[] = []
    const e = new WireEmitter((m) => out.push(m))
    const running: CanonicalBlock = {
      type: 'tool_use',
      id: 'c1',
      name: 'bash',
      input: { cmd: 'ls' },
    }
    const done: CanonicalBlock = {
      type: 'tool_use',
      id: 'c1',
      name: 'bash',
      input: { cmd: 'ls' },
      result: { content: 'ok', isError: false },
    }
    e.consume(frame([running]))
    e.consume(frame([done]))
    e.consume(frame([done])) // idempotent re-emit

    expect(out).toEqual([
      { type: 'tool_use', toolUseId: 'c1', toolName: 'bash', input: { cmd: 'ls' } },
      { type: 'tool_result', toolUseId: 'c1', content: 'ok', isError: false },
    ])
  })

  it('carries a message-level preApproved marker onto the first tool_use frame', () => {
    const out: ServerToClient[] = []
    const e = new WireEmitter((m) => out.push(m))
    const tool: CanonicalBlock = { type: 'tool_use', id: 'c1', name: 'bash', input: { cmd: 'ls' } }
    e.consume(frame([tool], { preApproved: true }))
    expect(out).toEqual([
      {
        type: 'tool_use',
        toolUseId: 'c1',
        toolName: 'bash',
        input: { cmd: 'ls' },
        preApproved: true,
      },
    ])
  })

  it('omits preApproved on a gated (non-pre-approved) tool_use', () => {
    const out: ServerToClient[] = []
    const e = new WireEmitter((m) => out.push(m))
    const tool: CanonicalBlock = { type: 'tool_use', id: 'c1', name: 'bash', input: { cmd: 'ls' } }
    e.consume(frame([tool]))
    expect(out).toEqual([
      { type: 'tool_use', toolUseId: 'c1', toolName: 'bash', input: { cmd: 'ls' } },
    ])
    expect(out[0]).not.toHaveProperty('preApproved')
  })
})

describe('makeDriverApprovalHandler — WorkCenter event registration', () => {
  function deps(over: Partial<Parameters<typeof makeDriverApprovalHandler>[0]> = {}) {
    return {
      getRunId: () => 'run-1',
      workspacePath: '/proj',
      source: 'session' as const,
      signal: new AbortController().signal,
      emit: vi.fn(),
      waitForDecision: vi.fn(async () => ({ decision: 'allow' as const })),
      onPermissionRequest: vi.fn(),
      ...over,
    }
  }

  it('registers the event BEFORE the wire frame, with the runtime source + live run id', async () => {
    const order: string[] = []
    const d = deps({
      source: 'intent',
      getRunId: () => 'run-9',
      workspacePath: '/w',
      emit: vi.fn(() => order.push('emit')),
      onPermissionRequest: vi.fn(() => order.push('hook')),
    })
    const handler = makeDriverApprovalHandler(d)
    const decision = await handler({
      requestId: 'r1',
      toolName: 'Write',
      input: { file_path: '/x' },
    })

    expect(d.onPermissionRequest).toHaveBeenCalledWith({
      requestId: 'r1',
      toolName: 'Write',
      input: { file_path: '/x' },
      sessionId: 'run-9',
      workspacePath: '/w',
      source: 'intent',
    })
    expect(order).toEqual(['hook', 'emit'])
    expect(d.emit).toHaveBeenCalledWith('run-9', {
      type: 'permission_request',
      requestId: 'r1',
      toolName: 'Write',
      input: { file_path: '/x' },
    })
    expect(decision).toEqual({ behavior: 'allow' })
  })

  it('tags an interaction tool frame with isUserInteraction', async () => {
    const d = deps()
    const handler = makeDriverApprovalHandler(d)
    await handler({ requestId: 'r2', toolName: 'AskUserQuestion', input: {} })
    expect(d.emit).toHaveBeenCalledWith('run-1', {
      type: 'permission_request',
      requestId: 'r2',
      toolName: 'AskUserQuestion',
      input: {},
      isUserInteraction: true,
    })
  })

  it('maps a deny decision to a default-deny ApprovalDecision', async () => {
    const d = deps({ waitForDecision: vi.fn(async () => ({ decision: 'deny' as const })) })
    const handler = makeDriverApprovalHandler(d)
    const decision = await handler({ requestId: 'r3', toolName: 'Bash', input: {} })
    expect(decision).toEqual({ behavior: 'deny', reason: 'User denied in c3 UI' })
  })

  it('is a no-op-safe registration when onPermissionRequest is absent', async () => {
    const d = deps({ onPermissionRequest: undefined })
    const handler = makeDriverApprovalHandler(d)
    const decision = await handler({ requestId: 'r4', toolName: 'Read', input: {} })
    expect(decision).toEqual({ behavior: 'allow' })
    expect(d.emit).toHaveBeenCalledTimes(1)
  })
})
