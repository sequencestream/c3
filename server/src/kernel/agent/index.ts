import { query } from '@anthropic-ai/claude-agent-sdk'
import type { McpServerConfig, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type { PermissionMode, PromptImage, ServerToClient } from '@ccc/shared/protocol'
import { EMPTY_TURN_NOTICE } from '@ccc/shared/protocol'
import { installClaudeSdkWarningFilter } from './adapters/claude/sdk-warning-filter.js'

// Drop the SDK's benign `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED` warning (0.3.198+) that
// fires on every never-ask (`bypassPermissions`) query() and otherwise floods the
// log. Installed once here — this module owns every Claude `query()` call site.
installClaudeSdkWarningFilter()
import { stringifyToolResult } from '../../format.js'
import { addToolSession } from '../../sessions.js'
import { buildChildEnv, findClaudeExecutable } from '../infra/child-env.js'
import { isDegradableError, isSocketDisconnect } from '../agent-config/errors.js'
import { isSideEffectTool } from '../run/resume.js'
import { createSandboxWrapper } from '../sandbox/SandboxLauncher.js'
import {
  allow,
  createCanUseTool,
  deny,
  INTENT_DISALLOWED_TOOLS,
  type ConsensusAutoCtx,
  type PermissionRequestCtx,
} from '../permission/index.js'

/**
 * Tool names that the server marks as user-interaction tools. When the model calls
 * one of these, the server sets `isUserInteraction: true` on the emitted wire
 * events (`tool_use`, `tool_result`, `permission_request`), so the web can identify
 * interaction tools without maintaining a separate client-side allowlist.
 */
const USER_INTERACTION_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode'])

// Moved out of this file in server refactor 3/3 (ADR-0009), imported where needed:
//  - the permission gate (the `canUseTool` policy + tool-name constants +
//    `classifyIntentTool` / `withAnswers` / `registerPermissionResolver`) →
//    `kernel/permission/*`; the run loop below builds its gateway via
//    `createCanUseTool` and reuses `INTENT_DISALLOWED_TOOLS` (imported above).
//  - `isDegradableError` / `isSocketDisconnect` (error classification) →
//    `kernel/agent-config/errors.js`.
//  - the AS-R18/R19 socket auto-resume gate (`isSideEffectTool` /
//    `computeSideEffectPending` / `decideSocketResume`) → `kernel/run/resume.js`.

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

  push(text: string, images?: PromptImage[]): void {
    if (this.closed) return
    // With images, the SDK user message carries a content-block array (a leading
    // text block + one base64 `image` block per attachment) — the Anthropic
    // Messages content shape the underlying CLI forwards verbatim. Without images
    // it stays a plain string (the original team-turn path is untouched).
    const content =
      images && images.length > 0
        ? [
            { type: 'text', text },
            ...images.map((img) => ({
              type: 'image',
              source: { type: 'base64', media_type: img.mediaType, data: img.data },
            })),
          ]
        : text
    const msg = {
      type: 'user',
      message: { role: 'user', content },
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
  /**
   * Images attached to this turn's prompt (2026-06-16). Inlined as base64
   * `image` content blocks on the first streaming-input user message (see
   * {@link InputStream.push}). Omit / empty ⇒ a text-only turn. Subsequent
   * team-lead `pushInput` turns stay text-only.
   */
  images?: PromptImage[]
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
  /**
   * When true (external skills mounted), write-class tools skip the consensus
   * shortcut and go straight to a human permission_request (mount layer 2/3,
   * ADR-0017 §E). Default false.
   */
  skillWriteGuard?: boolean
  /**
   * The session id (a getter because the id may change on pending→real bind).
   * Only used when {@link onPermissionRequest} is set on the gateway; absent
   * ⇒ the gateway builds a no-op getter.
   */
  sessionId?: () => string
  /**
   * Optional callback invoked before a `permission_request` is sent to the
   * human. Receives the full {@link PermissionRequestCtx} including sessionId
   * and workspacePath. Forwarded to {@link createCanUseTool}.
   */
  onPermissionRequest?: (ctx: PermissionRequestCtx) => void
  /**
   * Optional callback for consensus auto-resolutions (the `consensus_auto` path —
   * no human prompt). Forwarded to {@link createCanUseTool} so the wiring layer can
   * record a non-blocking `status: 'auto'` WaitUserInvolveEvent for auditability.
   */
  onConsensusResolved?: (ctx: ConsensusAutoCtx) => void
  /**
   * Bind the in-process MCP server (the c3 intent tools) to THIS run. Called at
   * query construction with the live run id getter + abort signal; the project
   * path + gate deps are captured at the composition root. The `save_intents`
   * handler runs its OWN confirmation gate (`gatedSave`), so a vendor allow-rule
   * that pre-approves the tool — and therefore skips `canUseTool` — still raises a
   * human prompt. Absent ⇒ no in-process MCP (non-intent runs).
   */
  bindInProcessMcp?: (binding: {
    getRunId: () => string
    signal: AbortSignal
  }) => Record<string, McpServerConfig>
  /**
   * Permission gateway policy. `standard` (default) is the normal c3 flow
   * (consensus + human prompt). `intent` is the read-only communication
   * agent: read tools auto-allow, `save_intents` prompts the human, and
   * everything else is denied by default (a second line of defence behind
   * `disallowedTools`).
   */
  gate?: 'standard' | 'intent' | 'discussion-research' | 'spec'
  /**
   * Only with `gate === 'spec'`: the absolute spec directory this run's writes
   * are confined to. Forwarded to {@link createCanUseTool}; write-class tools
   * targeting a path outside it are denied (the project stays read-only).
   */
  specDir?: string
  /**
   * Sandbox container handle. When present, the vendor CLI binary is wrapped
   * to run inside the sandbox container via `docker exec`.
   */
  sandboxHandle?: import('../sandbox/types.js').SandboxHandle
  /**
   * Temp directory created by the sandbox launcher, used for wrapper scripts
   * and env files. Set alongside `sandboxHandle`.
   */
  sandboxTmpDir?: string
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
  /**
   * Optional callback invoked when the run encounters a degradable error
   * (rate-limit, session-limit, auth, or connection failure). The caller
   * may then retry with a different agent configuration.
   * When this callback fires, the run does NOT emit a terminal `turn_end` —
   * it returns normally so the caller can decide to retry. The caller is
   * responsible for emitting the appropriate events.
   * Absent ⇒ the error is treated as final and a `turn_end { error }` is
   * emitted as usual.
   */
  onDegradableError?: (error: string) => void
  /**
   * Optional callback invoked when the run hits a socket disconnect
   * ({@link isSocketDisconnect}). Like {@link onDegradableError} this run then
   * does NOT emit a terminal `turn_end` — it returns so the caller can decide
   * whether to auto-`resume` (AS-R18). `sideEffectPending` is the AS-R19 gate
   * verdict at disconnect time: when true, an unclosed write-class `tool_use`
   * was in flight, so the caller must refuse auto-resume and surface a manual
   * `turn_end { error }`. Absent ⇒ a socket disconnect is treated as any other
   * error (terminal `turn_end`), preserving the prior behaviour.
   */
  onSocketDisconnect?: (info: { error: string; sideEffectPending: boolean }) => void
  /**
   * True when this run is itself the single auto-`resume` attempt after a socket
   * disconnect (AS-R18). Stamps the turn's terminal `turn_end` with
   * `reconnect_attempted: true` + `retry_count` so the viewer/telemetry records
   * that the turn survived a reconnect. Absent ⇒ a normal first attempt.
   */
  reconnectAttempt?: boolean
}

/**
 * Tools blocked for {@link askOneShot}. The one-shot judge reasons purely over
 * the text handed to it (intent, last message, git diff), so every tool is
 * cut at the SDK level — and {@link askOneShot}'s `canUseTool` denies anything
 * that slips through. Keeps the judge deterministic and side-effect-free.
 */
const ONESHOT_DISALLOWED_TOOLS = [
  ...INTENT_DISALLOWED_TOOLS,
  'Read',
  'Grep',
  'Glob',
  'LS',
  'NotebookRead',
  'WebFetch',
  'WebSearch',
  'TaskCreate',
  'TaskList',
  'TaskUpdate',
  'TaskGet',
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
  agentId: string
  model?: string
  envOverrides?: Record<string, string>
  ownerKind?: 'intent' | 'discussion' | 'automation' | null
  ownerId?: string | null
  /**
   * The stable role/rules half of the judge prompt, delivered on the preset
   * system `append` so the per-turn `prompt` (the intent + evidence) stays the
   * variable user context — a cacheable system prefix across successive judge
   * calls. Omit ⇒ a bare claude_code preset (the prior behaviour).
   */
  systemInstruction?: string
}): Promise<string> {
  const claudePath = findClaudeExecutable()
  const q = query({
    prompt: opts.prompt,
    options: {
      cwd: opts.cwd,
      settingSources: ['user', 'project'],
      systemPrompt: {
        type: 'preset',
        preset: 'claude_code',
        ...(opts.systemInstruction ? { append: opts.systemInstruction } : {}),
      },
      disallowedTools: ONESHOT_DISALLOWED_TOOLS,
      permissionMode: 'default',
      ...(claudePath ? { pathToClaudeCodeExecutable: claudePath } : {}),
      ...(opts.envOverrides ? { env: { ...process.env, ...opts.envOverrides } } : {}),
      ...(opts.model ? { model: opts.model } : {}),
      canUseTool: async () => deny('one-shot judge is read-only'),
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
          addToolSession(sid, {
            workspacePath: opts.cwd,
            agentId: opts.agentId,
            ownerKind: opts.ownerKind ?? null,
            ownerId: opts.ownerId ?? null,
          })
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

/** The four SDK task-tool surfaces the {@link runTaskTool} executor can drive. */
export type TaskToolName = 'TaskCreate' | 'TaskList' | 'TaskUpdate' | 'TaskGet'

/** All four task tools — used to disable the three the executor is NOT driving. */
const ALL_TASK_TOOLS: readonly TaskToolName[] = ['TaskCreate', 'TaskList', 'TaskUpdate', 'TaskGet']

/**
 * Every non-task tool the executor hard-disables at the SDK level: the task
 * executor exists to invoke ONE task tool mechanically, so any side-effecting or
 * exploratory tool the model might otherwise reach for is cut. The remaining three
 * task tools are added per-call (all but the one being driven).
 */
const TASK_EXEC_DISALLOWED_TOOLS = [
  ...INTENT_DISALLOWED_TOOLS,
  'Read',
  'Grep',
  'Glob',
  'LS',
  'NotebookRead',
  'WebFetch',
  'WebSearch',
  'Bash',
  'Edit',
  'Write',
  'NotebookEdit',
  'Agent',
  'AskUserQuestion',
]

/** The text + error flag of a task tool's `tool_result`, the executor's raw output. */
export interface TaskToolOutput {
  content: string
  isError: boolean
}

/**
 * A natural-language description of the task op for the executor's prompt. It only
 * identifies the operation + target (subject / id); the exact input is forced via
 * `allow(input)`, so this needs no field-complete serialization (and avoids the
 * `JSON.stringify` ban under kernel/, ADR-0009 R2).
 */
function describeTaskOp(toolName: TaskToolName, input: Record<string, unknown>): string {
  switch (toolName) {
    case 'TaskCreate':
      return `Create a new task with subject "${String(input.subject ?? '')}".`
    case 'TaskUpdate':
      return `Update the task with id ${String(input.taskId ?? '')}.`
    case 'TaskGet':
      return `Get the task with id ${String(input.taskId ?? '')}.`
    case 'TaskList':
      return 'List all current tasks.'
  }
}

/**
 * Drive a SINGLE SDK task tool to completion and return its `tool_result` text.
 * This is the mechanism behind the Claude {@link
 * import('./adapters/claude/index.js').ClaudeTaskStore}: the SDK exposes no
 * programmatic single-tool entry point — a built-in tool runs only when the model
 * calls it inside a query — so the executor spins up a minimal one-shot query that
 * instructs the model to invoke exactly `toolName` with `input` and nothing else,
 * then captures the matching `tool_result`.
 *
 * Every other tool is disabled (`TASK_EXEC_DISALLOWED_TOOLS` + the three sibling
 * task tools), and `canUseTool` auto-allows only `toolName` with its forced input
 * — these are mechanical, side-effect-free task-list operations, not user-facing
 * tool decisions, so they bypass the c3 permission gateway. `resume` binds the run
 * to an existing SDK session so the task list it reads/writes is that session's.
 *
 * Best-effort by nature (the model may not comply, the run may abort): returns the
 * captured result, or `{ content: '', isError: true }` when none arrived. The
 * caller's parser degrades on that empty/error output rather than crashing.
 */
export async function runTaskTool(opts: {
  toolName: TaskToolName
  input: Record<string, unknown>
  cwd: string
  signal: AbortSignal
  model?: string
  envOverrides?: Record<string, string>
  /** Resume an existing SDK session so the task list is that session's. */
  resume?: string
}): Promise<TaskToolOutput> {
  const { toolName, input } = opts
  const claudePath = findClaudeExecutable()
  const disallowedTools = [
    ...TASK_EXEC_DISALLOWED_TOOLS,
    ...ALL_TASK_TOOLS.filter((t) => t !== toolName),
  ]
  // The prompt only has to nudge the model to call the right tool on the right
  // target; the exact, complete input is FORCED via `allow(input)` in canUseTool
  // below (updatedInput fully replaces whatever args the model passes). So the
  // prompt needs no JSON serialization (banned under kernel/ by ADR-0009 R2).
  const q = query({
    prompt: `${describeTaskOp(toolName, input)} Use the ${toolName} tool exactly once, then stop with no other action or commentary.`,
    options: {
      cwd: opts.cwd,
      settingSources: ['user', 'project'],
      systemPrompt: { type: 'preset', preset: 'claude_code' },
      disallowedTools,
      permissionMode: 'default',
      ...(opts.resume ? { resume: opts.resume } : {}),
      ...(claudePath ? { pathToClaudeCodeExecutable: claudePath } : {}),
      ...(opts.envOverrides ? { env: { ...process.env, ...opts.envOverrides } } : {}),
      ...(opts.model ? { model: opts.model } : {}),
      // Mechanical task-list op — auto-allow the one driven tool (forcing its
      // input), deny anything else that slips past `disallowedTools`.
      canUseTool: async (name: string) =>
        name === toolName ? allow(input) : deny(`task executor: only ${toolName} permitted`),
    },
  })
  let captured: TaskToolOutput | null = null
  try {
    for await (const m of q) {
      if (opts.signal.aborted) break
      if (m.type === 'user') {
        // The driven tool returns its result as a tool_result block on a
        // user-role message. Only one tool is allowed, so the first is ours.
        const content = (m as { message?: { content?: unknown[] } }).message?.content
        if (Array.isArray(content)) {
          for (const block of content) {
            const b = block as { type?: string; content?: unknown; is_error?: boolean }
            if (b.type === 'tool_result') {
              captured = { content: stringifyToolResult(b.content), isError: !!b.is_error }
            }
          }
        }
      } else if (m.type === 'result') {
        break
      }
    }
  } catch {
    /* return whatever was captured before the error (best-effort) */
  }
  return captured ?? { content: '', isError: true }
}

export async function runClaude(opts: RunOptions): Promise<void> {
  const {
    prompt,
    images,
    cwd,
    signal,
    permissionMode,
    resume,
    envOverrides,
    model,
    currentAgentId,
    appendSystemPrompt,
    disallowedTools,
    bindInProcessMcp,
    gate = 'standard',
    specDir,
    skillWriteGuard,
    send,
    onStart,
    onSessionId,
    onTeam,
    onDegradableError,
    onSocketDisconnect,
    reconnectAttempt,
  } = opts
  let reportedSessionId = false
  // Open side-effect tool_use ids (no tool_result yet) — the live mirror of
  // computeSideEffectPending, consulted only on a socket disconnect (AS-R19).
  const openSideEffects = new Set<string>()
  // Tracks tool_use ids whose tool is a user-interaction tool (AskUserQuestion,
  // ExitPlanMode). Carried to the matching `tool_result` emission so the wire
  // event consistently carries `isUserInteraction: true` on both frames.
  const userInteractionTools = new Set<string>()
  // The terminal `turn_end` reconnect telemetry, applied to every complete-path
  // turn_end this run emits (AS-R18). Empty for a normal first attempt.
  const reconnectFields = reconnectAttempt ? { reconnect_attempted: true, retry_count: 1 } : {}
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
  input.push(prompt, images)

  // Bind the in-process intent MCP server to THIS run (intent comm agent only).
  // The binder is supplied by the composition root with the project path + gate
  // deps; we supply the live run-id getter + abort signal at query-construction
  // time. `save_intents`'s confirmation gate lives in its handler (`gatedSave`),
  // not `canUseTool`, so it is immune to vendor pre-approval.
  const inProcessMcpServers = bindInProcessMcp?.({
    getRunId: opts.sessionId ?? (() => ''),
    signal,
  })

  // When sandbox is active, wrap the vendor binary to run inside the container
  const claudePath = opts.sandboxHandle
    ? createSandboxWrapper(
        opts.sandboxHandle,
        opts.sandboxTmpDir!,
        'claude',
        // IS_SANDBOX=1: the container IS the sandbox, so claude must allow
        // `--dangerously-skip-permissions` even though it runs as root inside the
        // image (without this claude aborts: "cannot be used with root/sudo
        // privileges"). Safe here precisely because the run is container-isolated.
        { ...buildChildEnv(envOverrides), IS_SANDBOX: '1' },
      )
    : findClaudeExecutable()
  // The SDK spawns the wrapper ON THE HOST, so `cwd` must be a real host dir.
  // `cwd` here is the run's worktree (`effectiveCwd`) — exactly the directory
  // bind-mounted into the container at /workspace. The CONTAINER working dir is
  // set independently by the wrapper's `docker exec -w /workspace`, and claude
  // (running in the container) reports /workspace to the model from its own
  // process cwd. Setting this to '/workspace' (a path that exists only inside the
  // container) made the host spawn fail with ENOENT — "native binary ... failed
  // to launch" — so always keep the host `cwd` here.
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
      // In-process MCP servers (the c3 intent tools). Bound to THIS run here:
      // `getRunId` reads the live id (`opts.sessionId`, the SAME getter the
      // gateway routes permission frames through, so a pending→real rebind lands
      // the save confirmation on the bound session); `signal` default-denies on
      // user stop. The save handler runs its own confirmation gate, so a vendor
      // allow-rule that skips `canUseTool` still raises a human prompt.
      ...(inProcessMcpServers ? { mcpServers: inProcessMcpServers } : {}),
      permissionMode,
      // Required by the SDK to permit switching into 'bypassPermissions' at any
      // point (start or via setPermissionMode). c3 remains the permission UI.
      allowDangerouslySkipPermissions: true,
      ...(claudePath ? { pathToClaudeCodeExecutable: claudePath } : {}),
      // Full child env: keepalive defaults < process.env < active-agent overrides
      // (buildChildEnv). Always set — even the system agent (no overrides) gets the
      // keepalive vars (the prevention layer against socket disconnects), while a
      // value the user/agent set explicitly still wins.
      env: buildChildEnv(envOverrides),
      ...(model ? { model } : {}),
      // The permission gateway — the SINGLE chokepoint (C-SEC). Every sensitive
      // tool flows through `createCanUseTool`; the run loop never inspects or mints
      // a verdict itself. `recentContext` is a getter because the message loop keeps
      // appending to the rolling context the consensus voters read.
      canUseTool: createCanUseTool({
        gate,
        // Only meaningful for the spec gate: confines write-class tools to this dir.
        specDir,
        // The producing run's SessionKind, mapped from THIS run's gate (the agent path
        // carries the gate, not a SessionKind): intent comm agent → 'intent', spec
        // write gate → 'spec', discussion-research → 'discussion' (never prompts, so
        // inert), the standard work session → 'work'. WorkCenter routes its 溯源跳转
        // off this verbatim, so a spec prompt no longer collapses to a session.
        sessionKind:
          gate === 'intent'
            ? 'intent'
            : gate === 'spec'
              ? 'spec'
              : gate === 'discussion-research'
                ? 'discussion'
                : 'work',
        send,
        signal,
        currentAgentId: currentAgentId ?? null,
        cwd,
        recentContext: () => recentContext,
        skillWriteGuard,
        sessionId: opts.sessionId ?? (() => ''),
        onPermissionRequest: opts.onPermissionRequest,
        onConsensusResolved: opts.onConsensusResolved,
      }),
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
              // Track unclosed write-class tool calls for the auto-resume gate
              // (AS-R19): a side-effect tool_use opens here, its tool_result
              // (below) closes it. If a socket disconnect fires while one is
              // open, auto-resume is refused.
              if (isSideEffectTool(b.name)) openSideEffects.add(b.id)
              const isUserInteraction = USER_INTERACTION_TOOLS.has(b.name)
              if (isUserInteraction) userInteractionTools.add(b.id)
              send({
                type: 'tool_use',
                toolUseId: b.id,
                toolName: b.name,
                input: b.input ?? {},
                ...(isUserInteraction ? { isUserInteraction: true } : {}),
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
              // The tool returned — close its side-effect gate entry (AS-R19).
              openSideEffects.delete(b.tool_use_id)
              const isUserInteraction = userInteractionTools.has(b.tool_use_id)
              send({
                type: 'tool_result',
                toolUseId: b.tool_use_id,
                content: stringifyToolResult(b.content),
                isError: !!b.is_error,
                ...(isUserInteraction ? { isUserInteraction: true } : {}),
              })
            }
          }
        }
      } else if (m.type === 'result') {
        // The run's turn finished — the session stays alive for the next prompt.
        // The result message also carries `usage` / `total_cost_usd` / rate-limit
        // info (the SDK 0.3.191 weekly per-model `model_scoped` + the 0.3.195
        // `seven_day_overage_included` rate-limit type are additive). c3 has no
        // product surface for cost/usage today, so we deliberately do not read
        // them here; consumed via `unknown` narrowing, missing or new fields stay
        // safe. Wire them into turn_end only when a UI needs them.
        sawResult = true
        // A turn that thought but said nothing (end_turn with no text/tool) would
        // otherwise render as an empty gap — indistinguishable from a hang. Surface
        // a muted notice so the viewer knows the turn ran and deliberately produced
        // no reply. Emit before `turn_end` so it lands inside the finished turn.
        if (!sawVisibleOutput) send({ type: 'notice', text: EMPTY_TURN_NOTICE })
        send({ type: 'turn_end', reason: 'complete', ...reconnectFields })
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
      const errorMsg = err instanceof Error ? err.message : String(err)
      // Socket disconnect (transport dropped mid-turn): checked BEFORE degradable
      // so the two classifiers stay strictly separate (a disconnect must never
      // enter the degradation chain). Signal the caller with the side-effect gate
      // verdict (AS-R19) and skip the terminal `turn_end` so it can decide whether
      // to auto-`resume` the same session (AS-R18).
      //
      // The SDK's `Query.reinitialize()` (0.3.195) re-sends the initialize control
      // request and redelivers pending permission/dialog prompts after a transport
      // gap — but it needs a SURVIVING query handle + a persistent transport (it is
      // for reattaching to a daemon whose ring buffer evicted frames). By the time
      // this branch fires the `for await` has already thrown, so `q` is abandoned;
      // c3 recovers by spawning a fresh `resume:<sessionId>` process instead. The
      // existing resume path already satisfies the auto-resume contract, so
      // reinitialize is not adopted (it would require keeping the handle alive).
      if (onSocketDisconnect && isSocketDisconnect(errorMsg)) {
        sawResult = true
        onSocketDisconnect({ error: errorMsg, sideEffectPending: openSideEffects.size > 0 })
        return
      }
      // Degradable error (rate-limit / session-limit / auth / connection):
      // signal the caller and skip the terminal `turn_end` so the caller can
      // retry with a different agent configuration.
      if (onDegradableError && isDegradableError(errorMsg)) {
        // Prevent the `finally` block from emitting a spurious turn_end.
        sawResult = true
        onDegradableError(errorMsg)
        // Return without emitting turn_end — the caller will retry or
        // emit the terminal event itself.
        return
      }
      send({
        type: 'turn_end',
        reason: 'error',
        error: errorMsg,
        ...reconnectFields,
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
      send({ type: 'turn_end', reason: 'complete', ...reconnectFields })
    }
  }
}
