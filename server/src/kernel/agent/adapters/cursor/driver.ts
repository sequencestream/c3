/**
 * Cursor {@link AgentDriver} — one SDK agent + one `send` per turn.
 *
 * c3 drives Cursor through `@cursor/sdk`'s **local** runtime, which executes
 * inside the c3 server process: there is no `cursor-agent` child to spawn, no
 * argv to shape and no NDJSON to parse. A turn is `Agent.create` (or
 * `Agent.resume`) → `send` → iterate `Run.stream()` → settle on `Run.wait()`.
 *
 * **Credentials.** The SDK authenticates with an API key only; it does not read
 * the keychain credential `cursor-agent login` writes. The key is resolved
 * before anything else so a run without one fails at the door rather than
 * burning a turn to return `Invalid User API Key`.
 *
 * **Session id.** The SDK mints the agent id up front, so `sessionId()` is known
 * the moment `start()` returns — no waiting on an init frame, and no risk of a
 * fabricated id reaching `resume` later.
 *
 * **Resume.** A c3 session that already owns an agent id passes it verbatim to
 * `Agent.resume`. Cursor's own store is the recovery truth; c3's canonical
 * mirror is only for listing and replay, and is refreshed from each run's frames.
 *
 * **Abort.** `Run.cancel()` is the whole-turn kill. Because the runtime is
 * in-process, cancelling is a real cooperative stop rather than a signal to a
 * process group — but it is still whole-turn only: the SDK exposes no mid-turn
 * interrupt and no per-tool approval point.
 *
 * ADR-0009: `@cursor/sdk` types stay inside this directory — the driver consumes
 * the SDK behind the structural {@link CursorSdk} seam and only canonical shapes
 * leave via {@link AgentRun.messages}.
 */
import type { AgentDriver, AgentRun, CanonicalMessage, DriverStartOptions } from '../types.js'
import { cursorCapabilities } from './capabilities.js'
import { CursorStreamTranslator, type CursorEvent } from './translate.js'
import {
  CursorUnsupportedError,
  cursorAgentOptions,
  cursorSendOptions,
  cursorUserMessage,
  type CursorLaunchConfig,
} from './launch.js'

/** Async-iterable message queue with a terminal failure, mirroring the codex driver's. */
class CanonicalQueue implements AsyncIterable<CanonicalMessage> {
  private readonly items: CanonicalMessage[] = []
  private readonly waiters: Array<(r: IteratorResult<CanonicalMessage>) => void> = []
  private finished = false
  private failure: unknown = null

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

/** The terminal state of one SDK run, as the driver reads it. */
export interface CursorRunResult {
  status: 'finished' | 'error' | 'cancelled' | string
  error?: { message: string }
}

/** The minimal structural face of an SDK run the driver consumes. */
export interface CursorRunHandle {
  stream(): AsyncGenerator<unknown, void>
  wait(): Promise<CursorRunResult>
  cancel(): Promise<void>
}

/** The minimal structural face of an SDK agent the driver consumes. */
export interface CursorAgentHandle {
  readonly agentId: string
  send(
    message: { text: string; images?: Array<{ data: string; mimeType: string }> },
    options: unknown,
  ): Promise<CursorRunHandle>
  close(): void
}

/**
 * SDK boundary. The real implementation wraps `@cursor/sdk`'s `Agent`; tests
 * inject a fake that scripts a message stream, so the main suite needs neither an
 * API key nor a network hop.
 */
export interface CursorSdk {
  create(options: unknown): Promise<CursorAgentHandle>
  resume(agentId: string, options: unknown): Promise<CursorAgentHandle>
}

/**
 * The default SDK binding — imported lazily so that merely constructing the
 * adapter (which the automation tool-manifest path does, for its static tool
 * list) never pulls the SDK's local runtime and its platform-native package into
 * the process.
 */
const defaultSdk: CursorSdk = {
  async create(options) {
    const { Agent } = await import('@cursor/sdk')
    return (await Agent.create(options as Parameters<typeof Agent.create>[0])) as CursorAgentHandle
  },
  async resume(agentId, options) {
    const { Agent } = await import('@cursor/sdk')
    return (await Agent.resume(
      agentId,
      options as Parameters<typeof Agent.resume>[1],
    )) as CursorAgentHandle
  },
}

class CursorRun implements AgentRun {
  private readonly queue = new CanonicalQueue()
  private readonly translator: CursorStreamTranslator
  private aborted = false
  /** The live run, once `send` has resolved — `cancel` has nothing to target before that. */
  private run: CursorRunHandle | null = null

  constructor(
    private readonly opts: DriverStartOptions,
    private readonly agent: CursorAgentHandle,
  ) {
    this.translator = new CursorStreamTranslator(agent.agentId)
    opts.signal.addEventListener('abort', () => this.abort(), { once: true })
    void this.pump()
  }

  sessionId(): Promise<string> {
    // The SDK mints the id when the agent is created, so this never pends.
    return Promise.resolve(this.agent.agentId)
  }

  messages(): AsyncIterable<CanonicalMessage> {
    return this.queue
  }

  abort(): void {
    if (this.aborted) return
    this.aborted = true
    // Cancel is best-effort: a run that already settled rejects, and a turn that
    // never started has nothing to cancel. Either way the queue closes, so the
    // run loop is never left waiting on a stream that will not advance.
    void this.run?.cancel().catch(() => undefined)
    this.queue.close()
  }

  /** Drive the turn to completion and settle the run exactly once. */
  private async pump(): Promise<void> {
    let ended: { isError: boolean; errorMessage?: string } | undefined
    try {
      const run = await this.agent.send(cursorUserMessage(this.opts), cursorSendOptions(this.opts))
      this.run = run
      // An abort that landed while `send` was in flight has to be honoured now —
      // the listener fired before there was a run to cancel.
      if (this.aborted) {
        await run.cancel().catch(() => undefined)
        return
      }

      for await (const event of run.stream()) {
        if (this.aborted) break
        const { messages, ended: end } = this.translator.consume(event as CursorEvent)
        for (const message of messages) this.queue.push(message)
        if (end) ended = end
      }

      if (this.aborted) return

      // `wait()` is the terminal truth: the stream ending only means no more
      // frames, not that the turn succeeded.
      const result = await run.wait()
      if (result.status === 'error') {
        this.queue.fail(
          new Error(
            result.error?.message ?? ended?.errorMessage ?? 'cursor run failed without a reason',
          ),
        )
        return
      }
      // A cancellation the SDK reports (rather than one c3 asked for) still ends
      // the turn quietly — there is no failure to surface, only a shorter turn.
      if (ended?.isError && result.status !== 'cancelled') {
        this.queue.fail(new Error(ended.errorMessage ?? 'cursor run failed'))
        return
      }
      this.queue.close()
    } catch (err) {
      // An aborted turn settles quietly: the abort is the caller's own doing, and
      // whatever the SDK threw on the way down is a consequence of it.
      if (this.aborted) this.queue.close()
      else this.queue.fail(err)
    } finally {
      // The agent handle owns runtime resources (the local executor, its MCP
      // clients); the next turn resumes by id, so nothing is lost by closing it.
      try {
        this.agent.close()
      } catch {
        /* already closed */
      }
    }
  }
}

export class CursorDriver implements AgentDriver {
  readonly vendor = 'cursor' as const
  readonly capabilities = cursorCapabilities

  constructor(
    private readonly resolveConfig: (opts: DriverStartOptions) => CursorLaunchConfig,
    private readonly sdk: CursorSdk = defaultSdk,
  ) {}

  async start(opts: DriverStartOptions): Promise<AgentRun> {
    // Option shaping resolves the credential, so a run with no key at all throws
    // here — before an agent exists and before a turn is spent.
    const options = cursorAgentOptions(opts, this.resolveConfig(opts))
    try {
      const agent = opts.resume
        ? await this.sdk.resume(opts.resume, options)
        : await this.sdk.create(options)
      return new CursorRun(opts, agent)
    } catch (err) {
      // `Agent.create` validates the credential over the network before it
      // returns, so a bad key surfaces here as a bare HTTP 401 whose message
      // names an endpoint rather than the thing the operator has to fix.
      const status = (err as { status?: unknown }).status
      if (status === 401 || status === 403) {
        throw new CursorUnsupportedError(
          'cursor: the API key was rejected — check the key on this agent, or CURSOR_API_KEY in the server environment.',
        )
      }
      throw err
    }
  }
}
