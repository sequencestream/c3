/**
 * Cursor {@link AgentDriver} — one non-interactive `cursor-agent -p` run per turn.
 *
 * The CLI is the only runtime载体: c3 spawns it with `--output-format stream-json`,
 * reads NDJSON off stdout, and normalizes each frame through
 * {@link CursorStreamTranslator}. There is no bidirectional channel, so the whole
 * of c3's run-time control is "start it" and "stop it".
 *
 * **Process group.** The child is spawned `detached`, making it a group leader, so
 * `abort()` can signal the CLI *and* every tool it spawned. Killing only the direct
 * child would leave a long-running shell tool orphaned and still writing to the
 * workspace. Abort therefore signals the group and waits for the child to actually
 * exit before the run settles.
 *
 * **Session id.** `sessionId()` stays pending until the stream reports a real
 * native id (`system/init`). If the process dies or ends without one, the promise
 * **rejects**: a fabricated id would later be handed to `--resume`, which would
 * either fail confusingly or, worse, attach to someone else's chat.
 *
 * **Resume.** A c3 session that already owns a native id passes it verbatim to
 * `--resume`. Cursor's own store is the recovery truth; c3's canonical mirror is
 * only for listing and replay, and is refreshed from the new run's frames.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import type { AgentDriver, AgentRun, CanonicalMessage, DriverStartOptions } from '../types.js'
import { cursorCapabilities } from './capabilities.js'
import { CursorStreamTranslator, type CursorEvent } from './translate.js'
import { cursorExecArgs, cursorExecEnv, type CursorLaunchConfig } from './launch.js'
import { prepareCursorMcp } from './mcp.js'

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

/** How long to wait for a signalled process group to die before escalating. */
const SIGKILL_GRACE_MS = 5_000

/** Spawn seam, so tests can drive the driver without a real CLI. */
export type CursorSpawn = (
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; detached: boolean },
) => ChildProcessWithoutNullStreams

class CursorRun implements AgentRun {
  private readonly queue = new CanonicalQueue()
  private readonly translator: CursorStreamTranslator
  private readonly child: ChildProcessWithoutNullStreams
  /** Resolves once the child has fully exited — abort waits on this. */
  private readonly exited: Promise<void>
  private aborted = false
  private sawSessionId = false
  private resolveSid!: (id: string) => void
  private rejectSid!: (err: unknown) => void
  private readonly sidPromise: Promise<string>

  constructor(
    private readonly opts: DriverStartOptions,
    config: CursorLaunchConfig,
    spawnFn: CursorSpawn,
    private readonly cleanup: () => void = () => undefined,
  ) {
    this.translator = new CursorStreamTranslator(opts.resume ?? '')

    this.sidPromise = new Promise<string>((resolve, reject) => {
      this.resolveSid = resolve
      this.rejectSid = reject
    })
    // A resumed run already knows its native id; there is nothing to wait for.
    if (opts.resume) {
      this.sawSessionId = true
      this.resolveSid(opts.resume)
    }

    this.child = spawnFn(config.command, cursorExecArgs(opts, config), {
      cwd: opts.cwd,
      env: cursorExecEnv(opts, config),
      // Group leader: abort() signals the CLI and every tool it started.
      detached: true,
    })

    this.exited = new Promise<void>((resolve) => {
      this.child.once('close', () => resolve())
    })

    // The external signal is the run loop's abort path.
    opts.signal.addEventListener('abort', () => this.abort(), { once: true })

    void this.pump()
  }

  sessionId(): Promise<string> {
    return this.sidPromise
  }

  messages(): AsyncIterable<CanonicalMessage> {
    return this.queue
  }

  abort(): void {
    if (this.aborted) return
    this.aborted = true
    this.killGroup('SIGTERM')
    // Escalate if the group ignores the polite signal, then let the reader's
    // close handler settle the run — abort must not leave orphans behind.
    const escalate = setTimeout(() => this.killGroup('SIGKILL'), SIGKILL_GRACE_MS)
    void this.exited.finally(() => clearTimeout(escalate))
  }

  /** Signal the whole process group, falling back to the child alone. */
  private killGroup(signal: NodeJS.Signals): void {
    const pid = this.child.pid
    if (pid === undefined) return
    try {
      // Negative pid targets the group the detached child leads.
      process.kill(-pid, signal)
    } catch {
      try {
        this.child.kill(signal)
      } catch {
        /* already gone */
      }
    }
  }

  /** Read the stream to completion and settle the run exactly once. */
  private async pump(): Promise<void> {
    let stderr = ''
    this.child.stderr.setEncoding('utf8')
    this.child.stderr.on('data', (chunk: string) => {
      // Keep the tail only: stderr is diagnostics, not an unbounded buffer.
      stderr = (stderr + chunk).slice(-4_000)
    })

    let spawnError: Error | null = null
    this.child.once('error', (err: Error) => {
      spawnError = err
    })

    let protocolError: Error | null = null
    let ended: { isError: boolean; errorMessage?: string } | undefined

    try {
      // readline yields only complete lines and flushes a final unterminated one
      // at EOF, which is exactly the NDJSON framing the CLI produces.
      const rl = createInterface({ input: this.child.stdout, crlfDelay: Infinity })
      for await (const line of rl) {
        const trimmed = line.trim()
        if (!trimmed) continue

        let event: CursorEvent
        try {
          event = JSON.parse(trimmed) as CursorEvent
        } catch (err) {
          // A corrupt frame means the stream can no longer be trusted: fail the
          // turn loudly rather than silently skipping model output.
          protocolError = new Error(`cursor: unparseable stream frame: ${trimmed.slice(0, 200)}`, {
            cause: err,
          })
          break
        }

        const { messages, sessionId, ended: end } = this.translator.consume(event)
        if (sessionId && !this.sawSessionId) {
          this.sawSessionId = true
          this.resolveSid(sessionId)
        }
        for (const message of messages) this.queue.push(message)
        if (end) ended = end
      }
      rl.close()
    } catch (err) {
      protocolError ??= err instanceof Error ? err : new Error(String(err))
    }

    await this.exited
    const code = this.child.exitCode
    // The child has exited, so it no longer needs the injected MCP config;
    // restore the user's file now, regardless of how the turn settles.
    this.cleanup()

    // An id that never arrived must reject: inventing one would corrupt resume.
    // A run that could not identify itself is an error turn too — its message
    // stream fails rather than quietly draining to empty.
    if (!this.sawSessionId) {
      const reason = spawnError
        ? `cursor: failed to launch: ${spawnError.message}`
        : `cursor: run ended without reporting a session id${stderr ? ` — ${stderr.trim()}` : ''}`
      this.rejectSid(new Error(reason))
      // An aborted run settles quietly; any other no-id exit is an error turn.
      if (this.aborted) this.queue.close()
      else this.queue.fail(new Error(reason))
      return
    }

    if (this.aborted) {
      // The run loop treats an aborted turn as terminal on its own.
      this.queue.close()
      return
    }
    if (spawnError) {
      this.queue.fail(new Error(`cursor: failed to launch: ${(spawnError as Error).message}`))
      return
    }
    if (protocolError) {
      this.queue.fail(protocolError)
      return
    }
    if (ended?.isError) {
      this.queue.fail(new Error(ended.errorMessage ?? 'cursor run failed'))
      return
    }
    if (code !== 0 && code !== null) {
      this.queue.fail(
        new Error(`cursor exited with code ${code}${stderr ? `: ${stderr.trim()}` : ''}`),
      )
      return
    }
    this.queue.close()
  }
}

export class CursorDriver implements AgentDriver {
  readonly vendor = 'cursor' as const
  readonly capabilities = cursorCapabilities

  constructor(
    private readonly resolveConfig: (opts: DriverStartOptions) => CursorLaunchConfig,
    private readonly spawnFn: CursorSpawn = (command, args, options) =>
      spawn(command, args, options) as ChildProcessWithoutNullStreams,
  ) {}

  async start(opts: DriverStartOptions): Promise<AgentRun> {
    const config = this.resolveConfig(opts)
    // Inject c3's MCP servers into the config the CLI reads and confirm they are
    // visible before spending a run: a run that starts without tools it was
    // promised must hard-fail here, not mid-turn. The disposer restores the
    // user's config once the run settles.
    let cleanup: () => void = () => undefined
    if (opts.mcpServers && Object.keys(opts.mcpServers).length > 0 && config.home) {
      const { dispose } = prepareCursorMcp(
        config.home,
        opts.mcpServers,
        config.command,
        cursorExecEnv(opts, config),
        opts.cwd,
      )
      cleanup = dispose
    }
    return new CursorRun(opts, config, this.spawnFn, cleanup)
  }
}
