import { query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type { SlashCommandInfo } from '@ccc/shared/protocol'
import { findClaudeExecutable } from './kernel/infra/child-env.js'

// Enumerating slash commands depends on the working directory (a project's
// `.claude` adds project commands/skills). Cache per cwd for the process
// lifetime — the set rarely changes within a session and the lookup spawns a
// short-lived `claude` subprocess.
const cache = new Map<string, SlashCommandInfo[]>()

// Safety net: if the control request hangs (subprocess never initializes),
// fail instead of leaving the WS handler awaiting forever.
const LIST_TIMEOUT_MS = 10_000

/**
 * List the slash commands/skills available for `cwd`, as the CLI would show on
 * `/`. Uses a streaming-input `query()` whose prompt never yields a user
 * message, so the control-channel `supportedCommands()` resolves after the
 * subprocess init handshake **without** consuming a model turn. The query is
 * torn down immediately afterwards.
 */
export async function listCommands(cwd: string): Promise<SlashCommandInfo[]> {
  const cached = cache.get(cwd)
  if (cached) return cached

  // A prompt iterable that blocks until we release it — keeps the query in
  // streaming-input mode and prevents it from sending an end-of-input that
  // would wind the subprocess down before `supportedCommands()` resolves.
  let release: () => void = () => {}
  const idle = new Promise<void>((resolve) => {
    release = resolve
  })
  // Intentionally never yields: it keeps the query in streaming-input mode and
  // blocks until `release()`, so no user message (and no model turn) is sent.
  // eslint-disable-next-line require-yield
  async function* prompt(): AsyncGenerator<SDKUserMessage> {
    await idle
  }

  const claudePath = findClaudeExecutable()
  const q = query({
    prompt: prompt(),
    options: {
      cwd,
      // Same inheritance as a real run so the listed set matches what would
      // actually execute (ADR 0005): user + project commands/skills.
      settingSources: ['user', 'project'],
      ...(claudePath ? { pathToClaudeCodeExecutable: claudePath } : {}),
    },
  })

  try {
    const commands = await withTimeout(q.supportedCommands(), LIST_TIMEOUT_MS)
    const mapped: SlashCommandInfo[] = commands.map((c) => ({
      name: c.name,
      description: c.description,
      argumentHint: c.argumentHint,
      ...(c.aliases ? { aliases: c.aliases } : {}),
    }))
    cache.set(cwd, mapped)
    return mapped
  } finally {
    // Unblock the prompt generator so the query can complete, then interrupt to
    // be sure the subprocess is torn down. `interrupt()` may reject async when
    // the query already finished — swallow it (same pattern as claude.ts).
    release()
    try {
      const p = q.interrupt?.()
      if (p && typeof p.catch === 'function') p.catch(() => {})
    } catch {
      /* noop */
    }
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('listCommands timed out')), ms)
    p.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (e) => {
        clearTimeout(timer)
        reject(e instanceof Error ? e : new Error(String(e)))
      },
    )
  })
}
