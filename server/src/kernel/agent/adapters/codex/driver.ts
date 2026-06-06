/**
 * Codex's {@link AgentDriver} (2026-06-06-005) — the read-only advisor seat
 * Phase 0 (008 NO-GO) pinned. Unlike Claude (per-run CLI with a blocking
 * `canUseTool`) or OpenCode (long-lived server with out-of-loop approval), Codex
 * is a one-shot non-interactive exec: `startThread` fixes the launch-time policy
 * (`sandboxMode` + `approvalPolicy`), `runStreamed` dispatches the prompt and
 * yields a **read-only** `AsyncGenerator<ThreadEvent>`, and the ONLY runtime
 * control is the whole-turn `AbortSignal`. There is no per-tool approval point
 * (stdin closes after dispatch), so the {@link CodexApprovalBridge} handler never
 * fires and `capabilities.perToolApproval` is false.
 *
 * A "run" here is: build a `Codex` over the neutral options → start (or resume) a
 * thread → translate the streamed items into the canonical stream → close when the
 * turn ends. Tool items are auto-allowed by the launch-time gate, so the
 * translator stamps them `preApproved: true` (the audit reconstruction).
 *
 * SDK boundary (testability): the `Codex` construction is injected via
 * {@link CodexFactory}, defaulting to the real `@openai/codex-sdk`. Tests inject a
 * fake that yields a scripted event stream — no Codex auth/binary needed (Phase 0
 * ran L1-only; live L2 is a later, authenticated step).
 *
 * ADR-0009: imports `@openai/codex-sdk` (inside `adapters/codex/`); only canonical
 * shapes leave via {@link AgentRun.messages}.
 */
import { Codex } from '@openai/codex-sdk'
import type { ApprovalMode, SandboxMode, ThreadEvent, ThreadOptions } from '@openai/codex-sdk'
import type {
  ActionMode,
  AgentDriver,
  AgentRun,
  CanonicalMessage,
  DriverStartOptions,
  ToolGate,
} from '../types.js'
import { codexCapabilities } from './capabilities.js'
import { itemToCanonical } from './translate.js'

/** The minimal structural face of a Codex thread the driver consumes (real `Thread` satisfies it). */
export interface CodexThread {
  readonly id: string | null
  runStreamed(
    input: string,
    turnOptions?: { signal?: AbortSignal },
  ): Promise<{ events: AsyncGenerator<ThreadEvent> }>
}

/** The minimal structural face of the `Codex` class (real `Codex` satisfies it). */
export interface CodexClient {
  startThread(options?: ThreadOptions): CodexThread
  resumeThread(id: string, options?: ThreadOptions): CodexThread
}

/** Codex constructor options the driver threads through (a neutral subset). */
export interface CodexFactoryOptions {
  baseUrl?: string
  apiKey?: string
  env?: Record<string, string>
}

/** Builds a {@link CodexClient}. Injected for tests; defaults to the real SDK. */
export type CodexFactory = (options: CodexFactoryOptions) => CodexClient

const defaultFactory: CodexFactory = (options) => new Codex(options) as unknown as CodexClient

/**
 * Translate the neutral {@link ActionMode} × {@link ToolGate} grid into Codex's
 * launch-time `sandboxMode` + `approvalPolicy`. This is the degraded substitute
 * for per-tool approval (008): there is no runtime asking, so the sandbox is the
 * REAL enforcement and `approvalPolicy` is best-effort (in non-interactive exec it
 * has no user channel). The mapping favours the tight side — `plan` and
 * `always-ask` (which Codex cannot honour live) both collapse to `read-only`.
 */
export function gateToCodexPolicy(
  actionMode: ActionMode,
  toolGate: ToolGate,
): { sandboxMode: SandboxMode; approvalPolicy: ApprovalMode } {
  // `plan` never executes changes ⇒ read-only regardless of gate.
  if (actionMode === 'plan') return { sandboxMode: 'read-only', approvalPolicy: 'on-request' }
  switch (toolGate) {
    case 'never-ask':
      return { sandboxMode: 'workspace-write', approvalPolicy: 'never' }
    case 'trusted-prefix':
      return { sandboxMode: 'workspace-write', approvalPolicy: 'on-failure' }
    case 'on-sensitive':
      return { sandboxMode: 'workspace-write', approvalPolicy: 'on-request' }
    case 'always-ask':
      // Codex cannot ask per-tool (008); the safe degrade is a read-only sandbox.
      return { sandboxMode: 'read-only', approvalPolicy: 'on-request' }
  }
}

/** Push/close/fail async-iterable buffer bridging the event pump into a pull stream. */
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

export class CodexDriver implements AgentDriver {
  readonly vendor = 'codex' as const
  readonly capabilities = codexCapabilities

  constructor(private readonly createCodex: CodexFactory = defaultFactory) {}

  async start(opts: DriverStartOptions): Promise<AgentRun> {
    const queue = new CanonicalQueue()

    // Internal abort owns the run; the external signal feeds it. The turn-level
    // AbortSignal is Codex's only runtime control (008).
    const controller = new AbortController()
    if (opts.signal.aborted) controller.abort()
    else opts.signal.addEventListener('abort', () => controller.abort(), { once: true })

    const codex = this.createCodex({ env: opts.envOverrides })
    const policy = gateToCodexPolicy(opts.actionMode, opts.toolGate)
    const threadOptions: ThreadOptions = {
      workingDirectory: opts.cwd,
      skipGitRepoCheck: true, // c3 may run in a non-git cwd; do not hard-fail the run.
      sandboxMode: policy.sandboxMode,
      approvalPolicy: policy.approvalPolicy,
      ...(opts.model ? { model: opts.model } : {}),
    }
    const thread = opts.resume
      ? codex.resumeThread(opts.resume, threadOptions)
      : codex.startThread(threadOptions)

    // sessionId resolves from `thread.started` (a new thread) or is known up-front
    // (a resume). Items always follow `thread.started`, so `sid` is set before them.
    let sid = opts.resume ?? ''
    let resolveSid: (id: string) => void = () => {}
    const sidPromise = opts.resume
      ? Promise.resolve(opts.resume)
      : new Promise<string>((r) => {
          resolveSid = r
        })

    const dispatch = (ev: ThreadEvent): void => {
      switch (ev.type) {
        case 'thread.started':
          sid = ev.thread_id
          resolveSid(ev.thread_id)
          break
        case 'item.started':
        case 'item.updated':
        case 'item.completed': {
          const msg = itemToCanonical(ev.item, sid || thread.id || '', Date.now())
          if (msg) queue.push(msg)
          break
        }
        case 'turn.failed':
          queue.fail(new Error(`codex turn failed: ${ev.error.message}`))
          break
        case 'error':
          queue.fail(new Error(`codex stream error: ${ev.message}`))
          break
        // turn.started / turn.completed: no canonical analogue; the generator
        // ending is the turn-end signal (handled in pump()).
      }
    }

    const pump = async (): Promise<void> => {
      try {
        const { events } = await thread.runStreamed(opts.prompt, { signal: controller.signal })
        for await (const ev of events) {
          if (controller.signal.aborted) break
          dispatch(ev)
        }
        queue.close()
      } catch (e) {
        queue.fail(e)
      } finally {
        resolveSid(sid) // never leave sessionId() hanging if the turn never started.
      }
    }
    void pump()

    return {
      sessionId: () => sidPromise,
      messages: () => queue,
      abort: () => {
        controller.abort()
        queue.close()
      },
    }
  }
}
