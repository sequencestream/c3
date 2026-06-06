/**
 * Codex driver + approval tests (2026-06-06-005). The SDK boundary is injected, so
 * a scripted event stream drives the driver with no Codex auth/binary (Phase 0 ran
 * L1-only). Covers: stream → canonical translation, sessionId resolution from
 * `thread.started`, resume via `resumeThread`, whole-turn abort + failure, the
 * neutral gate → sandbox/policy mapping, the structural preApproved stamp, and the
 * no-op approval bridge (no per-tool point exists — 008 NO-GO).
 */
import { describe, it, expect, vi } from 'vitest'
import type { ThreadEvent, ThreadOptions } from '@openai/codex-sdk'
import type { CanonicalMessage, DriverStartOptions } from '../types.js'
import { CodexDriver, gateToCodexPolicy, type CodexClient, type CodexThread } from './driver.js'
import { CodexApprovalBridge } from './approval.js'
import { createCodexAdapter } from './index.js'

/** An async generator over a fixed script of events. */
async function* scriptEvents(events: ThreadEvent[]): AsyncGenerator<ThreadEvent> {
  for (const ev of events) yield ev
}

/** A fake Codex client that records its launch options and replays a scripted stream. */
function fakeCodex(events: ThreadEvent[], threadId = 'thread_x') {
  const calls: { kind: 'start' | 'resume'; id?: string; options?: ThreadOptions }[] = []
  const thread: CodexThread = {
    id: threadId,
    runStreamed: async () => ({ events: scriptEvents(events) }),
  }
  const client: CodexClient = {
    startThread: (options) => {
      calls.push({ kind: 'start', options })
      return thread
    },
    resumeThread: (id, options) => {
      calls.push({ kind: 'resume', id, options })
      return thread
    },
  }
  return { client, calls }
}

function startOpts(over: Partial<DriverStartOptions> = {}): DriverStartOptions {
  return {
    prompt: 'do the thing',
    cwd: '/work',
    signal: new AbortController().signal,
    actionMode: 'build',
    toolGate: 'on-sensitive',
    ...over,
  }
}

async function collect(stream: AsyncIterable<CanonicalMessage>): Promise<CanonicalMessage[]> {
  const out: CanonicalMessage[] = []
  for await (const m of stream) out.push(m)
  return out
}

describe('CodexDriver', () => {
  it('translates a scripted event stream into canonical messages', async () => {
    const { client } = fakeCodex([
      { type: 'thread.started', thread_id: 'thread_1' },
      { type: 'turn.started' },
      { type: 'item.completed', item: { id: 'i1', type: 'agent_message', text: 'hi there' } },
      { type: 'turn.completed', usage: {} as never },
    ])
    const driver = new CodexDriver(() => client)
    const run = await driver.start(startOpts())

    const msgs = await collect(run.messages())
    expect(msgs).toHaveLength(1)
    expect(msgs[0]).toMatchObject({
      vendor: 'codex',
      sessionId: 'thread_1',
      role: 'assistant',
      blocks: [{ type: 'text', text: 'hi there', id: 'i1' }],
    })
  })

  it('resolves sessionId from thread.started', async () => {
    const { client } = fakeCodex([{ type: 'thread.started', thread_id: 'thread_42' }])
    const driver = new CodexDriver(() => client)
    const run = await driver.start(startOpts())
    expect(await run.sessionId()).toBe('thread_42')
  })

  it('uses resumeThread and resolves sessionId to the resumed id', async () => {
    const { client, calls } = fakeCodex([
      { type: 'item.completed', item: { id: 'i1', type: 'agent_message', text: 'resumed' } },
    ])
    const driver = new CodexDriver(() => client)
    const run = await driver.start(startOpts({ resume: 'thread_old' }))

    expect(await run.sessionId()).toBe('thread_old')
    await collect(run.messages())
    expect(calls[0]).toMatchObject({ kind: 'resume', id: 'thread_old' })
  })

  it('stamps preApproved on tool items (launch-time gate auto-allow)', async () => {
    const { client } = fakeCodex([
      { type: 'thread.started', thread_id: 't' },
      {
        type: 'item.completed',
        item: {
          id: 'c1',
          type: 'command_execution',
          command: 'ls',
          aggregated_output: 'x',
          exit_code: 0,
          status: 'completed',
        },
      },
    ])
    const driver = new CodexDriver(() => client)
    const msgs = await collect((await driver.start(startOpts())).messages())
    expect(msgs).toHaveLength(1)
    expect(msgs[0].preApproved).toBe(true)
    expect(msgs[0].blocks[0]).toMatchObject({ type: 'tool_use', name: 'shell' })
  })

  it('propagates a turn.failed as a thrown error on the stream', async () => {
    const { client } = fakeCodex([
      { type: 'thread.started', thread_id: 't' },
      { type: 'turn.failed', error: { message: 'model exploded' } },
    ])
    const driver = new CodexDriver(() => client)
    const run = await driver.start(startOpts())
    await expect(collect(run.messages())).rejects.toThrow('model exploded')
  })

  it('abort stops the run and resolves sessionId without hanging', async () => {
    const controller = new AbortController()
    const { client } = fakeCodex([{ type: 'thread.started', thread_id: 't' }])
    const driver = new CodexDriver(() => client)
    const run = await driver.start(startOpts({ signal: controller.signal }))
    run.abort()
    // messages() ends (closed) and sessionId() still resolves.
    await collect(run.messages())
    expect(await run.sessionId()).toBeDefined()
  })

  it('passes the gate-derived sandbox/approval policy to startThread', async () => {
    const { client, calls } = fakeCodex([{ type: 'thread.started', thread_id: 't' }])
    const driver = new CodexDriver(() => client)
    await driver.start(startOpts({ actionMode: 'plan', toolGate: 'always-ask' }))
    expect(calls[0].options).toMatchObject({
      sandboxMode: 'read-only',
      approvalPolicy: 'on-request',
      workingDirectory: '/work',
      skipGitRepoCheck: true,
    })
  })
})

describe('gateToCodexPolicy', () => {
  it('plan ⇒ read-only regardless of gate', () => {
    expect(gateToCodexPolicy('plan', 'never-ask')).toEqual({
      sandboxMode: 'read-only',
      approvalPolicy: 'on-request',
    })
  })

  it('build + never-ask ⇒ workspace-write + never', () => {
    expect(gateToCodexPolicy('build', 'never-ask')).toEqual({
      sandboxMode: 'workspace-write',
      approvalPolicy: 'never',
    })
  })

  it('build + always-ask degrades to a read-only sandbox (Codex cannot ask live)', () => {
    expect(gateToCodexPolicy('build', 'always-ask')).toEqual({
      sandboxMode: 'read-only',
      approvalPolicy: 'on-request',
    })
  })

  it('build + trusted-prefix ⇒ workspace-write + on-failure', () => {
    expect(gateToCodexPolicy('build', 'trusted-prefix')).toEqual({
      sandboxMode: 'workspace-write',
      approvalPolicy: 'on-failure',
    })
  })
})

describe('CodexApprovalBridge', () => {
  it('onRequest registers a handler and returns a working disposer (contract)', () => {
    const bridge = new CodexApprovalBridge()
    const handler = vi.fn()
    const dispose = bridge.onRequest(handler)
    expect(typeof dispose).toBe('function')
    dispose()
    // The handler is never invoked — there is no per-tool approval event in Codex.
    expect(handler).not.toHaveBeenCalled()
  })

  it('the MCP-approval fallback is OFF by default (Phase 0 §4 skeleton)', () => {
    expect(new CodexApprovalBridge().mcpFallback).toBe(false)
    expect(new CodexApprovalBridge({ mcpFallback: true }).mcpFallback).toBe(true)
  })
})

describe('createCodexAdapter', () => {
  it('assembles a codex adapter with the all-false ledger and empty session store', async () => {
    const adapter = createCodexAdapter()
    expect(adapter.vendor).toBe('codex')
    expect(adapter.capabilities.perToolApproval).toBe(false)
    expect(await adapter.sessions.list({ cwd: '/work' })).toEqual([])
    expect(await adapter.sessions.read('thread_1', { cwd: '/work' })).toEqual([])
  })
})
