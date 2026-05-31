import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { query } from '@anthropic-ai/claude-agent-sdk'
import type { McpServerConfig, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type {
  AskConsensusOutcome,
  ConsensusOutcome,
  PermissionMode,
  ServerToClient,
} from '@ccc/shared/protocol'
import { EMPTY_TURN_NOTICE } from '@ccc/shared/protocol'
import { waitForDecision, resolveDecision, type Decision } from './permissions.js'
import { runAskConsensus, runConsensusVote } from './consensus.js'
import { askQuestions } from './consensus-tally.js'
import { stringifyToolResult } from './format.js'
import { addToolSession } from './sessions.js'

// In a Bun-compiled binary the SDK's bundled `cli-<platform>` lookup misses
// (no node_modules to walk). Resolve `claude` from the host PATH and hand it
// to the SDK via pathToClaudeCodeExecutable. Override with CLAUDE_PATH.
let cachedClaudePath: string | null | undefined
export function findClaudeExecutable(): string | undefined {
  if (cachedClaudePath !== undefined) return cachedClaudePath ?? undefined
  if (process.env.CLAUDE_PATH) {
    cachedClaudePath = process.env.CLAUDE_PATH
    return cachedClaudePath
  }
  try {
    const r = spawnSync('sh', ['-c', 'command -v claude'], { encoding: 'utf-8' })
    const found = r.status === 0 ? r.stdout.trim() : ''
    cachedClaudePath = found || null
    return cachedClaudePath ?? undefined
  } catch {
    cachedClaudePath = null
    return undefined
  }
}

/** The c3 `save_requirements` MCP tool's fully-qualified name (server name `c3`). */
export const SAVE_REQUIREMENTS_TOOL = 'mcp__c3__save_requirements'

/**
 * Tools hard-disabled (SDK level) for the requirement-communication agent — the
 * source-of-truth read-only lock, paired with the requirement gate's
 * deny-by-default. `Bash` covers every shell sub-command, so it isn't enumerated.
 * `Task` and `SlashCommand` are essential: a spawned sub-agent's tool calls don't
 * pass through the parent `canUseTool`, and a slash command could run an
 * arbitrary skill — either would bypass the gateway, so both must be cut here.
 */
export const REQUIREMENT_DISALLOWED_TOOLS = [
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
  'Bash',
  'BashOutput',
  'KillShell',
  'Task',
  'SlashCommand',
]

/**
 * Read-only tools the requirement-communication agent may use without a prompt
 * ("read project material freely"). Anything not here — and not
 * `save_requirements` — is denied by the requirement gate (deny-by-default).
 */
const REQUIREMENT_READ_TOOLS = new Set([
  'Read',
  'Grep',
  'Glob',
  'LS',
  'NotebookRead',
  'WebFetch',
  'WebSearch',
  'TodoWrite',
])

export const registerPermissionResolver = {
  resolve(requestId: string, decision: Decision, answers?: Record<string, string>) {
    resolveDecision(requestId, decision, answers)
  },
}

/**
 * Inject `AskUserQuestion` answers into the tool input so the SDK echoes them as
 * the tool result (verified: the tool reads a pre-supplied `answers` map keyed by
 * question text). This is a deliberate, AskUserQuestion-only exception to the
 * gateway's "don't rewrite inputs" rule (PG-R6) — the only headless channel to
 * answer the prompt.
 */
export function withAnswers(
  input: unknown,
  answers: Record<string, string>,
): Record<string, unknown> {
  const base = (input ?? {}) as Record<string, unknown>
  const prior = (base.answers as Record<string, string> | undefined) ?? {}
  return { ...base, answers: { ...prior, ...answers }, annotations: base.annotations ?? {} }
}

/**
 * A controlled async-iterable prompt for the SDK's streaming-input mode. Unlike a
 * plain string prompt (which ends the query the moment a `result` arrives), this
 * keeps the query — and the underlying Claude Code process — alive until `close()`
 * is called. That is the prerequisite for agent teams: the lead process must stay
 * running to receive teammate notifications and be re-woken across turns.
 *
 * `push()` enqueues another user turn into the *same* live session (no resume, no
 * new process); `close()` ends the stream so the query terminates normally.
 */
class InputStream {
  private queue: SDKUserMessage[] = []
  private waiters: Array<(r: IteratorResult<SDKUserMessage>) => void> = []
  private closed = false

  push(text: string): void {
    if (this.closed) return
    const msg = {
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
    } as SDKUserMessage
    const waiter = this.waiters.shift()
    if (waiter) waiter({ value: msg, done: false })
    else this.queue.push(msg)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    let waiter
    while ((waiter = this.waiters.shift())) {
      waiter({ value: undefined as unknown as SDKUserMessage, done: true })
    }
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    for (;;) {
      const next = this.queue.shift()
      if (next) {
        yield next
        continue
      }
      if (this.closed) return
      const result = await new Promise<IteratorResult<SDKUserMessage>>((resolve) => {
        this.waiters.push(resolve)
      })
      if (result.done) return
      yield result.value
    }
  }
}

/**
 * Tools whose use means this session is (or is becoming) a persistent agent team
 * whose lead must stay alive: `TeamCreate` and `SendMessage` only exist in team
 * mode, and a background `Agent` (`run_in_background: true`) is a detached
 * teammate that reports back asynchronously. A plain (foreground) `Agent`
 * completes within the turn and does NOT keep the session alive.
 */
function isTeamTool(name: string, input: unknown): boolean {
  if (name === 'TeamCreate' || name === 'SendMessage') return true
  if (name === 'Agent') {
    return (input as { run_in_background?: unknown } | null)?.run_in_background === true
  }
  return false
}

/** Live controls for an in-flight run, handed to the caller via `onStart`. */
export interface RunHandle {
  setPermissionMode(mode: PermissionMode): Promise<void>
  /**
   * Feed another user turn into the live streaming session. Used for team
   * sessions, where the lead process stays alive and the next prompt must reach
   * the *same* process (not a fresh `resume` launch).
   */
  pushInput(text: string): void
}

export interface RunOptions {
  prompt: string
  /** Working directory for this run — the active workspace's path. */
  cwd: string
  signal: AbortSignal
  /** Permission mode to start the query in. */
  permissionMode: PermissionMode
  /**
   * Resume an existing SDK session by id. Omit for the first prompt of a new
   * session; the session id is reported via `onSessionId` once it exists.
   */
  resume?: string
  /**
   * Environment overrides for the spawned Claude Code process (e.g. the active
   * agent's ANTHROPIC_BASE_URL / ANTHROPIC_API_KEY). Merged over `process.env`.
   * Omit for the system agent — the SDK's default env resolution then applies.
   */
  envOverrides?: Record<string, string>
  /** Model alias/id override from the active agent. Omit ⇒ SDK default. */
  model?: string
  /**
   * The resolved agent id this session runs on. Excluded from consensus voting
   * (the other agents vote; this one decides/summarizes). Omit ⇒ no exclusion.
   */
  currentAgentId?: string
  /** Text appended to the `claude_code` preset system prompt (e.g. the comm agent role). */
  appendSystemPrompt?: string
  /** Tool names hard-disabled at the SDK level (the comm agent's read-only lock). */
  disallowedTools?: string[]
  /** In-process MCP servers to expose (e.g. the c3 `save_requirements` tool). */
  mcpServers?: Record<string, McpServerConfig>
  /**
   * Permission gateway policy. `standard` (default) is the normal c3 flow
   * (consensus + human prompt). `requirement` is the read-only communication
   * agent: read tools auto-allow, `save_requirements` prompts the human, and
   * everything else is denied by default (a second line of defence behind
   * `disallowedTools`).
   */
  gate?: 'standard' | 'requirement'
  send: (msg: ServerToClient) => void
  /** Called once the query is created so the caller can drive it mid-run. */
  onStart?: (handle: RunHandle) => void
  /** Called once with the SDK session id (from the `init` system message). */
  onSessionId?: (sessionId: string) => void
  /**
   * Called once when this run is detected to be a persistent agent team (the
   * first team tool is used). After this fires the run will NOT end on `result`
   * — the lead process stays alive until the run is aborted (user stop).
   */
  onTeam?: () => void
}

/**
 * Tools blocked for {@link askOneShot}. The one-shot judge reasons purely over
 * the text handed to it (requirement, last message, git diff), so every tool is
 * cut at the SDK level — and {@link askOneShot}'s `canUseTool` denies anything
 * that slips through. Keeps the judge deterministic and side-effect-free.
 */
const ONESHOT_DISALLOWED_TOOLS = [
  ...REQUIREMENT_DISALLOWED_TOOLS,
  'Read',
  'Grep',
  'Glob',
  'LS',
  'NotebookRead',
  'WebFetch',
  'WebSearch',
  'TodoWrite',
  'Agent',
  'AskUserQuestion',
]

/**
 * Run a single, tool-less prompt to completion and return the assistant's text.
 * Used by the automation orchestrator's completion judge: it has no UI viewer,
 * never emits wire events, and resolves with the concatenated assistant text
 * (best-effort — returns whatever was produced if the query errors). All tools
 * are disabled so the model answers from the prompt alone.
 */
export async function askOneShot(opts: {
  prompt: string
  cwd: string
  signal: AbortSignal
  model?: string
  envOverrides?: Record<string, string>
}): Promise<string> {
  const claudePath = findClaudeExecutable()
  const q = query({
    prompt: opts.prompt,
    options: {
      cwd: opts.cwd,
      settingSources: ['user', 'project'],
      systemPrompt: { type: 'preset', preset: 'claude_code' },
      disallowedTools: ONESHOT_DISALLOWED_TOOLS,
      permissionMode: 'default',
      ...(claudePath ? { pathToClaudeCodeExecutable: claudePath } : {}),
      ...(opts.envOverrides ? { env: { ...process.env, ...opts.envOverrides } } : {}),
      ...(opts.model ? { model: opts.model } : {}),
      canUseTool: async () => ({ behavior: 'deny', message: 'one-shot judge is read-only' }),
    },
  })
  let text = ''
  let sessionId = ''
  try {
    for await (const m of q) {
      if (opts.signal.aborted) break
      // Capture session_id from the first event and register it as a tool session.
      if (!sessionId) {
        const sid = (m as { session_id?: unknown }).session_id
        if (typeof sid === 'string' && sid) {
          sessionId = sid
          addToolSession(sid)
        }
      }
      if (m.type === 'assistant') {
        const content = (m as { message?: { content?: unknown[] } }).message?.content
        if (Array.isArray(content)) {
          for (const block of content) {
            const b = block as { type?: string; text?: string }
            if (b.type === 'text' && typeof b.text === 'string') text += b.text
          }
        }
      } else if (m.type === 'result') {
        break
      }
    }
  } catch {
    /* return whatever text was produced before the error */
  }
  return text.trim()
}

export async function runClaude(opts: RunOptions): Promise<void> {
  const {
    prompt,
    cwd,
    signal,
    permissionMode,
    resume,
    envOverrides,
    model,
    currentAgentId,
    appendSystemPrompt,
    disallowedTools,
    mcpServers,
    gate = 'standard',
    send,
    onStart,
    onSessionId,
    onTeam,
  } = opts
  let reportedSessionId = false
  // Once a team tool is seen the lead stays alive past `result` (streaming input
  // never auto-closes), so teammates can report back and re-wake the lead.
  let isTeam = false
  // Whether the SDK delivered a clean `result` (the normal turn-end signal). If the
  // iterator instead ends or the process exits without one, the `finally` below
  // synthesizes the terminal `turn_end` so the turn never stalls (see there).
  let sawResult = false
  // Whether the current turn emitted any *visible* output (assistant text or a
  // tool call). A thinking-only turn (the model thought, then ended with no text
  // or tool) leaves this false — the `result` branch then emits a `notice` so the
  // viewer sees a muted line rather than a silent gap. Reset per turn (a team
  // lead drives many turns in one process).
  let sawVisibleOutput = false
  // Rolling recent-context buffer (user prompt + assistant text) the consensus
  // voters reason over; capped so a long run doesn't bloat advisor prompts.
  let recentContext = prompt.slice(-4000)

  // Drive the SDK in streaming-input mode (an async-iterable prompt) rather than
  // a one-shot string. This is what lets a team lead's process outlive a single
  // `result` (see InputStream) and also enables live `setPermissionMode` /
  // `interrupt` (SDK control requests work only in streaming-input mode). The
  // first user turn is the original prompt; close() ends the session.
  const input = new InputStream()
  input.push(prompt)

  const claudePath = findClaudeExecutable()
  const q = query({
    prompt: input,
    options: {
      cwd,
      ...(resume ? { resume } : {}),
      // Inherit user (~/.claude) and project (.claude) settings — hooks, allow
      // rules, Skills, CLAUDE.md (ADR 0005). Tools not pre-decided by inherited
      // rules still flow through canUseTool below; c3 is the gateway, not the
      // sole authority.
      settingSources: ['user', 'project'],
      // Use Claude Code's full system prompt, including its dynamic sections —
      // the working directory, git status, and CLAUDE.md/auto-memory. Without
      // this the SDK 0.3.x default sends a bare prompt with no environment
      // context, so the model never learns the cwd (weaker models then guess it,
      // e.g. reporting the home dir). The `cwd` option still sets where tools
      // run; this is what *tells the model* about that directory.
      systemPrompt: {
        type: 'preset',
        preset: 'claude_code',
        ...(appendSystemPrompt ? { append: appendSystemPrompt } : {}),
      },
      // Hard tool lock (the comm agent's read-only set). Disabling here also
      // blocks harness-internal invocations the gateway never sees.
      ...(disallowedTools ? { disallowedTools } : {}),
      // In-process MCP servers (e.g. the c3 `save_requirements` tool).
      ...(mcpServers ? { mcpServers } : {}),
      permissionMode,
      // Required by the SDK to permit switching into 'bypassPermissions' at any
      // point (start or via setPermissionMode). c3 remains the permission UI.
      allowDangerouslySkipPermissions: true,
      ...(claudePath ? { pathToClaudeCodeExecutable: claudePath } : {}),
      // Active agent overrides. `env` must carry the full environment, so merge
      // over process.env rather than replace it. Omitted entirely for the system
      // agent (no overrides) so the SDK applies its own env resolution.
      ...(envOverrides ? { env: { ...process.env, ...envOverrides } } : {}),
      ...(model ? { model } : {}),
      canUseTool: async (toolName, input, _ctx) => {
        const requestId = randomUUID()

        // Requirement (read-only) gate: a separate, simpler policy that never
        // runs consensus. Read tools pass through; `save_requirements` asks the
        // human; everything else is denied by default (defence-in-depth behind
        // `disallowedTools`).
        if (gate === 'requirement') {
          if (REQUIREMENT_READ_TOOLS.has(toolName)) {
            return { behavior: 'allow', updatedInput: input }
          }
          if (toolName === SAVE_REQUIREMENTS_TOOL) {
            send({ type: 'permission_request', requestId, toolName, input })
            const { decision } = await waitForDecision(requestId, signal)
            if (decision === 'allow') {
              return { behavior: 'allow', updatedInput: input }
            }
            return { behavior: 'deny', message: 'User denied in c3 UI' }
          }
          // AskUserQuestion is a clarifying-only tool (no write/exec side effects),
          // so the read-only requirement agent may use it. It needs the standard
          // answer-injection flow — NOT a plain allow (the SDK echoes answers only
          // when `input.answers` is pre-filled). Single agent ⇒ no consensus: just
          // prompt the human and inject the answers (or deny on cancel).
          if (toolName === 'AskUserQuestion' && askQuestions(input)) {
            send({ type: 'permission_request', requestId, toolName, input })
            const { decision, answers } = await waitForDecision(requestId, signal)
            if (decision === 'allow') {
              return { behavior: 'allow', updatedInput: withAnswers(input, answers ?? {}) }
            }
            return { behavior: 'deny', message: 'User denied in c3 UI' }
          }
          console.warn(`[c3] requirement gate denied tool: ${toolName}`)
          return {
            behavior: 'deny',
            message: 'Requirement chat is read-only; this tool is blocked.',
          }
        }

        // AskUserQuestion is not an allow/deny tool — it needs an ANSWER per
        // question. Consensus voters answer each question; if they all agree on
        // every question we answer on the user's behalf, otherwise the human
        // fills the answer panel (agreed questions pre-filled). This branch runs
        // even with consensus disabled so the panel still renders and the answers
        // get injected (the base AskUserQuestion support).
        if (toolName === 'AskUserQuestion' && askQuestions(input)) {
          // The consensus pass spawns one advisor query() subprocess per voter plus
          // a decider — a multi-second window during which the tool-use stays
          // pending and the request is not yet visible to the human. It is fully
          // contained (the `.catch` ⇒ null) so an advisor error/slowness can never
          // abort or throw into the main run; the worst case is "no opinions, ask
          // the human" (the safe default). If the main run is nonetheless torn down
          // in this window, `waitForDecision` resolves to deny (below) and we log it
          // so the precise trigger can be confirmed in a live multi-agent setup.
          const ask: AskConsensusOutcome | null = await runAskConsensus({
            currentAgentId: currentAgentId ?? null,
            toolName,
            input,
            context: recentContext,
            cwd,
            signal,
          }).catch((err) => {
            console.warn(
              `[c3] runAskConsensus threw (deferring to human): ${
                err instanceof Error ? err.message : String(err)
              }`,
            )
            return null
          })
          if (ask && ask.fullyUnanimous) {
            send({ type: 'consensus_auto', toolName, input, outcome: ask })
            return { behavior: 'allow', updatedInput: withAnswers(input, ask.agreedAnswers) }
          }
          // The run was torn down *while* consensus ran: do NOT emit a
          // permission_request the human can never answer. It would linger in the
          // buffer as a dead "曾请求…" static line (the residue the fix forbids).
          // Deny straight away — the turn is already ending.
          if (signal.aborted) {
            console.warn(
              `[c3] AskUserQuestion ${requestId} aborted during the consensus window — ` +
                `skipping the unanswerable permission_request (consensus-window race)`,
            )
            return { behavior: 'deny', message: 'Run aborted during consensus' }
          }
          send(
            ask
              ? { type: 'permission_request', requestId, toolName, input, consensus: ask }
              : { type: 'permission_request', requestId, toolName, input },
          )
          const { decision, answers } = await waitForDecision(requestId, signal)
          if (decision === 'allow') {
            return { behavior: 'allow', updatedInput: withAnswers(input, answers ?? {}) }
          }
          // Distinguish a human "deny" from a run-teardown deny: the latter means an
          // AskUserQuestion prompt the user never answered was denied because the run
          // signal aborted during/after the consensus window — the race this log
          // exists to catch.
          if (signal.aborted) {
            console.warn(
              `[c3] AskUserQuestion ${requestId} denied by run abort before the human answered ` +
                `(consensus-window race) — tool=${toolName}`,
            )
          }
          return { behavior: 'deny', message: 'User denied in c3 UI' }
        }

        // Multi-agent consensus first (resolves to null when disabled, when there
        // are no other agents, or if the advisor queries throw).
        const outcome: ConsensusOutcome | null = await runConsensusVote({
          currentAgentId: currentAgentId ?? null,
          toolName,
          input,
          context: recentContext,
          cwd,
          signal,
        }).catch(() => null)
        // Unanimous ⇒ auto-resolve; surface how it was decided in the stream.
        if (outcome && outcome.unanimous && outcome.decision) {
          send({ type: 'consensus_auto', toolName, input, outcome })
          if (outcome.decision === 'allow') {
            return { behavior: 'allow', updatedInput: input }
          }
          return { behavior: 'deny', message: 'Denied by c3 multi-agent consensus' }
        }
        // Run torn down during the consensus window ⇒ skip the unanswerable prompt
        // (same residue guard as the AskUserQuestion branch above) and deny.
        if (signal.aborted) {
          return { behavior: 'deny', message: 'Run aborted during consensus' }
        }
        // Split / no consensus ⇒ ask the human, attaching the opinions (if any).
        const req: ServerToClient = outcome
          ? { type: 'permission_request', requestId, toolName, input, consensus: outcome }
          : { type: 'permission_request', requestId, toolName, input }
        send(req)
        const { decision } = await waitForDecision(requestId, signal)
        if (decision === 'allow') {
          return { behavior: 'allow', updatedInput: input }
        }
        return { behavior: 'deny', message: 'User denied in c3 UI' }
      },
    },
  })

  onStart?.({
    setPermissionMode: (mode) => q.setPermissionMode(mode),
    pushInput: (text) => {
      recentContext = `${recentContext}\n${text}`.slice(-4000)
      input.push(text)
    },
  })

  signal.addEventListener('abort', () => {
    // End the streaming input so the query loop terminates normally — this is the
    // only thing that stops a team session (its input never auto-closes).
    input.close()
    try {
      // interrupt() returns a Promise that rejects asynchronously (e.g.
      // "ProcessTransport is not ready for writing") when the query has already
      // finished or hasn't started streaming. A sync try/catch can't catch that,
      // so the rejection would crash the process — attach a .catch() to swallow it.
      const p = q.interrupt?.()
      if (p && typeof p.catch === 'function') p.catch(() => {})
    } catch {
      /* noop */
    }
  })

  try {
    for await (const m of q) {
      if (signal.aborted) break
      // The `init` system message (and `result`) carries the session id. Report
      // it once so the caller can bind a pending session and resume next turn.
      if (!reportedSessionId) {
        const sid = (m as { session_id?: unknown }).session_id
        if (typeof sid === 'string' && sid) {
          reportedSessionId = true
          onSessionId?.(sid)
        }
      }
      // Map SDK messages to wire protocol
      if (m.type === 'assistant') {
        const content = (m as { message?: { content?: unknown[] } }).message?.content
        if (Array.isArray(content)) {
          for (const block of content) {
            const b = block as {
              type?: string
              text?: string
              id?: string
              name?: string
              input?: unknown
            }
            if (b.type === 'text' && typeof b.text === 'string') {
              send({ type: 'assistant_text', text: b.text })
              sawVisibleOutput = true
              recentContext = `${recentContext}\n${b.text}`.slice(-4000)
            } else if (b.type === 'tool_use' && b.id && b.name) {
              // A team tool means the lead must outlive this turn. Detection
              // happens here, before the turn's `result`, so the fork below sees
              // it. Fires onTeam once.
              if (!isTeam && isTeamTool(b.name, b.input)) {
                isTeam = true
                onTeam?.()
              }
              send({
                type: 'tool_use',
                toolUseId: b.id,
                toolName: b.name,
                input: b.input ?? {},
              })
              sawVisibleOutput = true
            }
          }
        }
      } else if (m.type === 'user') {
        // user-role messages from SDK include tool_result blocks
        const content = (m as { message?: { content?: unknown[] } }).message?.content
        if (Array.isArray(content)) {
          for (const block of content) {
            const b = block as {
              type?: string
              tool_use_id?: string
              content?: unknown
              is_error?: boolean
            }
            if (b.type === 'tool_result' && b.tool_use_id) {
              send({
                type: 'tool_result',
                toolUseId: b.tool_use_id,
                content: stringifyToolResult(b.content),
                isError: !!b.is_error,
              })
            }
          }
        }
      } else if (m.type === 'result') {
        // The run's turn finished — the session stays alive for the next prompt.
        sawResult = true
        // A turn that thought but said nothing (end_turn with no text/tool) would
        // otherwise render as an empty gap — indistinguishable from a hang. Surface
        // a muted notice so the viewer knows the turn ran and deliberately produced
        // no reply. Emit before `turn_end` so it lands inside the finished turn.
        if (!sawVisibleOutput) send({ type: 'notice', text: EMPTY_TURN_NOTICE })
        send({ type: 'turn_end', reason: 'complete' })
        // Arm the next turn (a team lead reuses this process across turns).
        sawVisibleOutput = false
        // Non-team run: close the input so the query ends and the Claude Code
        // process exits (the one-shot behaviour — the next turn resumes a fresh
        // process). Team run: keep the input open so the lead process stays
        // alive to coordinate teammates; it ends only on abort (user stop).
        if (!isTeam) input.close()
      }
    }
  } catch (err) {
    if (!signal.aborted) {
      send({
        type: 'turn_end',
        reason: 'error',
        error: err instanceof Error ? err.message : String(err),
      })
    }
  } finally {
    // Terminal-state guarantee at the run-loop layer: the iterator can finish (or
    // the Claude process can exit) without ever delivering a `result` — e.g. it
    // died mid-turn. Then neither the `result` branch nor the `catch` fired, so no
    // `turn_end` reached the viewer. Synthesize one here (non-team, non-aborted) so
    // the turn always ends. A team lead's input stays open until abort, and an
    // aborted run is settled by the server's teardown, so both are skipped. The
    // server's `finalizeRun` is the outer backstop; `sawResult`/`sawTurnEnd` keep
    // the two from emitting a duplicate.
    if (!sawResult && !isTeam && !signal.aborted) {
      send({ type: 'turn_end', reason: 'complete' })
    }
  }
}
