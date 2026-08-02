/**
 * CursorDriver tests. A fake SDK stands in for `@cursor/sdk`'s local runtime, so
 * the driver's real create/resume → send → stream → settle path runs without a
 * network hop, an API key, or model tokens.
 */
import { describe, expect, it } from 'vitest'
import type { CanonicalMessage, DriverStartOptions } from '../types.js'
import {
  CursorDriver,
  type CursorAgentHandle,
  type CursorRunHandle,
  type CursorSdk,
} from './driver.js'
import {
  CursorUnsupportedError,
  cursorAgentOptions,
  cursorSendOptions,
  cursorUserMessage,
  resolveCursorApiKey,
} from './launch.js'

function startOpts(over: Partial<DriverStartOptions> = {}): DriverStartOptions {
  return {
    prompt: 'do the thing',
    cwd: '/ws',
    signal: new AbortController().signal,
    actionMode: 'build',
    toolGate: 'on-sensitive',
    envOverrides: { CURSOR_API_KEY: 'test-key' },
    ...over,
  }
}

async function collect(stream: AsyncIterable<CanonicalMessage>): Promise<CanonicalMessage[]> {
  const out: CanonicalMessage[] = []
  for await (const m of stream) out.push(m)
  return out
}

/** What one scripted turn does: the frames it yields and how it settles. */
interface FakeTurn {
  events: unknown[]
  result?: { status: string; error?: { message: string } }
  /** Never-settling stream, for the abort test. */
  hang?: boolean
}

interface FakeSdkCalls {
  created: unknown[]
  resumed: Array<{ agentId: string; options: unknown }>
  sent: Array<{ message: unknown; options: unknown }>
  cancelled: number
  closed: number
}

function fakeSdk(turn: FakeTurn, agentId = 'agent-1'): { sdk: CursorSdk; calls: FakeSdkCalls } {
  const calls: FakeSdkCalls = { created: [], resumed: [], sent: [], cancelled: 0, closed: 0 }

  const makeRun = (): CursorRunHandle => {
    let cancel: () => void = () => undefined
    const cancelled = new Promise<void>((resolve) => {
      cancel = resolve
    })
    return {
      async *stream() {
        for (const event of turn.events) yield event
        if (turn.hang) await cancelled
      },
      wait: async () => turn.result ?? { status: 'finished' },
      cancel: async () => {
        calls.cancelled += 1
        cancel()
      },
    }
  }

  const agent: CursorAgentHandle = {
    agentId,
    send: async (message, options) => {
      calls.sent.push({ message, options })
      return makeRun()
    },
    close: () => {
      calls.closed += 1
    },
  }

  return {
    calls,
    sdk: {
      create: async (options) => {
        calls.created.push(options)
        return agent
      },
      resume: async (id, options) => {
        calls.resumed.push({ agentId: id, options })
        return agent
      },
    },
  }
}

const driverFor = (sdk: CursorSdk) => new CursorDriver(() => ({}), sdk)

describe('CursorDriver', () => {
  it('reports the SDK-minted agent id and streams canonical messages', async () => {
    const { sdk } = fakeSdk({
      events: [
        { type: 'system', subtype: 'init', agent_id: 'agent-1', run_id: 'run-1' },
        {
          type: 'assistant',
          agent_id: 'agent-1',
          run_id: 'run-1',
          message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
        },
        { type: 'status', agent_id: 'agent-1', run_id: 'run-1', status: 'FINISHED' },
      ],
    })
    const run = await driverFor(sdk).start(startOpts())
    expect(await run.sessionId()).toBe('agent-1')
    const msgs = await collect(run.messages())
    expect(msgs.some((m) => m.blocks.some((b) => b.type === 'text' && b.text === 'hello'))).toBe(
      true,
    )
  })

  it('accumulates text deltas cumulatively under one block id', async () => {
    const delta = (text: string) => ({
      type: 'assistant',
      agent_id: 'agent-1',
      run_id: 'run-1',
      message: { role: 'assistant', content: [{ type: 'text', text }] },
    })
    const { sdk } = fakeSdk({ events: [delta('one '), delta('two')] })
    const run = await driverFor(sdk).start(startOpts())
    const texts = (await collect(run.messages()))
      .flatMap((m) => m.blocks)
      .filter((b) => b.type === 'text')
    // The wire consumer diffs by suffix, so the second frame must carry the whole span.
    expect(texts.map((b) => (b.type === 'text' ? b.text : ''))).toEqual(['one ', 'one two'])
    expect(new Set(texts.map((b) => b.id)).size).toBe(1)
  })

  it('resumes by agent id instead of creating a new agent', async () => {
    const { sdk, calls } = fakeSdk({ events: [] }, 'agent-resumed')
    const run = await driverFor(sdk).start(startOpts({ resume: 'agent-resumed' }))
    expect(await run.sessionId()).toBe('agent-resumed')
    await collect(run.messages())
    expect(calls.created).toHaveLength(0)
    expect(calls.resumed[0]?.agentId).toBe('agent-resumed')
  })

  it('fails the turn when the run settles as an error', async () => {
    const { sdk } = fakeSdk({
      events: [],
      result: { status: 'error', error: { message: 'Invalid User API Key' } },
    })
    const run = await driverFor(sdk).start(startOpts())
    await expect(collect(run.messages())).rejects.toThrow(/Invalid User API Key/)
  })

  it('abort() cancels the live run and settles it without failing', async () => {
    const { sdk, calls } = fakeSdk({ events: [], hang: true })
    const run = await driverFor(sdk).start(startOpts())
    const done = collect(run.messages())
    run.abort()
    await expect(done).resolves.toBeInstanceOf(Array)
    expect(calls.cancelled).toBe(1)
  })

  it('closes the agent handle when the turn settles', async () => {
    const { sdk, calls } = fakeSdk({ events: [] })
    const run = await driverFor(sdk).start(startOpts())
    await collect(run.messages())
    expect(calls.closed).toBe(1)
  })

  it('reports a rejected key in the operator’s terms, not as a bare HTTP 401', async () => {
    // `Agent.create` validates the credential over the network before returning,
    // so a bad key arrives here as an auth error naming an SDK endpoint.
    const unauthorized = Object.assign(new Error('GET /v1/models failed'), { status: 401 })
    const sdk: CursorSdk = {
      create: async () => {
        throw unauthorized
      },
      resume: async () => {
        throw unauthorized
      },
    }
    await expect(driverFor(sdk).start(startOpts())).rejects.toThrow(/API key was rejected/)
  })

  it('refuses to start without an API key rather than burning a turn', async () => {
    const { sdk } = fakeSdk({ events: [] })
    const priorKey = process.env.CURSOR_API_KEY
    delete process.env.CURSOR_API_KEY
    try {
      await expect(
        driverFor(sdk).start(startOpts({ envOverrides: undefined })),
      ).rejects.toBeInstanceOf(CursorUnsupportedError)
    } finally {
      if (priorKey !== undefined) process.env.CURSOR_API_KEY = priorKey
    }
  })
})

describe('cursor launch shaping', () => {
  it('maps the never-ask gate to Auto-review off, and every other gate to on', () => {
    expect(cursorAgentOptions(startOpts({ toolGate: 'never-ask' }), {}).local.autoReview).toBe(
      false,
    )
    expect(cursorAgentOptions(startOpts(), {}).local.autoReview).toBe(true)
  })

  it('maps the plan action mode to the SDK plan conversation mode', () => {
    expect(cursorAgentOptions(startOpts({ actionMode: 'plan' }), {}).mode).toBe('plan')
    expect(cursorSendOptions(startOpts({ actionMode: 'plan' })).mode).toBe('plan')
    expect(cursorAgentOptions(startOpts(), {}).mode).toBe('agent')
  })

  it('enables the SDK sandbox for a sandboxed run', () => {
    expect(cursorAgentOptions(startOpts({ sandboxed: true }), {}).local.sandboxOptions).toEqual({
      enabled: true,
    })
    expect(cursorAgentOptions(startOpts(), {}).local.sandboxOptions).toBeUndefined()
  })

  it('carries additional directories as extra workspace roots', () => {
    const options = cursorAgentOptions(startOpts({ additionalDirectories: ['/specs'] }), {})
    expect(options.local.cwd).toEqual(['/ws', '/specs'])
  })

  it('translates remote MCP descriptors into http server configs', () => {
    const options = cursorAgentOptions(
      startOpts({ mcpServers: { c3: { type: 'http', url: 'http://127.0.0.1:1/mcp' } } }),
      {},
    )
    expect(options.mcpServers?.c3).toEqual({ type: 'http', url: 'http://127.0.0.1:1/mcp' })
  })

  it('prefixes the system instruction onto the user turn (cursor has no system channel)', () => {
    const message = cursorUserMessage(startOpts({ systemInstruction: 'be terse' }))
    expect(message.text).toBe('be terse\n\ndo the thing')
  })

  it('prefers the configured key over the run env and the ambient variable', () => {
    expect(resolveCursorApiKey({ apiKey: 'from-config' }, { CURSOR_API_KEY: 'from-run' })).toBe(
      'from-config',
    )
    expect(resolveCursorApiKey({}, { CURSOR_API_KEY: 'from-run' })).toBe('from-run')
  })
})
