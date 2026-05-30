import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { query } from '@anthropic-ai/claude-agent-sdk'
import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk'
import type {
  AskConsensusOutcome,
  ConsensusOutcome,
  PermissionMode,
  ServerToClient,
} from '@ccc/shared/protocol'
import { waitForDecision, resolveDecision, type Decision } from './permissions.js'
import { runAskConsensus, runConsensusVote } from './consensus.js'
import { askQuestions } from './consensus-tally.js'
import { stringifyToolResult } from './format.js'

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
function withAnswers(input: unknown, answers: Record<string, string>): Record<string, unknown> {
  const base = (input ?? {}) as Record<string, unknown>
  const prior = (base.answers as Record<string, string> | undefined) ?? {}
  return { ...base, answers: { ...prior, ...answers }, annotations: base.annotations ?? {} }
}

/** Live controls for an in-flight run, handed to the caller via `onStart`. */
export interface RunHandle {
  setPermissionMode(mode: PermissionMode): Promise<void>
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
  } = opts
  let reportedSessionId = false
  // Rolling recent-context buffer (user prompt + assistant text) the consensus
  // voters reason over; capped so a long run doesn't bloat advisor prompts.
  let recentContext = prompt.slice(-4000)

  const claudePath = findClaudeExecutable()
  const q = query({
    prompt,
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
          const ask: AskConsensusOutcome | null = await runAskConsensus({
            currentAgentId: currentAgentId ?? null,
            toolName,
            input,
            context: recentContext,
            cwd,
            signal,
          }).catch(() => null)
          if (ask && ask.fullyUnanimous) {
            send({ type: 'consensus_auto', toolName, input, outcome: ask })
            return { behavior: 'allow', updatedInput: withAnswers(input, ask.agreedAnswers) }
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
  })

  signal.addEventListener('abort', () => {
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
              recentContext = `${recentContext}\n${b.text}`.slice(-4000)
            } else if (b.type === 'tool_use' && b.id && b.name) {
              send({
                type: 'tool_use',
                toolUseId: b.id,
                toolName: b.name,
                input: b.input ?? {},
              })
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
        send({ type: 'turn_end', reason: 'complete' })
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
  }
}
