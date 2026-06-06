/**
 * OpenCode's {@link AgentDriver} (2026-06-06-003) — the first non-Claude driver to
 * run a real turn end-to-end. It differs from Claude in shape, not contract:
 * OpenCode is a long-lived REST/SSE server (reached via the {@link OpencodeSupervisor}),
 * so a "run" is *create-or-resume a session → subscribe to the event stream →
 * POST a prompt → translate the streamed parts*. The whole-turn `abort` maps to
 * `session.abort`; per-tool approval rides the shared {@link OpencodeApprovalBridge}
 * which this driver feeds the `permission.*` events.
 *
 * SSE jitter (009's fatal window): the pump re-subscribes on stream error so a
 * dropped connection doesn't silently end the run. There is no "list pending
 * permissions" endpoint to reconcile missed `permission.updated` against, so the
 * bridge's per-request timeout is the backstop against a permanently-suspended
 * approval (see {@link OpencodeApprovalBridge}).
 *
 * ADR-0009: imports `@opencode-ai/sdk` (inside `adapters/opencode/`); only
 * canonical shapes leave via {@link AgentRun.messages}.
 */
import type { Event, OpencodeClient } from '@opencode-ai/sdk'
import type { AgentDriver, AgentRun, CanonicalMessage, DriverStartOptions } from '../types.js'
import { opencodeCapabilities } from './capabilities.js'
import { OpencodeStreamTranslator } from './translate.js'
import type { OpencodeApprovalBridge } from './approval.js'

/** Push/close/fail async-iterable buffer bridging the SSE pump into a pull stream. */
class CanonicalQueue implements AsyncIterable<CanonicalMessage> {
  private readonly items: CanonicalMessage[] = []
  private readonly waiters: Array<(r: IteratorResult<CanonicalMessage>) => void> = []
  private finished = false
  private failure: unknown = null

  get done(): boolean {
    return this.finished
  }

  push(m: CanonicalMessage): void {
    if (this.finished) return
    const waiter = this.waiters.shift()
    if (waiter) waiter({ value: m, done: false })
    else this.items.push(m)
  }

  close(): void {
    if (this.finished) return
    this.finished = true
    let waiter
    while ((waiter = this.waiters.shift())) {
      waiter({ value: undefined as unknown as CanonicalMessage, done: true })
    }
  }

  fail(err: unknown): void {
    this.failure = err
    this.close()
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<CanonicalMessage> {
    for (;;) {
      const next = this.items.shift()
      if (next) {
        yield next
        continue
      }
      if (this.finished) {
        if (this.failure) throw this.failure
        return
      }
      const result = await new Promise<IteratorResult<CanonicalMessage>>((resolve) => {
        this.waiters.push(resolve)
      })
      if (result.done) {
        if (this.failure) throw this.failure
        return
      }
      yield result.value
    }
  }
}

/** Split a neutral `provider/model` id into OpenCode's `{ providerID, modelID }`. */
function splitModel(model?: string): { providerID: string; modelID: string } | undefined {
  if (!model) return undefined
  const i = model.indexOf('/')
  return i > 0 ? { providerID: model.slice(0, i), modelID: model.slice(i + 1) } : undefined
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Extract a human message from an OpenCode error union without serializing it. */
function errText(e: unknown): string {
  if (e && typeof e === 'object') {
    const data = (e as { data?: { message?: unknown } }).data
    if (data && typeof data.message === 'string') return data.message
    const name = (e as { name?: unknown }).name
    if (typeof name === 'string') return name
  }
  return 'unknown error'
}

export class OpencodeDriver implements AgentDriver {
  readonly vendor = 'opencode' as const
  readonly capabilities = opencodeCapabilities

  constructor(
    private readonly getClient: () => OpencodeClient,
    private readonly approval: OpencodeApprovalBridge,
  ) {}

  async start(opts: DriverStartOptions): Promise<AgentRun> {
    const client = this.getClient()
    const queue = new CanonicalQueue()
    const translator = new OpencodeStreamTranslator()

    // Internal abort owns the run; the external signal feeds it.
    const controller = new AbortController()
    if (opts.signal.aborted) controller.abort()
    else opts.signal.addEventListener('abort', () => controller.abort(), { once: true })

    // Create or resume the session id up front (callers await sessionId()).
    let sid = opts.resume
    if (!sid) {
      const created = await client.session.create({ query: { directory: opts.cwd } })
      sid = created.data?.id
    }
    if (!sid) throw new Error('opencode: failed to create session')
    const sessionId = sid

    // The preApproved audit: a rule-engine auto-allow (a `permission.replied` for
    // an id c3 never asked-and-wrote) becomes an envelope-level canonical marker the
    // accumulator stamps onto the session view.
    const markPreApproved = (): void => {
      queue.push({
        vendor: 'opencode',
        sessionId,
        role: 'assistant',
        blocks: [],
        ts: Date.now(),
        preApproved: true,
      })
    }

    const dispatch = (ev: Event): void => {
      switch (ev.type) {
        case 'message.updated':
          translator.noteMessage(ev.properties.info)
          break
        case 'message.part.updated': {
          if (ev.properties.part.sessionID !== sessionId) return
          const msg = translator.translatePart(ev.properties.part, sessionId, Date.now())
          if (msg) queue.push(msg)
          break
        }
        case 'permission.updated':
          if (ev.properties.sessionID !== sessionId) return
          void this.approval.handleUpdated(ev.properties, { client, directory: opts.cwd })
          break
        case 'permission.replied':
          if (ev.properties.sessionID !== sessionId) return
          if (this.approval.handleReplied(ev.properties) === 'preApproved') markPreApproved()
          break
        case 'session.idle':
          if (ev.properties.sessionID === sessionId) queue.close()
          break
        case 'session.error':
          if (ev.properties.sessionID === sessionId) {
            queue.fail(new Error(`opencode session error: ${errText(ev.properties.error)}`))
          }
          break
      }
    }

    // Pump the event stream, re-subscribing on SSE error (009 jitter mitigation),
    // until the turn ends (queue closed) or the run is aborted.
    let firstSubResolve: () => void = () => {}
    const firstSub = new Promise<void>((r) => {
      firstSubResolve = r
    })
    const pump = async (): Promise<void> => {
      let signalled = false
      while (!controller.signal.aborted && !queue.done) {
        try {
          const sub = await client.event.subscribe()
          if (!signalled) {
            signalled = true
            firstSubResolve()
          }
          for await (const ev of sub.stream) {
            if (controller.signal.aborted || queue.done) return
            dispatch(ev)
            if (queue.done) return
          }
        } catch {
          if (controller.signal.aborted || queue.done) return
          await sleep(1_000) // brief backoff before re-subscribe
        }
      }
    }
    void pump().finally(() => {
      firstSubResolve()
    })

    // Subscribe before prompting so no permission/part event is missed.
    await firstSub

    const model = splitModel(opts.model)
    void (async () => {
      try {
        await client.session.prompt({
          path: { id: sessionId },
          query: { directory: opts.cwd },
          body: {
            parts: [{ type: 'text', text: opts.prompt }],
            ...(model ? { model } : {}),
          },
        })
        // The prompt resolving = the turn finished (session.idle may also fire).
        queue.close()
      } catch (e) {
        queue.fail(e)
      }
    })()

    return {
      sessionId: () => Promise.resolve(sessionId),
      messages: () => queue,
      abort: () => {
        controller.abort()
        void client.session.abort({ path: { id: sessionId }, query: { directory: opts.cwd } })
        queue.close()
      },
    }
  }
}
