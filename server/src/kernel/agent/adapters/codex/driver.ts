/**
 * Codex's {@link AgentDriver} (2026-06-06-005) — the read-only advisor seat
 * Phase 0 (008 NO-GO) pinned. Unlike Claude (per-run CLI with a blocking
 * `canUseTool`), Codex
 * is a one-shot non-interactive exec: c3 spawns `codex exec --experimental-json`,
 * fixes the launch-time policy (`sandboxMode` + `approvalPolicy`), dispatches the
 * prompt on stdin, and yields a **read-only** `AsyncGenerator<ThreadEvent>`. The
 * ONLY runtime control is the whole-turn `AbortSignal`. There is no per-tool
 * approval point (stdin closes after dispatch), so the {@link CodexApprovalBridge}
 * handler never fires and `capabilities.perToolApproval` is false.
 *
 * A "run" here is: build a Codex CLI client over the neutral options → start (or
 * resume) a thread → translate the streamed items into the canonical stream →
 * close when the turn ends. Tool items are auto-allowed by the launch-time gate, so the
 * translator stamps them `preApproved: true` (the audit reconstruction).
 *
 * Process boundary (testability): the Codex client construction is injected via
 * {@link CodexFactory}, defaulting to c3's minimal CLI wrapper. Tests inject a
 * fake that yields a scripted event stream — no Codex auth/binary needed for the
 * main L1 suite.
 *
 * Vendor-type containment: imports `@openai/codex-sdk` types (inside
 * `adapters/codex/`); only canonical shapes leave via {@link AgentRun.messages}.
 * SDK types never cross the adapter boundary.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import readline from 'node:readline'
import type { ApprovalMode, SandboxMode, ThreadEvent, ThreadOptions } from '@openai/codex-sdk'
import type {
  ActionMode,
  AgentDriver,
  AgentRun,
  CanonicalMessage,
  DriverStartOptions,
  RemoteMcpServer,
  ToolGate,
} from '../types.js'
import type { CodexPolicy } from '@ccc/shared/protocol'
import { codexCapabilities } from './capabilities.js'
import { itemToCanonical } from './translate.js'
import { CODEX_RELAY_PROVIDER, type Relay } from '../../../relay/contract.js'
import { writeImageTempFiles, cleanupImageTempFiles, type ImageTempFiles } from './image-files.js'
import {
  writeModelCatalogFile,
  cleanupModelCatalogFile,
  type ModelCatalogFile,
} from './model-catalog.js'
import { resolve } from '../../process/launcher.js'
import { withLoopbackNoProxy } from '../../../infra/no-proxy.js'
import {
  resolveGitCommonDir as resolveGitCommonDirDefault,
  type GitCommonDirResolver,
} from './git-meta.js'
import {
  bindCodexChildThread,
  describeCodexChildOutcome,
  describeCodexOccupantRefusal,
  describeCodexReclaimFailure,
  escalateKill,
  findCodexChildrenByThread,
  getCodexProcessSignals,
  logCodexChildSpawn,
  logCodexChildSettled,
  logCodexReclaim,
  logCodexSessionChildren,
  readProcessStartTime,
  recordCodexDescendants,
  reclaimCodexOccupant,
  registerCodexChild,
  settleCodexChild,
  type CodexChildOutcome,
} from './process-registry.js'
import { runErrMsg } from '../../../run/run-log.js'

const INTENT_MCP_TOOL_NAMES = ['find_intents', 'view_intent', 'save_intents'] as const

/**
 * One input item for a codex turn (2026-06-16). Mirrors the codex SDK's
 * `UserInput` union: a text segment, or a `local_image` referencing an
 * on-disk path (the CLI's `--image <FILE>`). c3 builds these from the neutral
 * prompt + {@link writeImageTempFiles}.
 */
export type CodexUserInput = { type: 'text'; text: string } | { type: 'local_image'; path: string }

/** A codex turn input: a plain prompt string, or a mixed text/image item list. */
export type CodexInput = string | CodexUserInput[]

/** The minimal structural face of a Codex thread the driver consumes. */
export interface CodexThread {
  readonly id: string | null
  runStreamed(
    input: CodexInput,
    turnOptions?: { signal?: AbortSignal },
  ): Promise<{ events: AsyncGenerator<ThreadEvent> }>
  /**
   * Terminal outcome of the child backing the most recent `runStreamed`
   * (2026-09-29-004), so the turn error can carry the pid and how it was
   * reclaimed. Optional: an in-process/fake thread has no child to report.
   */
  lastChildOutcome?(): CodexChildOutcome | null
}

/** The minimal structural face of the Codex client. */
export interface CodexClient {
  startThread(options?: ThreadOptions): CodexThread
  resumeThread(id: string, options?: ThreadOptions): CodexThread
}

/** Codex constructor options the driver threads through (a neutral subset). */
export interface CodexFactoryOptions {
  codexPathOverride?: string
  baseUrl?: string
  apiKey?: string
  env?: Record<string, string>
  /** `--config key=value` overrides (flattened by the SDK). Used to define the relay provider. */
  config?: Record<string, unknown>
}

/** Builds a {@link CodexClient}. Injected for tests; defaults to the real SDK. */
export type CodexFactory = (options: CodexFactoryOptions) => CodexClient

interface CodexMcpServerConfig {
  url: string
  enabled: true
  required: true
  enabled_tools: readonly string[]
  default_tools_approval_mode: 'approve'
  bearer_token_env_var?: string
}

type CodexConfigValue =
  string | number | boolean | CodexConfigValue[] | { [key: string]: CodexConfigValue | undefined }

const defaultFactory: CodexFactory = (options) => new CliCodexClient(options)

class CliCodexClient implements CodexClient {
  constructor(private readonly options: CodexFactoryOptions) {}

  startThread(options?: ThreadOptions): CodexThread {
    return new CliCodexThread(this.options, options)
  }

  resumeThread(id: string, options?: ThreadOptions): CodexThread {
    return new CliCodexThread(this.options, options, id)
  }
}

class CliCodexThread implements CodexThread {
  private threadId: string | null
  private lastOutcome: CodexChildOutcome | null = null

  constructor(
    private readonly options: CodexFactoryOptions,
    private readonly threadOptions?: ThreadOptions,
    id: string | null = null,
  ) {
    this.threadId = id
  }

  get id(): string | null {
    return this.threadId
  }

  lastChildOutcome(): CodexChildOutcome | null {
    return this.lastOutcome
  }

  async runStreamed(
    input: CodexInput,
    turnOptions?: { signal?: AbortSignal },
  ): Promise<{ events: AsyncGenerator<ThreadEvent> }> {
    return { events: this.run(input, turnOptions?.signal) }
  }

  private async *run(input: CodexInput, signal?: AbortSignal): AsyncGenerator<ThreadEvent> {
    // Split the neutral input into the stdin prompt text and the `--image` paths.
    // codex exec reads the prompt on stdin and takes each image as a CLI path
    // (`-i/--image <FILE>`), so the two travel different channels.
    const { text, imagePaths } = normalizeCodexInput(input)
    const args = codexExecArgs(this.options, this.threadOptions, this.threadId, imagePaths)
    const child = spawn(this.options.codexPathOverride ?? 'codex', args, {
      env: codexExecEnv(this.options),
      signal,
    })
    // Observability (2026-09-29-004): remember what we spawned, keyed by thread,
    // before any event flows. The start time is read from the host process table so
    // a later pid match can prove the process is ours and not a recycled pid.
    const pid = child.pid ?? null
    if (pid !== null) {
      const startTimeMs = await readProcessStartTime(pid)
      logCodexChildSpawn(
        registerCodexChild({ pid, threadId: this.threadId, spawnedAt: Date.now(), startTimeMs }),
      )
    }
    let spawnError: Error | null = null
    child.once('error', (err) => {
      spawnError = err
    })
    const stderrChunks: Buffer[] = []
    child.stderr?.on('data', (data: Buffer) => {
      stderrChunks.push(data)
    })
    const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolveExit) => {
        child.once('exit', (code, exitSignal) => resolveExit({ code, signal: exitSignal }))
      },
    )
    let rl: readline.Interface | null = null

    try {
      if (!child.stdin) throw new Error('Codex child process has no stdin')
      child.stdin.write(text)
      child.stdin.end()
      if (!child.stdout) throw new Error('Codex child process has no stdout')
      rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity })
      for await (const line of rl) {
        let parsed: ThreadEvent
        try {
          parsed = JSON.parse(line) as ThreadEvent
        } catch (err) {
          throw new Error(`Failed to parse codex JSON event: ${line}`, { cause: err })
        }
        if (parsed.type === 'thread.started') {
          this.threadId = parsed.thread_id
          if (pid !== null) bindCodexChildThread(pid, parsed.thread_id)
        }
        yield parsed
      }
      if (spawnError) throw spawnError
      const exit = await exitPromise
      if (exit.code !== 0 || exit.signal) {
        const detail = exit.signal ? `signal ${exit.signal}` : `code ${exit.code ?? 1}`
        throw new Error(
          `Codex Exec exited with ${detail}: ${Buffer.concat(stderrChunks).toString('utf8')}`,
        )
      }
    } finally {
      rl?.close()
      // Guaranteed teardown (2026-09-29-004): a stream error, a parse error, a
      // non-zero exit and a user abort all land here. A child that already exited is
      // a no-op; a survivor is SIGTERM'd, escalated to SIGKILL after the grace
      // period, and its outcome recorded so the turn error can name the pid. The
      // child's descendants are reaped too — see settleChildLifecycle.
      if (pid !== null) {
        this.lastOutcome = await settleChildLifecycle(child, pid, exitPromise, this.threadId)
        const record = settleCodexChild(pid, this.lastOutcome)
        if (record) logCodexChildSettled(record)
      }
      child.removeAllListeners()
    }
  }
}

/**
 * Determine how a spawned Codex child ended, reclaiming it when it survived its
 * turn. An already-exited child is recorded as such without signalling; a survivor
 * goes through the shared escalation helper.
 */
async function settleChildLifecycle(
  child: ChildProcess,
  pid: number,
  exitPromise: Promise<{ code: number | null; signal: NodeJS.Signals | null }>,
  threadId: string | null,
): Promise<CodexChildOutcome> {
  const signals = getCodexProcessSignals()
  // The spawned child is only the head of the turn: under a sandbox wrapper it runs
  // the vendor CLI inside itself, and the lock holder is a descendant. Record that
  // subtree while it is still traceable and terminate it leaves-first — killing the
  // head alone reparents the rest, and a reparented survivor keeps the writer lock
  // with no way left to prove it is ours.
  const descendants = await recordCodexDescendants(pid, threadId)
  // `descendants` is nearest-first; kill it in reverse so no parent is left to
  // re-spawn or outlive its children between signals.
  for (const descendant of [...descendants].reverse()) {
    const escalation = await escalateKill(descendant.pid, { signals })
    const record = settleCodexChild(descendant.pid, {
      pid: descendant.pid,
      exitCode: null,
      signal: null,
      reclaimedBy: escalation.method,
      waitedMs: escalation.waitedMs,
      reason: escalation.reason,
    })
    if (record) logCodexChildSettled(record)
  }
  if (child.exitCode === null && child.signalCode === null) {
    // A child that is exiting right now is reaped momentarily; give it that beat so
    // escalation does not race the OS and report a spurious SIGKILL.
    await Promise.race([exitPromise, signals.sleep(250)])
  }
  if (child.exitCode === null && child.signalCode === null) {
    const escalation = await escalateKill(pid, { signals })
    return {
      pid,
      exitCode: null,
      signal: null,
      reclaimedBy: escalation.method,
      waitedMs: escalation.waitedMs,
      reason: escalation.reason,
    }
  }
  return {
    pid,
    exitCode: child.exitCode,
    signal: child.signalCode,
    reclaimedBy: 'already-exited',
  }
}

/**
 * Fold a {@link CodexInput} into the two channels codex exec uses: the prompt
 * `text` (sent on stdin) and the `imagePaths` (each becomes `--image <path>`).
 * A bare string is all-text, no images. Multiple text items are newline-joined.
 */
function normalizeCodexInput(input: CodexInput): { text: string; imagePaths: string[] } {
  if (typeof input === 'string') return { text: input, imagePaths: [] }
  const texts: string[] = []
  const imagePaths: string[] = []
  for (const item of input) {
    if (item.type === 'text') texts.push(item.text)
    else imagePaths.push(item.path)
  }
  return { text: texts.join('\n'), imagePaths }
}

function codexExecArgs(
  options: CodexFactoryOptions,
  threadOptions: ThreadOptions | undefined,
  threadId: string | null,
  imagePaths: string[] = [],
): string[] {
  const args = ['exec', '--experimental-json']
  for (const override of serializeConfigOverrides(options.config)) {
    args.push('--config', override)
  }
  // Attached images: each rides as a `--image <FILE>` exec option. Paths point at
  // the per-turn temp files the driver wrote (cleaned up when the turn ends).
  for (const path of imagePaths) args.push('--image', path)
  if (options.baseUrl) args.push('--config', `openai_base_url=${toTomlValue(options.baseUrl)}`)
  if (threadOptions?.model) args.push('--model', threadOptions.model)
  if (threadOptions?.sandboxMode) args.push('--sandbox', threadOptions.sandboxMode)
  if (threadOptions?.workingDirectory) args.push('--cd', threadOptions.workingDirectory)
  for (const dir of threadOptions?.additionalDirectories ?? []) args.push('--add-dir', dir)
  if (threadOptions?.skipGitRepoCheck) args.push('--skip-git-repo-check')
  if (threadOptions?.modelReasoningEffort) {
    args.push(
      '--config',
      `model_reasoning_effort=${toTomlValue(threadOptions.modelReasoningEffort)}`,
    )
  }
  if (threadOptions?.networkAccessEnabled !== undefined) {
    args.push(
      '--config',
      `sandbox_workspace_write.network_access=${threadOptions.networkAccessEnabled}`,
    )
  }
  if (threadOptions?.webSearchMode) {
    args.push('--config', `web_search=${toTomlValue(threadOptions.webSearchMode)}`)
  } else if (threadOptions?.webSearchEnabled === true) {
    args.push('--config', 'web_search="live"')
  } else if (threadOptions?.webSearchEnabled === false) {
    args.push('--config', 'web_search="disabled"')
  }
  if (threadOptions?.approvalPolicy) {
    args.push('--config', `approval_policy=${toTomlValue(threadOptions.approvalPolicy)}`)
  }
  if (threadId) args.push('resume', threadId)
  return args
}

function codexExecEnv(options: CodexFactoryOptions): Record<string, string> {
  const env: Record<string, string> = {}
  if (options.env) Object.assign(env, options.env)
  else
    for (const [key, value] of Object.entries(process.env))
      if (value !== undefined) env[key] = value
  if (!env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE) env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE = 'c3'
  if (options.apiKey) env.CODEX_API_KEY = options.apiKey
  return env
}

function serializeConfigOverrides(config: Record<string, unknown> | undefined): string[] {
  if (!config) return []
  const out: string[] = []
  flattenConfig(config, '', out)
  return out
}

function flattenConfig(value: unknown, prefix: string, out: string[]): void {
  if (!isConfigObject(value)) {
    if (!prefix) throw new Error('Codex config overrides must be a plain object')
    out.push(`${prefix}=${toTomlValue(asConfigValue(value), prefix)}`)
    return
  }
  const entries = Object.entries(value)
  if (!prefix && entries.length === 0) return
  if (prefix && entries.length === 0) {
    out.push(`${prefix}={}`)
    return
  }
  for (const [key, child] of entries) {
    if (!key) throw new Error('Codex config override keys must be non-empty strings')
    if (child === undefined) continue
    const path = prefix ? `${prefix}.${key}` : key
    if (isConfigObject(child)) flattenConfig(child, path, out)
    else out.push(`${path}=${toTomlValue(asConfigValue(child), path)}`)
  }
}

function toTomlValue(value: CodexConfigValue, path = 'config'): string {
  if (typeof value === 'string') return quoteTomlString(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`Codex config override at ${path} must be finite`)
    return String(value)
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (Array.isArray(value)) return `[${value.map((item) => toTomlValue(item, path)).join(', ')}]`
  const parts: string[] = []
  for (const [key, child] of Object.entries(value)) {
    if (!key) throw new Error('Codex config override keys must be non-empty strings')
    if (child === undefined) continue
    parts.push(`${formatTomlKey(key)} = ${toTomlValue(child, `${path}.${key}`)}`)
  }
  return `{${parts.join(', ')}}`
}

function asConfigValue(value: unknown): CodexConfigValue {
  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    Array.isArray(value) ||
    isConfigObject(value)
  ) {
    return value as CodexConfigValue
  }
  if (value === null) throw new Error('Codex config override cannot be null')
  throw new Error(`Unsupported Codex config override value: ${typeof value}`)
}

function isConfigObject(value: unknown): value is { [key: string]: CodexConfigValue | undefined } {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Narrow an unknown config subtree to a spreadable object (or `{}`), for merging nested keys. */
function asConfigObject(value: unknown): { [key: string]: CodexConfigValue | undefined } {
  return isConfigObject(value) ? value : {}
}

function formatTomlKey(key: string): string {
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : quoteTomlString(key)
}

function quoteTomlString(value: string): string {
  return `"${value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')}"`
}

/**
 * Translate the neutral {@link ActionMode} × {@link ToolGate} grid into Codex's
 * launch-time `sandboxMode` + `approvalPolicy`. This is the degraded substitute
 * for per-tool approval (008): there is no runtime asking, so the sandbox is the
 * REAL enforcement and `approvalPolicy` is best-effort (in non-interactive exec it
 * has no user channel). The mapping favours the tight side — `plan` and
 * `always-ask` (which Codex cannot honour live) both collapse to `read-only`.
 * `plan + never-ask` is the intentional exception used for read-only MCP-backed
 * flows: the filesystem stays read-only while Codex is allowed to call MCP tools
 * whose handlers enforce their own gates.
 */
export function gateToCodexPolicy(
  actionMode: ActionMode,
  toolGate: ToolGate,
  /**
   * The launch-boundary carrier of the user's EXPLICIT full-access choice. Only
   * `true` unlocks `danger-full-access`; a two-arg call (or any falsy value)
   * keeps `build × never-ask` on `workspace-write` (2026-09-28).
   */
  opts?: { explicitFullAccess?: boolean },
): { sandboxMode: SandboxMode; approvalPolicy: ApprovalMode } {
  // `plan` never executes filesystem changes ⇒ read-only regardless of gate. If
  // the caller explicitly chose `never-ask`, do not request an approval channel
  // Codex exec does not have; this is required for read-only MCP-backed flows.
  if (actionMode === 'plan') {
    return {
      sandboxMode: 'read-only',
      approvalPolicy: toolGate === 'never-ask' ? 'never' : 'on-request',
    }
  }
  switch (toolGate) {
    case 'never-ask':
      // "Stop asking" is NOT "no sandbox": only an explicit, observable
      // full-access selection unlocks the unconstrained host filesystem.
      return {
        sandboxMode: opts?.explicitFullAccess === true ? 'danger-full-access' : 'workspace-write',
        approvalPolicy: 'never',
      }
    case 'trusted-prefix':
      return { sandboxMode: 'workspace-write', approvalPolicy: 'on-failure' }
    case 'on-sensitive':
      return { sandboxMode: 'workspace-write', approvalPolicy: 'on-request' }
    case 'always-ask':
      // Codex cannot ask per-tool (008); the safe degrade is a read-only sandbox.
      return { sandboxMode: 'read-only', approvalPolicy: 'on-request' }
  }
}

/**
 * Translate the neutral {@link RemoteMcpServer} map into codex's
 * `config.mcp_servers` shape (2026-06-12-005): each entry becomes
 * a required streamable-HTTP MCP server with the intent tools explicitly enabled
 * and approved. Returns `undefined` when there is nothing to attach, so the
 * caller can skip the `config` merge.
 */
export function mcpServersToCodexConfig(
  servers: Record<string, RemoteMcpServer> | undefined,
): Record<string, CodexMcpServerConfig> | undefined {
  if (!servers) return undefined
  const entries = Object.entries(servers)
  if (entries.length === 0) return undefined
  const out: Record<string, CodexMcpServerConfig> = {}
  for (const [name, s] of entries) {
    out[name] = {
      url: s.url,
      enabled: true,
      required: true,
      enabled_tools: s.enabledTools ?? INTENT_MCP_TOOL_NAMES,
      // Codex has its own MCP approval layer. c3 already gates save_intents inside
      // the MCP handler, so the Codex layer must not hide or prompt these tools.
      default_tools_approval_mode: 'approve',
      ...(s.bearerTokenEnvVar ? { bearer_token_env_var: s.bearerTokenEnvVar } : {}),
    }
  }
  return out
}

/**
 * Tools whose call MUST reach c3 through the ordinary MCP tool-call path, never
 * through codex's code-execution sandbox (`js_repl`).
 *
 * Two distinct failure modes make this necessary, and both surface as the model
 * reporting an "unsupported call":
 *
 *  1. `save_intents` blocks on a human clicking Save in the c3 UI — longer than
 *     the js_repl sandbox's time budget, so the sandbox aborts and the gate
 *     degrades to a deny.
 *  2. An unknown / aliased model makes codex fall back to default capability
 *     metadata that pulls the code-execution surface up, and every c3 MCP tool
 *     the run was given becomes uncallable. The ADVISOR group is exposed to this
 *     the same way the intent group is, so it is listed here too.
 *
 * `reset_intent_session` names the advisor group because it belongs to no other
 * profile: automations do not have it, and neither the intent nor the spec
 * profile carries it.
 */
const DIRECT_CALL_ONLY_TOOLS = ['save_intents', 'reset_intent_session'] as const

/**
 * Whether an attached MCP set carries any tool that must bypass code execution.
 * Recognises the intent comm-agent profile (`save_intents`) and the queue
 * advisor group (`reset_intent_session`); the spec profile carries only
 * `find_intents`/`view_intent` and the work profile only `publish_event`, so
 * neither matches. The `?? INTENT_MCP_TOOL_NAMES` fallback mirrors
 * {@link mcpServersToCodexConfig}: a descriptor that omits `enabledTools`
 * defaults to the three intent tools, so an old-style intent binding (no
 * explicit allowlist) is still recognised.
 */
export function mcpServersEnableSaveIntents(
  servers: Record<string, RemoteMcpServer> | undefined,
): boolean {
  if (!servers) return false
  return Object.values(servers).some((s) => {
    const enabled = (s.enabledTools ?? INTENT_MCP_TOOL_NAMES) as readonly string[]
    return DIRECT_CALL_ONLY_TOOLS.some((t) => enabled.includes(t))
  })
}

/**
 * Reverse map — {@link CodexPolicy} back to the neutral {@link ActionMode} ×
 * {@link ToolGate} grid (2026-06-08). This lets a codex session's stored dual
 * policy drive the neutral kernel path that `run-via-driver` consumes.
 * The mapping is the inverse of `gateToCodexPolicy`, with the same lossy
 * compression: `read-only` always maps to `plan`, and `always-ask` has no
 * Codex equivalent.
 */
export function codexPolicyToGrid(policy: CodexPolicy): {
  actionMode: ActionMode
  toolGate: ToolGate
} {
  const { sandboxMode, approvalPolicy } = policy
  // read-only sandbox ⇒ plan mode (no writes regardless of approval).
  if (sandboxMode === 'read-only') {
    return {
      actionMode: 'plan',
      toolGate: approvalPolicy === 'never' ? 'never-ask' : 'on-sensitive',
    }
  }
  // workspace-write: map approval policy to tool gate.
  switch (approvalPolicy) {
    case 'never':
      return { actionMode: 'build', toolGate: 'never-ask' }
    case 'on-failure':
      return { actionMode: 'build', toolGate: 'trusted-prefix' }
    case 'on-request':
      return { actionMode: 'build', toolGate: 'on-sensitive' }
  }
}

/**
 * A restartable view over {@link CanonicalQueue} (2026-09-29-004). The consumer
 * holds one iterator for the whole run; `swap` installs a replacement queue and
 * unblocks the pending `next()` so that iterator simply keeps receiving from the
 * replacement. No re-`start()`, no second `for await`, and the neutral `AgentRun`
 * contract is unchanged.
 */
class RestartableQueue implements AsyncIterable<CanonicalMessage> {
  private inner: CanonicalQueue
  private generation = 0

  constructor(initial: CanonicalQueue) {
    this.inner = initial
  }

  push(m: CanonicalMessage): void {
    this.inner.push(m)
  }

  close(): void {
    this.inner.close()
  }

  fail(err: unknown): void {
    this.inner.fail(err)
  }

  swap(next: CanonicalQueue): void {
    const previous = this.inner
    this.inner = next
    this.generation += 1
    // Unblock a consumer parked on the discarded queue so it re-reads the new one.
    previous.close()
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<CanonicalMessage> {
    let generation = this.generation
    let iterator = this.inner[Symbol.asyncIterator]()
    for (;;) {
      const result = await iterator.next()
      if (result.done) {
        if (generation !== this.generation) {
          generation = this.generation
          iterator = this.inner[Symbol.asyncIterator]()
          continue
        }
        return
      }
      yield result.value
    }
  }
}

/**
 * Whether an error is Codex's thread writer-lock rejection (2026-09-29-004). Only
 * the deterministic message is accepted: JSON-RPC `-32600` is a generic "invalid
 * request", not lock-specific, and a false positive here would scan the process
 * table, possibly signal a process, and re-send this turn's prompt on the retry.
 * The rejection is normally an in-band `error` ThreadEvent and can also surface as
 * a generator throw; both shapes route through this one predicate.
 */
export function isActiveWriterRejection(err: unknown): boolean {
  return /already has an active writer/i.test(errorMessageOf(err))
}

/**
 * Per-provider stream tolerance for the relay route, applied to the custom provider
 * c3 constructs.
 *
 * The CLI reconnects a broken response stream internally (its budget is the `1/5` in
 * its own error text) and only then gives up, so raising the budget and the idle
 * window converts some mid-turn breaks into a turn that simply continues — worth
 * having before the whole-round retry below ever runs. Only the three keys relevant to
 * this route are set (`websocket_connect_timeout_ms` is omitted because the route
 * forces `supports_websockets: false` and never opens one).
 *
 * These are NOT guesses: all three are fields of the CLI's own `ModelProviderInfo`,
 * confirmed against the shipped 0.159.2 binary. An unrecognized key there would make
 * the CLI refuse to start, which is why the set is pinned to exactly these three.
 */
const RELAY_PROVIDER_STREAM_TOLERANCE = {
  // Whole-request retries (connect/5xx), above the CLI default of 4.
  request_max_retries: 6,
  // Response-STREAM reconnect attempts — the budget the error message counts down.
  stream_max_retries: 8,
  // Idle window before a silent-but-open stream counts as dead. Generous by design:
  // a long tool-backed turn can legitimately go quiet, and a false timeout here
  // discards a turn that was still making progress.
  stream_idle_timeout_ms: 300_000,
} as const

/**
 * How a terminal upstream break is named in the run details. Codex-specific, and
 * deliberately says which side broke the stream: the CLI's own text ("stream error",
 * a child that exited 0) invites the reader to suspect c3's channel to the CLI,
 * which never carries model bytes.
 */
const CODEX_UPSTREAM_BREAK_ATTRIBUTION =
  '上游响应流在完成前中断（Codex CLI ↔ 上游 provider，非 c3 ↔ Codex 通道）'

/**
 * Whether a failure is the UPSTREAM response stream breaking mid-turn, as opposed to
 * anything about c3's own channel to the CLI. That distinction is the whole point of
 * this predicate: c3 talks to codex over stdin/stdout JSONL events, which never carry
 * model bytes, so a "stream" error text can only have come from the CLI's own HTTP
 * client talking to the provider. The CLI exhausts its internal reconnect budget
 * (`Reconnecting... 1/5`) before surfacing this, which is why the message reads as
 * terminal while the underlying fault is transient.
 *
 * Narrow on purpose. Every phrase below is one the CLI emits verbatim, and a false
 * positive would re-run a whole turn (duplicating whatever tool side effects already
 * happened) — an ordinary tool failure or an auth rejection must never match.
 * Codex-specific wording, so it stays here rather than in the neutral error module.
 */
export function isUpstreamStreamBreak(err: unknown): boolean {
  const message = errorMessageOf(err)
  if (message === '') return false
  // The CLI's own truncated-stream verdict (its reconnect budget ran out).
  if (/stream disconnected before completion/i.test(message)) return true
  // The transport-level cause it wraps.
  if (/socket connection was closed unexpectedly/i.test(message)) return true
  // The CLI's reconnect budget, reported without the above phrasing.
  if (/reconnecting\.{0,3}\s*\d+\s*\/\s*\d+/i.test(message)) return true
  return false
}

/** The message text of an `Error`, a string, or a message-bearing object. */
function errorMessageOf(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === 'string') return err
  if (err && typeof err === 'object') {
    const message = (err as { message?: unknown }).message
    if (typeof message === 'string') return message
  }
  return ''
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

/** Sandbox width ordering — the only comparison the convergence below needs. */
const SANDBOX_WIDTH: Record<SandboxMode, number> = {
  'read-only': 0,
  'workspace-write': 1,
  'danger-full-access': 2,
}

/**
 * The SINGLE convergence point between the neutral launch options and codex's
 * launch-time policy (2026-09-28).
 *
 * Two inputs, one ruler:
 *  - the neutral grid `actionMode x toolGate`, plus the explicit full-access
 *    authorization lifted onto the launch boundary;
 *  - an OPTIONAL vendor-private stored policy in `vendorContext.codexPolicy`,
 *    whose exact value avoids a lossy grid round-trip.
 *
 * The stored policy may refine `approvalPolicy` (an in-boundary field) and it
 * decides the sandbox whenever it is at most as wide as the grid. Widening is
 * gated on the explicit authorization, and the width comparison runs ONLY when
 * that authorization is absent. The order matters: a codex run's grid is itself
 * derived from this same stored policy by the lossy reverse map
 * ({@link codexPolicyToGrid}), which folds `danger-full-access` back into the
 * grid cell its `approvalPolicy` names — `build × on-sensitive` for `on-request`,
 * i.e. a `workspace-write` grid. Arbitrating the stored value against that grid
 * would discard the user's explicit full-access choice on the ordinary UI path
 * (the title bar swaps `sandboxMode` and keeps the stored `approvalPolicy`),
 * leaving the UI reading "full access" while the sandbox is `workspace-write`.
 * So an authorized policy is adopted verbatim, and only an unauthorized widening
 * falls back to the grid — narrowing is automatic, widening is not. That keeps
 * the pass-through bag from degenerating into a renamed bypass.
 */
export function convergeCodexPolicy(
  opts: Pick<
    DriverStartOptions,
    'actionMode' | 'toolGate' | 'explicitFullAccess' | 'vendorContext'
  >,
): { sandboxMode: SandboxMode; approvalPolicy: ApprovalMode } {
  const fromGrid = gateToCodexPolicy(opts.actionMode, opts.toolGate, {
    explicitFullAccess: opts.explicitFullAccess,
  })
  const stored = readStoredCodexPolicy(opts.vendorContext)
  if (!stored) return fromGrid
  if (
    opts.explicitFullAccess !== true &&
    SANDBOX_WIDTH[stored.sandboxMode] > SANDBOX_WIDTH[fromGrid.sandboxMode]
  ) {
    // The stored policy is wider than the grid this launch resolved, without the
    // authorization that would justify it — silently promoted, or predating the
    // flag. The grid wins.
    console.info(
      `[c3] codex: stored policy declares a wider sandbox (${stored.sandboxMode}) than this ` +
        `launch's grid grants (${fromGrid.sandboxMode}) — degraded to the grid.`,
    )
    return fromGrid
  }
  return { sandboxMode: stored.sandboxMode, approvalPolicy: stored.approvalPolicy }
}

/**
 * Read the vendor-private stored {@link CodexPolicy} out of the pass-through bag,
 * or `null` when absent / not a well-formed object. The bag is untyped by
 * construction, so the shape is validated HERE (inside the adapter) rather than
 * trusted from the neutral layer.
 */
function readStoredCodexPolicy(
  vendorContext: Record<string, unknown> | undefined,
): CodexPolicy | null {
  const raw = vendorContext?.['codexPolicy']
  if (!raw || typeof raw !== 'object') return null
  const candidate = raw as Partial<CodexPolicy>
  if (
    !isCodexSandboxMode(candidate.sandboxMode) ||
    !isCodexApprovalPolicy(candidate.approvalPolicy)
  ) {
    return null
  }
  return {
    sandboxMode: candidate.sandboxMode,
    approvalPolicy: candidate.approvalPolicy,
    ...(typeof candidate.explicitFullAccess === 'boolean'
      ? { explicitFullAccess: candidate.explicitFullAccess }
      : {}),
  }
}

function isCodexSandboxMode(v: unknown): v is CodexPolicy['sandboxMode'] {
  return v === 'read-only' || v === 'workspace-write' || v === 'danger-full-access'
}

function isCodexApprovalPolicy(v: unknown): v is CodexPolicy['approvalPolicy'] {
  return v === 'never' || v === 'on-failure' || v === 'on-request'
}

export class CodexDriver implements AgentDriver {
  readonly vendor = 'codex' as const
  readonly capabilities = codexCapabilities

  /**
   * @param createCodex SDK boundary (tests inject a fake).
   * @param relay The in-process vendor-neutral relay. When present and the run
   *   carries a custom provider (relay candidate list), codex is pointed at the
   *   relay's codex endpoint instead of the raw provider; when absent (or no
   *   candidates — system mode), codex uses its own login/config directly.
   */
  constructor(
    private readonly createCodex: CodexFactory = defaultFactory,
    private readonly relay?: Relay,
    private readonly resolveGitCommonDir: GitCommonDirResolver = resolveGitCommonDirDefault,
  ) {}

  async start(opts: DriverStartOptions): Promise<AgentRun> {
    // One stable async-iterable for the whole run: a resume retry swaps the inner
    // queue and the thread behind it while the consumer keeps this same iterator.
    const queue = new RestartableQueue(new CanonicalQueue())

    // Internal abort owns the run; the external signal feeds it. The turn-level
    // AbortSignal is Codex's only runtime control (008).
    const controller = new AbortController()
    if (opts.signal.aborted) controller.abort()
    else opts.signal.addEventListener('abort', () => controller.abort(), { once: true })

    // Provider connection comes from the agent's `custom` config, delivered as a
    // relay candidate list (one entry for a plain agent, N for a group). Two routes:
    //  - RELAY: candidates present + the relay wired ⇒ ALL custom codex providers go
    //    through c3's in-process vendor-neutral relay (the relay translates
    //    Responses↔Chat for `chat` upstreams and passes through `responses` ones, and
    //    fails over across the candidate list). Register the candidate list behind an
    //    opaque token, pass the token as the codex API key, define a custom
    //    model_provider with `supports_websockets=false` (forces plain HTTP POST + SSE
    //    the relay serves), and inject NO_PROXY so the loopback hop bypasses a user proxy.
    //  - DIRECT: no candidates (system mode) ⇒ the Codex CLI's own login/config applies.
    let relayToken: string | undefined
    let modelCatalog: ModelCatalogFile | null = null
    let codexOptions: CodexFactoryOptions
    if (this.relay && opts.relayCandidates && opts.relayCandidates.length > 0) {
      relayToken = this.relay.register(opts.relayCandidates)
      // Sandbox (arapuca): the run is a host process on the host loopback, so the
      // relay is reached at `127.0.0.1` directly — no host-gateway alias, no URL
      // rewrite. The per-run token rides as `CODEX_API_KEY` (set by codexExecEnv on
      // the wrapper process, inherited by the arapuca child), so no env-file is
      // needed. The relay stays bound to c3's loopback.
      codexOptions = {
        apiKey: relayToken, // becomes CODEX_API_KEY; the relay reads it as the binding token.
        env: relayEnv(opts.envOverrides),
        config: {
          model_provider: CODEX_RELAY_PROVIDER,
          model_providers: {
            [CODEX_RELAY_PROVIDER]: {
              name: CODEX_RELAY_PROVIDER,
              base_url: this.relay.endpoint('codex'),
              env_key: 'CODEX_API_KEY',
              wire_api: 'responses',
              supports_websockets: false,
              ...RELAY_PROVIDER_STREAM_TOLERANCE,
            },
          },
        },
      }
      // Custom-model catalog (2026-08-08-013): codex's bundled metadata catalog
      // does not know third-party model ids, so a custom codex run falls back to
      // default metadata (the `Model metadata for <id> not found` warning) unless
      // the id is registered locally via `model_catalog_json`. When the agent
      // configured capability fields, register the CLI-launched model (the first
      // relay candidate's id — what codex resolves metadata for) with those
      // capabilities; the `model_catalog_json` top-level key flattens into
      // `--config model_catalog_json=<path>` like any other config override.
      // SANDBOX RULE: the file must land inside the arapuca allow-set temp dir
      // (`sandboxTmpDir`) or the sandboxed codex cannot read it at startup — when
      // that dir is missing on a sandboxed run, drop the catalog (with a warning)
      // rather than write outside the allow set and break the run.
      const hasModelCaps = opts.contextWindow !== undefined || opts.maxOutputTokens !== undefined
      if (hasModelCaps) {
        if (opts.sandboxWrapperPath && !opts.sandboxTmpDir) {
          console.warn(
            '[c3] codex sandbox run: model catalog skipped (no sandboxTmpDir in the arapuca ' +
              'allow set) — codex falls back to default metadata for this model.',
          )
        } else {
          modelCatalog = writeModelCatalogFile({
            modelId: opts.relayCandidates[0].model,
            contextWindow: opts.contextWindow,
            maxOutputTokens: opts.maxOutputTokens,
            sandboxTmpDir: opts.sandboxTmpDir,
          })
          codexOptions.config = { ...codexOptions.config, model_catalog_json: modelCatalog.path }
        }
      }
    } else {
      // `CodexOptions.env` REPLACES process.env (see codexExecEnv), so overrides
      // must be layered onto the inherited env — otherwise passing e.g. an injected
      // GH_TOKEN (or proxy vars) would strip PATH and everything else from the codex
      // process. Merging matches the container wrapper's buildChildEnv semantics.
      codexOptions = {
        ...(opts.envOverrides ? { env: { ...inheritedEnv(), ...opts.envOverrides } } : {}),
      }
    }
    // Remote MCP servers (2026-06-12-005): codex 0.139 supports streamable-HTTP MCP
    // via `config.mcp_servers.<name> = { url }` (the `codex mcp add --url` shape). Merge
    // onto whatever config the relay branch set — the two never share keys. The intent
    // route is c3's only producer today; its per-run binding token rides the URL query.
    const mcpConfig = mcpServersToCodexConfig(opts.mcpServers)
    if (mcpConfig) {
      codexOptions.config = { ...(codexOptions.config ?? {}), mcp_servers: mcpConfig }
      // Intent MCP is also a c3 loopback HTTP hop. Ensure Codex's MCP client does
      // not route 127.0.0.1 through a user/system proxy and receive a proxy's empty
      // or non-MCP response during initialize.
      codexOptions.env = relayEnv(opts.envOverrides)
    }
    // Intent comm-agent shutdown (save_intents confirmation gate): codex's code
    // execution (`js_repl`) wraps an MCP call as `await tools.mcp__c3__save_intents(...)`
    // inside a time-budgeted JS sandbox. The gate needs the human to click Save in the
    // c3 UI — longer than the sandbox lasts — so the sandbox aborts, the run cycle's
    // binding signal fires, `waitForDecision` degrades to `deny`, and the intent never
    // persists. Force every `mcp__c3` tool through the standard MCP tool-call path
    // (no sandbox budget) by turning code execution OFF for intent runs, so the gate
    // can block as long as it needs. Web search is closed alongside (the intent role
    // never uses it, and `web_search="live"` may pull the js_repl surface up). Only
    // runs carrying a direct-call-only tool (the intent comm profile's
    // `save_intents`, or the queue advisor group) are touched; work/spec/discussion
    // codex runs keep their tool surface. Three keys ship at once
    // to span codex config-format evolution; an older codex silently ignores keys it
    // does not know (verified on 0.142.4). The `web_search="live"` opts.webSearch sends
    // is overridden to `disabled` in threadOptions below.
    const directCallRun = mcpServersEnableSaveIntents(opts.mcpServers)
    if (directCallRun) {
      codexOptions.config = {
        ...(codexOptions.config ?? {}),
        // `features.js_repl=false` is the root switch: no code-execution sandbox for
        // the model to route save_intents through.
        features: { ...asConfigObject(codexOptions.config?.features), js_repl: false },
        // `tools.web_search=false` is the new `[tools]`-table form; the old top-level
        // `web_search="disabled"` rides via threadOptions (codexExecArgs) below.
        tools: { ...asConfigObject(codexOptions.config?.tools), web_search: false },
      }
    }
    // Binary resolution. In a sandbox run a wrapper script is supplied
    // (`opts.sandboxWrapperPath`) — it becomes the codex executable, so c3 spawns
    // `arapuca run … -- codex "$@"` and the run executes as an arapuca-narrowed
    // host process. The wrapper forwards every c3-built argv via `"$@"`, so
    // `baseUrl` (→ `--config openai_base_url`) and `model` (→ `--model`) reach
    // codex natively. `CODEX_API_KEY` (the relay token) sits on the wrapper
    // process env here, but arapuca is env deny-by-default and drops the parent
    // env — so the wrapper forwards it explicitly as `--env "CODEX_API_KEY=$CODEX_API_KEY"`,
    // expanded by /bin/sh from this process's env at run time, without writing
    // the token value into the wrapper script (see createSandboxWrapper) — no
    // env-file. Without a wrapper, use c3's own
    // ProcessLauncher PATH probe (cached; a no-op after the first health check).
    // When the binary is not on PATH, higher layers handle the absence before the
    // adapter is constructed — by this point it is always present.
    codexOptions.codexPathOverride = opts.sandboxWrapperPath ?? resolve('codex') ?? undefined
    const codex = this.createCodex(codexOptions)
    // Codex's launch-time policy is its permission boundary. The neutral grid is
    // the SOURCE OF TRUTH; `vendorContext.codexPolicy` may only REFINE fields that
    // do not widen the sandbox boundary (2026-09-28). The convergence rule below
    // is the single enforcement point — a caller cannot hand us a
    // `danger-full-access` without the explicit authorization flag, whatever the
    // field is called on the way in.
    const policy = convergeCodexPolicy(opts)
    // arapuca is already the filesystem sandbox. On macOS a second Seatbelt
    // application from Codex fails with EPERM, so disable only Codex's nested
    // filesystem sandbox while preserving its approval policy.
    const sandboxMode = opts.sandboxWrapperPath ? 'danger-full-access' : policy.sandboxMode
    // Git-metadata compensation (2026-09-28): under `workspace-write` the agent
    // can edit the working tree but NOT the index/refs/objects, which for a
    // worktree live in the main repo's common git dir OUTSIDE cwd. Add exactly
    // that one directory to the writable set so `git add/commit/push` works
    // without widening the sandbox to the whole host. Compensations of this kind
    // live HERE, inside the adapter — the neutral layer never grows a codex branch.
    const additionalDirectories = [...(opts.additionalDirectories ?? [])]
    if (sandboxMode === 'workspace-write' && !opts.sandboxWrapperPath) {
      const gitCommonDir = await this.resolveGitCommonDir(opts.cwd)
      if (gitCommonDir && !additionalDirectories.includes(gitCommonDir)) {
        additionalDirectories.push(gitCommonDir)
      }
    }
    const threadOptions: ThreadOptions = {
      workingDirectory: opts.cwd,
      skipGitRepoCheck: true, // c3 may run in a non-git cwd; do not hard-fail the run.
      sandboxMode,
      approvalPolicy: policy.approvalPolicy,
      ...(opts.model ? { model: opts.model } : {}),
      ...(additionalDirectories.length > 0 ? { additionalDirectories } : {}),
      // Network: codex's sandbox denies network access by default (orthogonal to the
      // filesystem sandboxMode), so any web fetch/search in work/intent/discussion
      // failed until these were threaded through (2026-06-15). `networkAccess` opens
      // raw socket access for sandboxed shell commands; `webSearch` enables codex's
      // first-party web-search tool. Both omitted ⇒ codex defaults (denied) stand.
      ...(opts.networkAccess !== undefined ? { networkAccessEnabled: opts.networkAccess } : {}),
      // Direct-call runs force web search OFF (see the shutdown block above) even though
      // run-via-driver passes `webSearch: true` for every interactive run — this
      // emits the old-format `web_search="disabled"` and overrides the `"live"` the
      // flag would otherwise produce. Other runs keep the live web-search tool.
      ...(directCallRun
        ? { webSearchEnabled: false }
        : opts.webSearch
          ? { webSearchEnabled: true, webSearchMode: 'live' as const }
          : {}),
    }
    const buildThread = (): CodexThread =>
      opts.resume
        ? codex.resumeThread(opts.resume, threadOptions)
        : codex.startThread(threadOptions)
    let thread = buildThread()

    /**
     * Rebuild for a retry. An upstream stream break is not tied to the original
     * launch mode: when the broken turn already announced a thread id, the retry
     * resumes THAT thread to keep its context, even if the run began as a fresh
     * thread (the common case for an automation's first round breaking late). With
     * no id yet — a break before the first frame — there is nothing to resume, so it
     * starts over exactly as the original attempt did.
     */
    const buildThreadForRetry = (): CodexThread => {
      const resumable = opts.resume ?? (sid ? sid : undefined)
      return resumable
        ? codex.resumeThread(resumable, threadOptions)
        : codex.startThread(threadOptions)
    }

    // sessionId resolves from `thread.started` (a new thread) or is known up-front
    // (a resume). Items always follow `thread.started`, so `sid` is set before them.
    let sid = opts.resume ?? ''
    let resolveSid: (id: string) => void = () => {}
    const sidPromise = opts.resume
      ? Promise.resolve(opts.resume)
      : new Promise<string>((r) => {
          resolveSid = r
        })

    // Supervisor state (2026-09-29-004). Failures are deferred, never immediate: the
    // supervisor decides between retrying and terminating, so a recovery is one
    // uninterrupted turn rather than a dead stream plus a mystery second run.
    //
    // Two INDEPENDENT budgets, because the two recoverable failures need different
    // recoveries and have different reach. An active-writer rejection is specific to a
    // resume (a fresh thread holds no lock) and must first reclaim the stale holder.
    // An upstream stream break can strike ANY round — a brand-new automation run
    // breaks just as easily as a resumed one — and needs no reclaim, so its budget is
    // granted unconditionally; keeping it tied to `opts.resume` is what left a first
    // run with no recovery at all.
    let activeWriterBudget = opts.resume ? 1 : 0
    let streamBreakBudget = 1
    let streamBreakRetries = 0
    let pendingError: unknown = null
    let lastRejection: unknown = null

    /** What the pump must do after {@link considerFailure} grants a retry. */
    type RetryPlan = 'reclaim-writer' | 'restart-turn' | null

    // Set by the dispatch handlers on the event path, read by the pump below.
    let retryPlan: RetryPlan = null

    const considerFailure = (err: unknown): RetryPlan => {
      // An abort is the user stopping the run: it precedes every classification, so
      // it neither spends a budget nor triggers a recovery.
      if (controller.signal.aborted) {
        if (pendingError === null) pendingError = err
        return null
      }
      if (activeWriterBudget > 0 && isActiveWriterRejection(err)) {
        activeWriterBudget -= 1
        lastRejection = err
        return 'reclaim-writer'
      }
      if (streamBreakBudget > 0 && isUpstreamStreamBreak(err)) {
        streamBreakBudget -= 1
        streamBreakRetries += 1
        // Recorded so the failure that finally lands carries WHY it is terminal: the
        // bare CLI text is what made this undiagnosable from the run details alone.
        if (pendingError === null) pendingError = err
        return 'restart-turn'
      }
      if (pendingError === null) pendingError = err
      return null
    }

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
          retryPlan = considerFailure(new Error(`codex turn failed: ${ev.error.message}`))
          break
        case 'error':
          retryPlan = considerFailure(new Error(`codex stream error: ${ev.message}`))
          break
        // turn.started / turn.completed: no canonical analogue; the generator
        // ending is the turn-end signal (handled in pump()).
      }
    }

    /**
     * Close the turn once its child has settled. The CLI teardown outcome is only
     * known after the generator's `finally`, so the pending error is held and the
     * outcome phrase (`pid 43210 exited code=1`) is appended here — which is what
     * makes the pid and reclamation visible in the exact 502-stream-error case.
     */
    const settleTurn = (settledThread: CodexThread): void => {
      const outcome = settledThread.lastChildOutcome?.() ?? null
      if (pendingError !== null) {
        const phrase = outcome ? describeCodexChildOutcome(outcome) : null
        const base = runErrMsg(pendingError)
        // Say, in the run details, WHICH failure this is and what was already tried.
        // The raw CLI text names neither the fault nor the recovery, so a terminal
        // upstream break otherwise reads as an unexplained failure (its child even
        // exits 0). The outcome phrase is kept as the corroborating evidence.
        const blamed =
          streamBreakRetries > 0 && isUpstreamStreamBreak(pendingError)
            ? `${CODEX_UPSTREAM_BREAK_ATTRIBUTION} (已自动重试 ${streamBreakRetries} 次仍失败): ${base}`
            : base
        queue.fail(new Error(phrase ? `${blamed} (${phrase})` : blamed, { cause: pendingError }))
        return
      }
      queue.close()
    }

    const failTurn = (diagnostic: string): void => {
      const base = lastRejection ? runErrMsg(lastRejection) : 'codex thread is locked'
      queue.fail(new Error(`${base} — ${diagnostic}`, { cause: lastRejection ?? undefined }))
    }

    /**
     * Locate the process holding the resumed thread's writer lock and reclaim it
     * only when c3 can prove it is its own leftover. Returns true when the retry may
     * proceed; otherwise it fails the turn with actionable diagnostics.
     */
    const recoverFromActiveWriter = async (): Promise<boolean> => {
      const threadId = opts.resume
      if (!threadId) return false
      const result = await reclaimCodexOccupant(threadId)
      if (result.kind === 'reclaimed' || result.kind === 'already-exited') {
        logCodexReclaim(
          threadId,
          result.pid,
          result.kind === 'reclaimed' ? result.method : 'already-exited',
        )
        return true
      }
      failTurn(
        result.kind === 'failed'
          ? describeCodexReclaimFailure(result)
          : describeCodexOccupantRefusal(threadId, result),
      )
      return false
    }

    // Prompt images (2026-06-16): codex takes images as on-disk paths
    // (`--image <FILE>`), so decode each attachment to a per-turn temp file and
    // build the mixed text/image input. SANDBOX EXCEPTION: an arapuca run is
    // deny-by-default, and the host image temp dir is not in the allow set, so
    // pointing codex at it would fail the whole turn. Until the image temp dir is
    // added to the allow set (a follow-up), drop images for sandboxed runs rather
    // than break the turn.
    // Codex has no separate system role, so the neutral `systemInstruction` rides
    // as a leading text item at position 0 of the input array — byte-identical
    // across turns, which is the stable prefix the API prompt cache keys off. An
    // empty/absent instruction leaves the input as the bare user turn.
    const sysText = opts.systemInstruction?.trim() ? opts.systemInstruction : undefined
    let imageFiles: ImageTempFiles | null = null
    let codexInput: CodexInput = sysText
      ? [
          { type: 'text', text: sysText },
          { type: 'text', text: opts.prompt },
        ]
      : opts.prompt
    if (opts.images && opts.images.length > 0) {
      if (opts.sandboxWrapperPath) {
        console.warn(
          '[c3] codex sandbox run: prompt images are not supported (host temp path is ' +
            'not in the arapuca allow set) — dropping images for this turn.',
        )
      } else {
        imageFiles = writeImageTempFiles(opts.images)
        if (imageFiles) {
          codexInput = [
            ...(sysText ? [{ type: 'text' as const, text: sysText }] : []),
            { type: 'text', text: opts.prompt },
            ...imageFiles.paths.map((path) => ({ type: 'local_image' as const, path })),
          ]
        }
      }
    }

    const pump = async (): Promise<void> => {
      try {
        for (;;) {
          retryPlan = null
          try {
            const { events } = await thread.runStreamed(codexInput, { signal: controller.signal })
            for await (const ev of events) {
              if (controller.signal.aborted) break
              dispatch(ev)
              // Fetch the failure now instead of waiting for the stream to end: a
              // broken turn's child may linger, and only closing the generator runs
              // its teardown (the SIGTERM/SIGKILL reclaim).
              if (retryPlan !== null || pendingError !== null) break
            }
          } catch (e) {
            retryPlan = considerFailure(e)
          }
          if (retryPlan === null) {
            settleTurn(thread)
            return
          }
          // Breaking the loop above ran the discarded attempt's teardown, so its
          // child is gone before the replacement starts — a retry never overlaps two
          // live children for one turn.
          if (controller.signal.aborted) return
          if (retryPlan === 'reclaim-writer') {
            const recovered = await recoverFromActiveWriter()
            if (!recovered || controller.signal.aborted) return
          }
          // A stream break has already discarded its attempt's child above and owns
          // no lock to reclaim. Resume the SAME thread when its id is known, so the
          // retry keeps the context the broken turn had built up; only a turn that
          // broke before its first frame (no id yet) starts over from scratch.
          pendingError = null
          thread = buildThreadForRetry()
          queue.swap(new CanonicalQueue())
        }
      } finally {
        resolveSid(sid) // never leave sessionId() hanging if the turn never started.
        // The session's own record of its codex children: pid, exit mode and
        // reclamation result in one line, read back from the registry.
        logCodexSessionChildren(sid, findCodexChildrenByThread(sid))
        if (relayToken) this.relay?.unregister(relayToken) // evict the per-run binding.
        cleanupImageTempFiles(imageFiles) // remove the per-turn image temp files.
        cleanupModelCatalogFile(modelCatalog) // remove the per-run model catalog (host or sandbox).
      }
    }
    void pump()

    return {
      sessionId: () => sidPromise,
      messages: () => queue,
      abort: () => {
        controller.abort()
        queue.close()
        if (relayToken) this.relay?.unregister(relayToken)
      },
    }
  }
}

/**
 * Build the env for the relay route. `CodexOptions.env` REPLACES `process.env`, so
 * we copy the inherited env (preserving PATH) then ensure the loopback host bypasses
 * any configured proxy — codex routes `127.0.0.1:<c3port>` through `HTTP(S)_PROXY`
 * otherwise, which 502s the relay hop (ADR-0029). `CODEX_API_KEY` is set by the SDK
 * from `apiKey`, so it is not set here.
 */
function relayEnv(extra?: Record<string, string>): Record<string, string> {
  const env = inheritedEnv()
  if (extra) Object.assign(env, extra)
  env.NO_PROXY = withLoopbackNoProxy(env.NO_PROXY)
  env.no_proxy = withLoopbackNoProxy(env.no_proxy)
  return env
}

/** A copy of the host `process.env` (defined values only) as a plain string map. */
function inheritedEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
  return env
}
