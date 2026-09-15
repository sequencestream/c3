/**
 * The sampling executor, driven against scripted SSE upstreams with a fake clock —
 * no network, no real time, no credits spent.
 *
 * What is pinned: exactly N requests and never one more (no warm-up, no retry, no
 * top-up for a failure), never more than one in flight, a failure classified by
 * what actually went wrong rather than by guesswork, and an interrupt that leaves
 * naturally-completed samples intact while recording the aborted request as
 * `cancelled` — neither a failure nor a completion.
 */
import { describe, expect, it } from 'vitest'
import type { SpeedTestApiDialect } from '@ccc/shared/protocol'
import { SpeedTestExecution, type SpeedTestDeps, type SpeedTestPlan } from './runner.js'

/** One scripted step of a fake stream: advance the clock, then emit some bytes. */
interface Step {
  advanceMs: number
  text: string
}

interface Harness {
  deps: SpeedTestDeps
  /** Every URL dialed, in order. */
  urls: string[]
  /** Highest number of simultaneously open upstream calls observed. */
  maxInFlight: number
  clock: { value: number }
}

/** What the fake upstream does for one request. */
type Script =
  | { kind: 'stream'; steps: Step[] }
  | { kind: 'status'; status: number }
  | { kind: 'reject'; message: string }
  /** Never resolves on its own — only an abort ends it. */
  | { kind: 'hang' }

const sse = (payload: unknown): string => `data: ${JSON.stringify(payload)}\n\n`

/** A well-formed Chat stream: `ttft` to first text, then `tail` to the terminator. */
function chatStream(ttftMs: number, tailMs: number, tokens: number): Script {
  return {
    kind: 'stream',
    steps: [
      { advanceMs: ttftMs, text: sse({ choices: [{ delta: { content: '1,' } }] }) },
      { advanceMs: tailMs, text: sse({ choices: [], usage: { completion_tokens: tokens } }) },
      { advanceMs: 0, text: 'data: [DONE]\n\n' },
    ],
  }
}

/**
 * Build an injected environment whose `fetch` plays `scripts[i]` for the i-th
 * request (the last script repeats once exhausted).
 */
function harness(scripts: Script[]): Harness {
  const clock = { value: 0 }
  const urls: string[] = []
  let inFlight = 0
  let maxInFlight = 0
  let call = 0

  const fetchImpl: typeof globalThis.fetch = (input, init) => {
    const script = scripts[Math.min(call++, scripts.length - 1)]
    urls.push(String(input))
    inFlight++
    maxInFlight = Math.max(maxInFlight, inFlight)
    const signal = init?.signal ?? null

    const settle = <T>(value: T): Promise<T> => {
      inFlight--
      return Promise.resolve(value)
    }

    if (script.kind === 'reject') {
      inFlight--
      return Promise.reject(new Error(script.message))
    }
    if (script.kind === 'status') {
      return settle(new Response('nope', { status: script.status }))
    }
    if (script.kind === 'hang') {
      return new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => {
          inFlight--
          reject(new Error('aborted'))
        })
      })
    }

    const encoder = new TextEncoder()
    let index = 0
    // highWaterMark 0: `pull` runs once per pending read, so the scripted clock
    // advances when the executor actually consumes a chunk rather than when the
    // stream decides to buffer ahead. Without it the harness would measure its own
    // backpressure instead of the upstream's pacing.
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          if (signal?.aborted) {
            controller.error(new Error('aborted'))
            return
          }
          const step = script.steps[index++]
          if (!step) {
            controller.close()
            return
          }
          clock.value += step.advanceMs
          controller.enqueue(encoder.encode(step.text))
        },
        cancel() {
          /* the executor cancels the reader when it is done */
        },
      },
      { highWaterMark: 0 },
    )
    inFlight--
    return Promise.resolve(
      new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    )
  }

  return {
    deps: {
      fetch: fetchImpl,
      now: () => clock.value,
      wallClock: () => 1_700_000_000_000 + clock.value,
      timeoutMs: 5_000,
    },
    urls,
    get maxInFlight() {
      return maxInFlight
    },
    clock,
  }
}

function plan(over: Partial<SpeedTestPlan> = {}): SpeedTestPlan {
  return {
    runId: 'run-1',
    providerId: 'p1',
    providerDisplayName: 'Example',
    protocolType: 'openai',
    apiDialect: 'chat' as SpeedTestApiDialect,
    model: 'gpt-x',
    plannedCount: 3,
    baseUrl: 'https://api.example.com/v1',
    apiKey: 'sk-secret',
    ...over,
  }
}

describe('SpeedTestExecution', () => {
  it('issues exactly the planned number of requests, one at a time', async () => {
    const h = harness([chatStream(100, 900, 10)])
    const exec = new SpeedTestExecution(plan({ plannedCount: 4 }), h.deps)

    expect(await exec.run()).toBe('completed')
    expect(h.urls).toHaveLength(4)
    expect(h.maxInFlight).toBe(1)
    expect(exec.records.map((r) => r.sequence)).toEqual([1, 2, 3, 4])
  })

  it('derives the documented metrics from a stream with known timings', async () => {
    const h = harness([chatStream(100, 900, 10)])
    const exec = new SpeedTestExecution(plan({ plannedCount: 1 }), h.deps)
    await exec.run()

    const r = exec.records[0]
    expect(r.outcome).toBe('success')
    expect(r.ttftMs).toBe(100)
    expect(r.endToEndMs).toBe(1_000)
    expect(r.outputTokens).toBe(10)
    expect(r.tokenCountSource).toBe('usage')
    expect(r.tpotMs).toBe(100)
  })

  it('marks a single-token response with a null TPOT', async () => {
    const h = harness([chatStream(100, 900, 1)])
    const exec = new SpeedTestExecution(plan({ plannedCount: 1 }), h.deps)
    await exec.run()
    expect(exec.records[0].outcome).toBe('success')
    expect(exec.records[0].tpotMs).toBeNull()
  })

  it('records the estimate source when the upstream sends no usage', async () => {
    const h = harness([
      {
        kind: 'stream',
        steps: [
          { advanceMs: 50, text: sse({ choices: [{ delta: { content: 'a' } }] }) },
          { advanceMs: 50, text: sse({ choices: [{ delta: { content: 'b' } }] }) },
          { advanceMs: 0, text: 'data: [DONE]\n\n' },
        ],
      },
    ])
    const exec = new SpeedTestExecution(plan({ plannedCount: 1 }), h.deps)
    await exec.run()
    expect(exec.records[0].outputTokens).toBe(2)
    expect(exec.records[0].tokenCountSource).toBe('delta_estimate')
  })

  it('classifies an HTTP rejection by its real status and keeps going', async () => {
    const h = harness([{ kind: 'status', status: 429 }, chatStream(10, 10, 5)])
    const exec = new SpeedTestExecution(plan({ plannedCount: 2 }), h.deps)

    expect(await exec.run()).toBe('completed')
    expect(exec.records[0]).toMatchObject({
      outcome: 'failure',
      failureCategory: 'http',
      httpStatus: 429,
    })
    // No retry and no model switch: the second request is the plan's, not a redo.
    expect(h.urls).toHaveLength(2)
    expect(exec.records[1].outcome).toBe('success')
  })

  it('refuses to follow a redirect, recording it as an HTTP failure', async () => {
    const h = harness([{ kind: 'status', status: 302 }])
    const exec = new SpeedTestExecution(plan({ plannedCount: 1 }), h.deps)
    await exec.run()
    expect(exec.records[0]).toMatchObject({ failureCategory: 'http', httpStatus: 302 })
  })

  it('classifies a transport failure as network', async () => {
    const h = harness([{ kind: 'reject', message: 'ECONNREFUSED' }])
    const exec = new SpeedTestExecution(plan({ plannedCount: 1 }), h.deps)
    expect(await exec.run()).toBe('failed')
    expect(exec.records[0].failureCategory).toBe('network')
  })

  it('classifies a budget overrun as timeout', async () => {
    const h = harness([{ kind: 'hang' }])
    const exec = new SpeedTestExecution(plan({ plannedCount: 1 }), { ...h.deps, timeoutMs: 5 })
    expect(await exec.run()).toBe('failed')
    expect(exec.records[0].failureCategory).toBe('timeout')
  })

  it('fails a stream that stops without its terminator, however much text arrived', async () => {
    const h = harness([
      {
        kind: 'stream',
        steps: [{ advanceMs: 30, text: sse({ choices: [{ delta: { content: 'partial' } }] }) }],
      },
    ])
    const exec = new SpeedTestExecution(plan({ plannedCount: 1 }), h.deps)
    expect(await exec.run()).toBe('failed')
    expect(exec.records[0]).toMatchObject({ outcome: 'failure', failureCategory: 'stream' })
    // The observation is kept for the detail table even though it scores nothing.
    expect(exec.records[0].ttftMs).toBe(30)
  })

  it('fails a well-terminated stream that produced no text at all', async () => {
    const h = harness([
      {
        kind: 'stream',
        steps: [
          { advanceMs: 20, text: sse({ choices: [{ delta: { role: 'assistant' } }] }) },
          { advanceMs: 0, text: 'data: [DONE]\n\n' },
        ],
      },
    ])
    const exec = new SpeedTestExecution(plan({ plannedCount: 1 }), h.deps)
    await exec.run()
    expect(exec.records[0]).toMatchObject({ outcome: 'failure', failureCategory: 'stream' })
    expect(exec.records[0].ttftMs).toBeNull()
  })

  it('reports failed when every planned request failed, and still records them', async () => {
    const h = harness([{ kind: 'status', status: 500 }])
    const exec = new SpeedTestExecution(plan({ plannedCount: 3 }), h.deps)
    expect(await exec.run()).toBe('failed')
    expect(exec.records).toHaveLength(3)
    expect(exec.records.every((r) => r.outcome === 'failure')).toBe(true)
  })

  it('keeps completed samples, cancels the in-flight one, and issues nothing further', async () => {
    // Requests 1-2 stream normally; request 3 hangs until the interrupt aborts it.
    const h = harness([chatStream(10, 10, 5), chatStream(10, 10, 5), { kind: 'hang' }])
    const exec = new SpeedTestExecution(plan({ plannedCount: 10 }), h.deps)
    const done = exec.run()
    // Give the executor time to reach the hanging third request.
    await new Promise((r) => setTimeout(r, 5))
    exec.interrupt()

    expect(await done).toBe('interrupted')
    expect(exec.records).toHaveLength(3)
    expect(exec.records.slice(0, 2).every((r) => r.outcome === 'success')).toBe(true)
    expect(exec.records[2]).toMatchObject({
      outcome: 'cancelled',
      failureCategory: null,
      endToEndMs: null,
    })
    // Two completions, not three: a cancelled request advances nothing.
    expect(exec.completedCount).toBe(2)
    expect(h.urls).toHaveLength(3)
  })

  it('seals an interrupted run with no samples when stopped before the first request', async () => {
    const h = harness([chatStream(10, 10, 5)])
    const exec = new SpeedTestExecution(plan({ plannedCount: 5 }), h.deps)
    exec.interrupt()
    expect(await exec.run()).toBe('interrupted')
    expect(exec.records).toHaveLength(0)
    expect(h.urls).toHaveLength(0)
  })

  it('ignores a repeated interrupt and one that lands after the run sealed', async () => {
    const h = harness([chatStream(10, 10, 5)])
    const exec = new SpeedTestExecution(plan({ plannedCount: 1 }), h.deps)
    expect(await exec.run()).toBe('completed')
    exec.interrupt()
    exec.interrupt()
    // The terminal state was produced once and cannot be reopened.
    expect(exec.records).toHaveLength(1)
    expect(exec.records[0].outcome).toBe('success')
  })

  it('pushes progress once per naturally completed request', async () => {
    const h = harness([chatStream(10, 10, 5)])
    const ticks: number[] = []
    const exec = new SpeedTestExecution(plan({ plannedCount: 3 }), h.deps, (c) =>
      ticks.push(c.completedCount),
    )
    await exec.run()
    expect(ticks).toEqual([1, 2, 3])
  })

  it('dials the Responses endpoint for a responses plan and never the Chat one', async () => {
    const h = harness([
      {
        kind: 'stream',
        steps: [
          { advanceMs: 40, text: sse({ type: 'response.output_text.delta', delta: '1,' }) },
          {
            advanceMs: 60,
            text: sse({ type: 'response.completed', response: { usage: { output_tokens: 6 } } }),
          },
        ],
      },
    ])
    const exec = new SpeedTestExecution(plan({ plannedCount: 1, apiDialect: 'responses' }), h.deps)
    await exec.run()
    expect(h.urls).toEqual(['https://api.example.com/v1/responses'])
    expect(exec.records[0]).toMatchObject({ outcome: 'success', ttftMs: 40, endToEndMs: 100 })
  })

  it('dials the Messages endpoint for an anthropic plan', async () => {
    const h = harness([
      {
        kind: 'stream',
        steps: [
          {
            advanceMs: 40,
            text: sse({ type: 'content_block_delta', delta: { type: 'text_delta', text: '1,' } }),
          },
          { advanceMs: 60, text: sse({ type: 'message_delta', usage: { output_tokens: 6 } }) },
          { advanceMs: 0, text: sse({ type: 'message_stop' }) },
        ],
      },
    ])
    const exec = new SpeedTestExecution(
      plan({
        plannedCount: 1,
        protocolType: 'anthropic',
        apiDialect: 'messages',
        baseUrl: 'https://api.example.com/anthropic',
      }),
      h.deps,
    )
    await exec.run()
    expect(h.urls).toEqual(['https://api.example.com/anthropic/v1/messages'])
    expect(exec.records[0]).toMatchObject({ outcome: 'success', outputTokens: 6 })
  })
})
