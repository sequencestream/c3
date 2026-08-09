/**
 * The `cursor-agent` process boundary — the one place in the cursor adapter that
 * spawns anything.
 *
 * A turn is one child process: argv and env in, a stream of NDJSON frames out,
 * an exit code as the final verdict. Everything about *what* to launch is decided
 * upstream in `launch.ts` and arrives here already shaped, so this module holds
 * no policy — only the mechanics of running a child and reading its stream
 * without losing frames, leaking processes, or turning a crash into silence.
 *
 * The seam exists for testing: the driver consumes {@link CursorCli}, so the main
 * suite injects a fake that scripts a frame sequence and never needs the binary,
 * a credential or a network hop.
 *
 * @module
 */

import { spawn } from 'node:child_process'
import readline from 'node:readline'
import type { CursorEvent } from './translate.js'

/** Everything one `cursor-agent` invocation needs. */
export interface CursorCliSpec {
  /** Absolute path to the binary, or the bare name to resolve through PATH. */
  readonly binary: string
  readonly argv: readonly string[]
  /** The child's complete environment — already merged, never a patch. */
  readonly env: Record<string, string>
  readonly cwd: string
  /**
   * The prompt. It goes on stdin rather than argv so that neither its length nor
   * its content can collide with option parsing.
   */
  readonly stdin: string
  readonly signal: AbortSignal
}

/** What minting a chat id needs — a launch without a turn. */
export interface CursorMintSpec {
  readonly binary: string
  readonly env: Record<string, string>
  readonly cwd: string
}

/** The spawn boundary. Tests substitute a scripted implementation. */
export interface CursorCli {
  run(spec: CursorCliSpec): AsyncGenerator<CursorEvent, void>
  /** Create an empty chat and return its id, so a run's identity precedes it. */
  createChat(spec: CursorMintSpec): Promise<string>
}

/**
 * Run one turn, yielding each frame as it arrives.
 *
 * Ordering matters throughout: stdin is closed immediately after the prompt is
 * written (the CLI waits for EOF before it starts), the exit code is only checked
 * once the stream is exhausted (a non-zero exit with frames already yielded still
 * has to surface as a failure), and stderr is buffered rather than parsed — it is
 * diagnostic text whose only job is to make that failure actionable.
 */
async function* spawnCursorCli(spec: CursorCliSpec): AsyncGenerator<CursorEvent, void> {
  const child = spawn(spec.binary, [...spec.argv], {
    cwd: spec.cwd,
    env: spec.env,
    signal: spec.signal,
  })

  // A spawn failure (a missing binary, a path that is not executable) surfaces as
  // an event rather than a throw, so it is captured here and re-thrown once the
  // stream has finished — otherwise it would be lost between the two.
  let spawnError: Error | null = null
  child.once('error', (err) => {
    spawnError = err
  })

  if (!child.stdin || !child.stdout) {
    child.kill()
    throw new Error('cursor-agent child process has no stdio')
  }
  child.stdin.write(spec.stdin)
  child.stdin.end()

  const stderrChunks: Buffer[] = []
  child.stderr?.on('data', (chunk: Buffer) => {
    stderrChunks.push(chunk)
  })

  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }))
  })

  const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity })
  try {
    for await (const line of rl) {
      const text = line.trim()
      if (!text) continue
      let frame: CursorEvent
      try {
        frame = JSON.parse(text) as CursorEvent
      } catch (err) {
        // The stream is the run's only report of what happened. A line that is not
        // a frame means the contract is broken, and continuing would silently
        // publish a partial transcript as if it were complete.
        throw new Error(`failed to parse cursor-agent JSON frame: ${text}`, { cause: err })
      }
      yield frame
    }

    if (spawnError) throw spawnError
    const exit = await exited
    if (exit.code !== 0 || exit.signal) {
      const detail = exit.signal ? `signal ${exit.signal}` : `code ${exit.code ?? 1}`
      const stderr = Buffer.concat(stderrChunks).toString('utf-8').trim()
      throw new Error(`cursor-agent exited with ${detail}${stderr ? `: ${stderr}` : ''}`)
    }
  } finally {
    rl.close()
    child.removeAllListeners()
    try {
      if (!child.killed) child.kill()
    } catch {
      /* best effort: the child may already be gone */
    }
  }
}

/** A chat id: the CLI prints exactly one, as a bare uuid on its own line. */
const CHAT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Mint the id a new run will own, before the run starts.
 *
 * Doing this up front is what lets a session's identity be known synchronously
 * rather than awaited from the stream: the id is bound, published and persisted
 * while the turn is still starting, and a turn that dies before its first frame
 * still leaves a session that can be listed and resumed.
 *
 * The output is validated rather than trusted. An id that is not a uuid would
 * flow into `--resume`, into c3's session store and into the on-disk path Cursor
 * derives from it, so a surprise here has to stop the launch instead of
 * propagating.
 */
async function createCursorChat(spec: CursorMintSpec): Promise<string> {
  const child = spawn(spec.binary, ['create-chat'], { cwd: spec.cwd, env: spec.env })
  const out: Buffer[] = []
  const err: Buffer[] = []
  child.stdout?.on('data', (chunk: Buffer) => out.push(chunk))
  child.stderr?.on('data', (chunk: Buffer) => err.push(chunk))

  const exit = await new Promise<{ code: number | null; error?: Error }>((resolve) => {
    child.once('error', (error) => resolve({ code: null, error }))
    child.once('exit', (code) => resolve({ code }))
  })

  const stderr = Buffer.concat(err).toString('utf-8').trim()
  if (exit.error) throw exit.error
  if (exit.code !== 0) {
    throw new Error(
      `cursor-agent create-chat exited with code ${exit.code}${stderr ? `: ${stderr}` : ''}`,
    )
  }

  const id = Buffer.concat(out).toString('utf-8').trim()
  if (!CHAT_ID_PATTERN.test(id)) {
    throw new Error(
      `cursor-agent create-chat did not return a chat id: ${id || stderr || '(no output)'}`,
    )
  }
  return id
}

/** The real binding. */
export const defaultCursorCli: CursorCli = { run: spawnCursorCli, createChat: createCursorChat }
