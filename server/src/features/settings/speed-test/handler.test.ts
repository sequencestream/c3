/**
 * The speed-test ingress: what it refuses, what it derives, and what it persists.
 *
 * The line this file defends is that NOTHING about the target comes from the wire.
 * A start names a saved provider, a protocol slot, a model and a count; the URL,
 * the credential and the API dialect are read from configuration. Every rejection
 * must happen before a single upstream request, because a refused start that still
 * spent money — or still left a record implying it ran — is worse than no feature.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ModelProvider, ServerToClient, SystemSettings } from '@ccc/shared/protocol'
import type { Conn } from '../../../transport/handler-registry.js'
import type { KernelContext } from '../../../kernel/types.js'

const h = vi.hoisted(() => ({ providers: [] as ModelProvider[] }))

vi.mock('../../../kernel/config/index.js', () => ({
  loadSettings: (): SystemSettings => ({ modelProviders: h.providers }) as SystemSettings,
}))

vi.mock('../../auth/authz.js', () => ({
  requireAdmin: () => true,
  isAdminConn: () => true,
}))

import { getDb, resetDbForTests } from '../../../kernel/infra/db.js'
import {
  modelProviderSpeedTestHandler,
  resetSpeedTestRunsForTests,
  setSpeedTestDepsForTests,
} from './index.js'
import { ensureSpeedTestSchema, resetSpeedTestStoreForTests } from './store.js'

type ResultFrame = Extract<ServerToClient, { type: 'model_provider_speed_test_result' }>

function conn(): { conn: Conn; sent: ResultFrame[]; all: ServerToClient[] } {
  const all: ServerToClient[] = []
  const sent: ResultFrame[] = []
  return {
    conn: {
      send: (m) => {
        all.push(m)
        if (m.type === 'model_provider_speed_test_result') sent.push(m)
      },
      viewing: null,
      deliver: () => {},
      sendWorkspaces: () => {},
      sendSessions: async () => {},
      authed: true,
      authToken: 'tok',
      subject: 'admin',
    },
    sent,
    all,
  }
}

const ctx = {} as KernelContext

/** Dispatch one frame; the handler is sync for everything but `start`'s background run. */
function dispatch(c: Conn, msg: Record<string, unknown>): void {
  void modelProviderSpeedTestHandler(
    ctx,
    c,
    msg as Parameters<typeof modelProviderSpeedTestHandler>[2],
  )
}

/** A fake upstream: one well-formed Chat stream per call, on a scripted clock. */
function scriptedFetch(clock: { value: number }, urls: string[]): typeof globalThis.fetch {
  const sse = (p: unknown) => `data: ${JSON.stringify(p)}\n\n`
  return (input) => {
    urls.push(String(input))
    const steps = [
      { advanceMs: 100, text: sse({ choices: [{ delta: { content: '1,' } }] }) },
      { advanceMs: 900, text: sse({ choices: [], usage: { completion_tokens: 10 } }) },
      { advanceMs: 0, text: 'data: [DONE]\n\n' },
    ]
    const encoder = new TextEncoder()
    let i = 0
    const body = new ReadableStream<Uint8Array>(
      {
        // A real (tiny) delay per chunk, so a run occupies measurable wall time
        // and an interrupt can land mid-plan. The METRIC clock stays scripted.
        async pull(controller) {
          await new Promise((r) => setTimeout(r, 2))
          const step = steps[i++]
          if (!step) return controller.close()
          clock.value += step.advanceMs
          controller.enqueue(encoder.encode(step.text))
        },
      },
      { highWaterMark: 0 },
    )
    return Promise.resolve(new Response(body, { status: 200 }))
  }
}

let home: string
let clock: { value: number }
let urls: string[]

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'c3-speed-test-handler-'))
  process.env.C3_DB_PATH = join(home, 'c3.db')
  resetDbForTests()
  resetSpeedTestStoreForTests()
  resetSpeedTestRunsForTests()
  clock = { value: 0 }
  urls = []
  setSpeedTestDepsForTests({
    fetch: scriptedFetch(clock, urls),
    now: () => clock.value,
    wallClock: () => 1_700_000_000_000 + clock.value,
    timeoutMs: 5_000,
  })
  h.providers = [
    {
      id: 'p1',
      displayName: 'Example',
      vendor: 'custom',
      apiKey: 'sk-stored',
      urls: { openai: 'https://api.example.com/v1' },
      models: [{ id: 'gpt-x' }],
    },
  ]
})

afterEach(() => {
  resetDbForTests()
  delete process.env.C3_DB_PATH
  resetSpeedTestStoreForTests()
  resetSpeedTestRunsForTests()
  setSpeedTestDepsForTests(null)
  rmSync(home, { recursive: true, force: true })
})

/** Wait until the background run has emitted its terminal frame. */
async function settle(sent: ResultFrame[]): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (sent.some((f) => f.event === 'finished' || f.event === 'error')) return
    await new Promise((r) => setTimeout(r, 1))
  }
}

const start = (over: Record<string, unknown> = {}) => ({
  type: 'model_provider_speed_test',
  requestId: 'q1',
  action: 'start',
  providerId: 'p1',
  protocolType: 'openai',
  model: 'gpt-x',
  requestCount: 2,
  ...over,
})

describe('start validation', () => {
  it.each([
    ['zero', 0],
    ['negative', -1],
    ['fractional', 2.5],
    ['over the ceiling', 101],
    ['not a number', 'ten'],
  ])('refuses a %s request count without dialing anything', async (_label, requestCount) => {
    const c = conn()
    dispatch(c.conn, start({ requestCount }))
    expect(c.sent).toEqual([
      expect.objectContaining({ event: 'error', code: 'invalid_count', providerId: 'p1' }),
    ])
    expect(urls).toEqual([])
  })

  it('refuses a provider that is not in the SAVED configuration', () => {
    const c = conn()
    dispatch(c.conn, start({ providerId: 'draft-not-saved' }))
    expect(c.sent[0]).toMatchObject({ event: 'error', code: 'provider_unknown' })
    expect(urls).toEqual([])
  })

  it('refuses a protocol slot the provider has not filled', () => {
    const c = conn()
    dispatch(c.conn, start({ protocolType: 'anthropic' }))
    expect(c.sent[0]).toMatchObject({ event: 'error', code: 'protocol_unavailable' })
    expect(urls).toEqual([])
  })

  it('treats a whitespace-only URL as an unfilled slot', () => {
    h.providers[0].urls = { openai: '   ' }
    const c = conn()
    dispatch(c.conn, start())
    expect(c.sent[0]).toMatchObject({ event: 'error', code: 'protocol_unavailable' })
  })

  it('refuses a structurally invalid URL rather than silently using the other slot', () => {
    h.providers[0].urls = { openai: 'ftp://nope', anthropic: 'https://fine.example' }
    const c = conn()
    dispatch(c.conn, start())
    expect(c.sent[0]).toMatchObject({ event: 'error', code: 'invalid_url' })
    expect(urls).toEqual([])
  })

  it('refuses when the merged model catalog is empty', () => {
    h.providers[0].models = [{ id: '  ' }]
    const c = conn()
    dispatch(c.conn, start())
    expect(c.sent[0]).toMatchObject({ event: 'error', code: 'models_empty' })
  })

  it('refuses a model outside the merged catalog', () => {
    const c = conn()
    dispatch(c.conn, start({ model: 'not-listed' }))
    expect(c.sent[0]).toMatchObject({ event: 'error', code: 'model_unavailable' })
    expect(urls).toEqual([])
  })
})

describe('run lifecycle', () => {
  it('accepts, derives the dialect server-side, progresses and persists', async () => {
    const c = conn()
    dispatch(c.conn, start())

    const accepted = c.sent[0]
    expect(accepted).toMatchObject({
      event: 'accepted',
      run: { providerId: 'p1', apiDialect: 'chat', plannedCount: 2, model: 'gpt-x' },
    })
    await settle(c.sent)

    // 0/N first, then one tick per completed request.
    const progress = c.sent.filter((f) => f.event === 'progress')
    expect(progress.map((f) => (f.event === 'progress' ? f.run.completedCount : -1))).toEqual([
      0, 1, 2,
    ])

    const finished = c.sent.find((f) => f.event === 'finished')
    expect(finished).toBeDefined()
    if (finished?.event !== 'finished') throw new Error('unreachable')
    expect(finished.detail.run.outcome).toBe('completed')
    expect(finished.detail.run.summary.successRate).toBe(1)
    expect(finished.detail.run.summary.tokensPerSecond).toBe(10)
    expect(finished.detail.requests).toHaveLength(2)
    expect(urls).toEqual([
      'https://api.example.com/v1/chat/completions',
      'https://api.example.com/v1/chat/completions',
    ])

    // The record is queryable straight away, by run id and by provider.
    const q = conn()
    dispatch(q.conn, {
      type: 'model_provider_speed_test',
      requestId: 'q2',
      action: 'list',
      providerId: 'p1',
    })
    expect(q.sent[0]).toMatchObject({ event: 'list' })
    if (q.sent[0].event !== 'list') throw new Error('unreachable')
    expect(q.sent[0].page.runs).toHaveLength(1)
    expect(q.sent[0].page.runs[0].runId).toBe(finished.detail.run.runId)
  })

  it('routes a responses provider to the Responses endpoint', async () => {
    h.providers[0].wireApi = 'responses'
    const c = conn()
    dispatch(c.conn, start({ requestCount: 1 }))
    expect(c.sent[0]).toMatchObject({ event: 'accepted', run: { apiDialect: 'responses' } })
    await settle(c.sent)
    expect(urls).toEqual(['https://api.example.com/v1/responses'])
  })

  it('refuses a second run against the same provider and names the one in flight', async () => {
    const first = conn()
    dispatch(first.conn, start({ requestCount: 5 }))
    const accepted = first.sent[0]
    if (accepted.event !== 'accepted') throw new Error('unreachable')

    const second = conn()
    dispatch(second.conn, start({ requestCount: 5 }))
    expect(second.sent[0]).toMatchObject({
      event: 'error',
      code: 'busy',
      runId: accepted.run.runId,
    })

    dispatch(first.conn, {
      type: 'model_provider_speed_test',
      requestId: 'q3',
      action: 'interrupt',
      runId: accepted.run.runId,
    })
    await settle(first.sent)
  })

  it('stops on interrupt and still persists the completed part as interrupted', async () => {
    const c = conn()
    dispatch(c.conn, start({ requestCount: 10 }))
    const accepted = c.sent[0]
    if (accepted.event !== 'accepted') throw new Error('unreachable')

    // Let a request or two land, then stop.
    await new Promise((r) => setTimeout(r, 12))
    dispatch(c.conn, {
      type: 'model_provider_speed_test',
      requestId: 'q4',
      action: 'interrupt',
      runId: accepted.run.runId,
    })
    await settle(c.sent)

    const finished = c.sent.find((f) => f.event === 'finished')
    if (finished?.event !== 'finished') throw new Error('unreachable')
    expect(finished.detail.run.outcome).toBe('interrupted')
    expect(finished.detail.run.plannedCount).toBe(10)
    expect(finished.detail.run.summary.completedCount).toBeLessThan(10)
    expect(urls.length).toBeLessThan(10)

    // And it is in the history, not lost with the interrupt.
    const q = conn()
    dispatch(q.conn, {
      type: 'model_provider_speed_test',
      requestId: 'q5',
      action: 'detail',
      runId: accepted.run.runId,
    })
    expect(q.sent[0]).toMatchObject({ event: 'detail' })
  })

  it('reports no active run for a provider that is idle, and the run while it is live', async () => {
    const idle = conn()
    dispatch(idle.conn, {
      type: 'model_provider_speed_test',
      requestId: 'q6',
      action: 'active',
      providerId: 'p1',
    })
    expect(idle.sent[0]).toMatchObject({ event: 'active', providerId: 'p1', run: null })

    const c = conn()
    dispatch(c.conn, start({ requestCount: 5 }))
    const accepted = c.sent[0]
    if (accepted.event !== 'accepted') throw new Error('unreachable')

    // A reconnecting console re-attaches by asking, and gets the live snapshot.
    const rejoin = conn()
    dispatch(rejoin.conn, {
      type: 'model_provider_speed_test',
      requestId: 'q7',
      action: 'active',
      providerId: 'p1',
    })
    expect(rejoin.sent[0]).toMatchObject({
      event: 'active',
      run: { runId: accepted.run.runId, state: 'running' },
    })

    dispatch(c.conn, {
      type: 'model_provider_speed_test',
      requestId: 'q8',
      action: 'interrupt',
      runId: accepted.run.runId,
    })
    await settle(c.sent)
    // The rejoining connection is a subscriber too, so it saw the outcome.
    expect(rejoin.sent.some((f) => f.event === 'finished')).toBe(true)
  })

  it('reports a failed commit and lets a retry save it without redialing upstream', async () => {
    const c = conn()
    dispatch(c.conn, start({ requestCount: 1 }))
    // Pull the table out from under the run after it started: the samples are
    // already paid for, so the commit failure must be visible, not swallowed.
    getDb()!.exec('DROP TABLE model_provider_speed_tests')
    await settle(c.sent)

    const failure = c.sent.find((f) => f.event === 'error')
    if (failure?.event !== 'error') throw new Error('unreachable')
    expect(failure.code).toBe('save_failed')
    // The measured result is still handed back, so the dialog can show it.
    expect(failure.run?.summary.successCount).toBe(1)
    expect(urls).toHaveLength(1)

    // Storage comes back; the retry commits the SAME samples.
    resetSpeedTestStoreForTests()
    expect(ensureSpeedTestSchema()).toBe(true)
    dispatch(c.conn, {
      type: 'model_provider_speed_test',
      requestId: 'q11',
      action: 'retry_save',
      runId: failure.runId,
    })

    const finished = c.sent.find((f) => f.event === 'finished')
    if (finished?.event !== 'finished') throw new Error('unreachable')
    expect(finished.detail.run.runId).toBe(failure.runId)
    // A retry replays nothing upstream — it costs no further credits.
    expect(urls).toHaveLength(1)
  })

  it('answers not_found for an unknown run id on interrupt, retry and detail', () => {
    for (const action of ['interrupt', 'retry_save', 'detail']) {
      const c = conn()
      dispatch(c.conn, {
        type: 'model_provider_speed_test',
        requestId: 'q9',
        action,
        runId: 'nope',
      })
      expect(c.sent[0]).toMatchObject({ event: 'error', code: 'not_found' })
    }
  })

  it('lists providers with history, including one no longer configured', async () => {
    const c = conn()
    dispatch(c.conn, start({ requestCount: 1 }))
    await settle(c.sent)

    h.providers = []
    const q = conn()
    dispatch(q.conn, {
      type: 'model_provider_speed_test',
      requestId: 'q10',
      action: 'history_providers',
    })
    expect(q.sent[0]).toMatchObject({ event: 'history_providers' })
    if (q.sent[0].event !== 'history_providers') throw new Error('unreachable')
    expect(q.sent[0].providers).toEqual([
      expect.objectContaining({ providerId: 'p1', displayName: 'Example', present: false }),
    ])
  })
})
