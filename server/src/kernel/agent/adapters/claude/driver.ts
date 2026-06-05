/**
 * Claude's {@link AgentDriver} — the reference implementation that proves the
 * neutral interface holds without rewriting the run loop (ADR-0011, decision D1:
 * additive-only). It wraps the existing {@link runClaude}: the run's callback
 * `send` stream is translated into a canonical {@link AgentRun.messages} stream,
 * its `onSessionId` resolves {@link AgentRun.sessionId}, and its {@link RunHandle}
 * backs the reachable optional controls (`setActionMode`, `pushInput`). `runClaude`
 * itself is untouched.
 *
 * Capability vs wiring: {@link claudeCapabilities} reports the *vendor* abilities
 * (all true). This additive-phase driver wires the controls reachable through
 * `RunHandle`; `interrupt` and `forkSession` are vendor-true but NOT yet exposed
 * as `AgentRun` methods (the AgentDriver-rewrite phase wires them). The invariant
 * the contract test pins is the safe direction: a method present ⇒ its flag is
 * true; callers probe `typeof run.method === 'function'` under the flag.
 */
import type { ServerToClient } from '@ccc/shared/protocol'
import type { AgentDriver, AgentRun, CanonicalMessage, DriverStartOptions } from '../types.js'
import { runClaude, type RunHandle } from '../../index.js'
import { claudeCapabilities } from './capabilities.js'
import { toPermissionMode } from './permission-map.js'
import { ClaudeStreamTranslator } from './translate.js'

/**
 * Push/close/fail async-iterable buffer bridging `runClaude`'s callback `send`
 * into a pull-based {@link AgentRun.messages} stream. Mirrors the run loop's own
 * `InputStream` shape (queue + waiters) in the other direction.
 */
class CanonicalQueue implements AsyncIterable<CanonicalMessage> {
  private readonly items: CanonicalMessage[] = []
  private readonly waiters: Array<(r: IteratorResult<CanonicalMessage>) => void> = []
  private done = false
  private failure: unknown = null

  push(m: CanonicalMessage): void {
    if (this.done) return
    const waiter = this.waiters.shift()
    if (waiter) waiter({ value: m, done: false })
    else this.items.push(m)
  }

  close(): void {
    if (this.done) return
    this.done = true
    let waiter
    while ((waiter = this.waiters.shift())) {
      waiter({ value: undefined as unknown as CanonicalMessage, done: true })
    }
  }

  /** Mark the stream failed; queued messages still drain, then the error throws. */
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
      if (this.done) {
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

export class ClaudeDriver implements AgentDriver {
  readonly vendor = 'claude' as const
  readonly capabilities = claudeCapabilities

  async start(opts: DriverStartOptions): Promise<AgentRun> {
    const queue = new CanonicalQueue()
    const translator = new ClaudeStreamTranslator()

    let resolveSid: (id: string) => void
    const sessionId = new Promise<string>((resolve) => {
      resolveSid = resolve
    })

    // The RunHandle arrives via onStart, after start() has already returned.
    // Buffer inputs pushed before it lands; flush on arrival (pushInput is sync).
    let handle: RunHandle | null = null
    const pendingInputs: string[] = []
    let resolveHandle: () => void
    const handleReady = new Promise<void>((resolve) => {
      resolveHandle = resolve
    })

    // Internal abort owns the run; the external signal feeds it (so abort() and a
    // caller-cancelled signal both tear the run down through one path).
    const controller = new AbortController()
    if (opts.signal.aborted) controller.abort()
    else opts.signal.addEventListener('abort', () => controller.abort(), { once: true })

    void runClaude({
      prompt: opts.prompt,
      cwd: opts.cwd,
      signal: controller.signal,
      permissionMode: toPermissionMode(opts.actionMode, opts.toolGate),
      ...(opts.resume ? { resume: opts.resume } : {}),
      ...(opts.model ? { model: opts.model } : {}),
      ...(opts.envOverrides ? { envOverrides: opts.envOverrides } : {}),
      send: (msg: ServerToClient) => {
        const canonical = translator.translate(msg)
        if (canonical) queue.push(canonical)
        // turn_end ends the canonical stream (a fresh start() begins the next turn).
        if (msg.type === 'turn_end') queue.close()
      },
      onSessionId: (id) => {
        translator.setSessionId(id)
        resolveSid(id)
      },
      onStart: (h) => {
        handle = h
        for (const text of pendingInputs.splice(0)) h.pushInput(text)
        resolveHandle()
      },
    })
      .catch((err) => queue.fail(err))
      .finally(() => queue.close())

    return {
      sessionId: () => sessionId,
      messages: () => queue,
      abort: () => controller.abort(),
      // streamingPush (capabilities.streamingPush): buffer until the handle lands.
      pushInput: (text: string) => {
        if (handle) handle.pushInput(text)
        else pendingInputs.push(text)
      },
      // setActionMode (capabilities.setActionMode): the tool gate is fixed for the
      // run; only the action axis is live, recomposed into a Claude mode.
      setActionMode: async (mode) => {
        await handleReady
        await handle?.setPermissionMode(toPermissionMode(mode, opts.toolGate))
      },
    }
  }
}
