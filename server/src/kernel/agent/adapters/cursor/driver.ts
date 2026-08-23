/**
 * Cursor {@link AgentDriver} — one `cursor-agent` process per turn.
 *
 * A turn is: mint (or reuse) the chat id → build argv and env → spawn → translate
 * the NDJSON frames into the canonical stream → settle on the child's exit code.
 * The CLI is non-interactive by construction: the prompt goes in on stdin, stdin
 * closes, and what comes back is a one-directional stream. That shape is why
 * every live-run control in the capability ledger is false — there is no channel
 * to interrupt through, approve through, or push a second message through.
 *
 * **Session id.** Minted before the launch (`cursor-agent create-chat`) and passed
 * to the run with `--resume`, so `sessionId()` never pends and a turn that dies
 * before its first frame still leaves a listable, resumable session. The id is
 * Cursor's own, so it can never be a fabrication of c3's.
 *
 * **Abort.** The whole-turn kill: the abort signal goes to `spawn`, which
 * terminates the child. There is no mid-turn interrupt to reach for.
 *
 * @module
 */
import type { AgentDriver, AgentRun, CanonicalMessage, DriverStartOptions } from '../types.js'
import { cursorCapabilities } from './capabilities.js'
import { defaultCursorCli, type CursorCli } from './cli.js'
import { cleanupCursorMcpConfig, writeCursorMcpConfig, type CursorMcpConfig } from './mcp-config.js'
import { CursorStreamTranslator } from './translate.js'
import { resolve } from '../../process/launcher.js'
import {
  CursorUnsupportedError,
  cursorCliArgs,
  cursorCliEnv,
  cursorUserMessage,
  type CursorLaunchConfig,
} from './launch.js'

/** The binary name to fall back on when nothing has resolved a path. */
const CURSOR_BINARY = 'cursor-agent'

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

/** What the driver has resolved by the time a run can start. */
interface CursorRunLaunch {
  readonly binary: string
  readonly argv: string[]
  readonly env: Record<string, string>
  readonly cwd: string
  readonly stdin: string
  readonly sessionId: string
  /** The project MCP file this run wrote, to be undone when it ends. */
  readonly mcp: CursorMcpConfig | null
}

class CursorRun implements AgentRun {
  private readonly queue = new CanonicalQueue()
  private readonly translator: CursorStreamTranslator
  private readonly controller = new AbortController()
  private aborted = false
  /** Resolves once the child has exited and the workspace MCP config is restored. */
  readonly settled: Promise<void>
  /** Settles {@link CursorRun.settled} from `pump()`'s finally, on every exit path. */
  private settleResolve: (() => void) | null = null

  constructor(
    private readonly launch: CursorRunLaunch,
    private readonly cli: CursorCli,
    signal: AbortSignal,
  ) {
    this.translator = new CursorStreamTranslator(launch.sessionId)
    this.settled = new Promise((resolve) => {
      this.settleResolve = resolve
    })
    if (signal.aborted) this.abort()
    else signal.addEventListener('abort', () => this.abort(), { once: true })
    void this.pump()
  }

  sessionId(): Promise<string> {
    // Minted before the launch, so this never pends.
    return Promise.resolve(this.launch.sessionId)
  }

  messages(): AsyncIterable<CanonicalMessage> {
    return this.queue
  }

  abort(): void {
    if (this.aborted) return
    this.aborted = true
    this.controller.abort()
    this.queue.close()
  }

  /** Drive the turn to completion and settle the run exactly once. */
  private async pump(): Promise<void> {
    let ended: { isError: boolean; errorMessage?: string } | undefined
    try {
      const frames = this.cli.run({
        binary: this.launch.binary,
        argv: this.launch.argv,
        env: this.launch.env,
        cwd: this.launch.cwd,
        stdin: this.launch.stdin,
        signal: this.controller.signal,
      })
      for await (const frame of frames) {
        if (this.aborted) break
        const { messages, ended: end } = this.translator.consume(frame)
        for (const message of messages) this.queue.push(message)
        if (end) ended = end
      }

      if (this.aborted) return

      // The translator holds a text span open until something ends it. A stream
      // that stops without a terminal frame — the child dying quietly, a turn that
      // ends on prose — would otherwise drop the reply's last paragraph.
      for (const message of this.translator.flush().messages) this.queue.push(message)

      if (ended?.isError) {
        this.queue.fail(new Error(ended.errorMessage ?? 'cursor run failed'))
        return
      }
      this.queue.close()
    } catch (err) {
      // An aborted turn settles quietly: the child was killed on purpose, and the
      // non-zero exit that follows is a consequence of the caller's own decision.
      if (this.aborted) this.queue.close()
      else this.queue.fail(err)
    } finally {
      // However the turn ended, the workspace goes back the way it was found.
      cleanupCursorMcpConfig(this.launch.mcp)
      this.settleResolve?.()
    }
  }
}

export class CursorDriver implements AgentDriver {
  readonly vendor = 'cursor' as const
  readonly capabilities = cursorCapabilities

  constructor(
    private readonly resolveConfig: (opts: DriverStartOptions) => CursorLaunchConfig,
    private readonly cli: CursorCli = defaultCursorCli,
  ) {}

  async start(opts: DriverStartOptions): Promise<AgentRun> {
    const config = this.resolveConfig(opts)
    const env = cursorCliEnv(opts, config)
    const binary = opts.sandboxWrapperPath ?? resolve('cursor') ?? CURSOR_BINARY

    if (opts.images && opts.images.length > 0) {
      // The CLI takes no image input. Dropping them loudly beats failing the turn
      // over an attachment, and beats passing a prompt that silently refers to
      // pictures the model was never given.
      console.warn(
        `[c3] cursor: dropped ${opts.images.length} image(s) — cursor-agent accepts no image input`,
      )
    }
    const sessionId = opts.resume ?? (await this.mintChatId(binary, env, opts.cwd))
    // Written before the launch and undone when the turn ends: the CLI reads the
    // project file at startup, so it has to be in place before the child exists.
    const mcp = writeCursorMcpConfig(opts.cwd, opts.mcpServers)

    return new CursorRun(
      {
        binary,
        argv: cursorCliArgs(opts, sessionId),
        env,
        cwd: opts.cwd,
        stdin: cursorUserMessage(opts),
        sessionId,
        mcp,
      },
      this.cli,
      opts.signal,
    )
  }

  /**
   * Mint the run's id, translating a mint failure into an actionable one. If the
   * CLI cannot create a chat it cannot run a turn either, so failing here — before
   * a turn is spent — is the better of the two failures.
   */
  private async mintChatId(
    binary: string,
    env: Record<string, string>,
    cwd: string,
  ): Promise<string> {
    try {
      return await this.cli.createChat({ binary, env, cwd })
    } catch (err) {
      throw new CursorUnsupportedError(
        `cursor: could not start a session — ${(err as Error).message}. Check that cursor-agent is installed and signed in (\`cursor-agent login\`), or set an API key on this agent.`,
      )
    }
  }
}
