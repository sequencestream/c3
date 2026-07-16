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
 * ADR-0009: imports `@openai/codex-sdk` types (inside `adapters/codex/`); only
 * canonical shapes leave via {@link AgentRun.messages}.
 */
import { spawn } from 'node:child_process'
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
import { resolve } from '../../process/launcher.js'

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
  | string
  | number
  | boolean
  | CodexConfigValue[]
  | { [key: string]: CodexConfigValue | undefined }

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
    let spawnError: Error | null = null
    child.once('error', (err) => {
      spawnError = err
    })
    if (!child.stdin) {
      child.kill()
      throw new Error('Codex child process has no stdin')
    }
    child.stdin.write(text)
    child.stdin.end()
    if (!child.stdout) {
      child.kill()
      throw new Error('Codex child process has no stdout')
    }

    const stderrChunks: Buffer[] = []
    child.stderr?.on('data', (data: Buffer) => {
      stderrChunks.push(data)
    })
    const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolveExit) => {
        child.once('exit', (code, exitSignal) => resolveExit({ code, signal: exitSignal }))
      },
    )
    const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity })

    try {
      for await (const line of rl) {
        let parsed: ThreadEvent
        try {
          parsed = JSON.parse(line) as ThreadEvent
        } catch (err) {
          throw new Error(`Failed to parse codex JSON event: ${line}`, { cause: err })
        }
        if (parsed.type === 'thread.started') this.threadId = parsed.thread_id
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
      rl.close()
      child.removeAllListeners()
      try {
        if (!child.killed) child.kill()
      } catch {
        // Best-effort cleanup only.
      }
    }
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
 * Does an attached MCP set expose `save_intents`? That tool is the intent
 * comm-agent's write capability and is unique to the intent profile — the spec
 * profile carries only `find_intents`/`view_intent`, the work profile only
 * `publish_event`. So a run whose MCP `enabledTools` includes `save_intents`
 * IS an intent-communication run, and only those runs get the code-execution /
 * web-search shutdown (see {@link CodexDriver.start}). The `?? INTENT_MCP_TOOL_NAMES`
 * fallback mirrors {@link mcpServersToCodexConfig}: a descriptor that omits
 * `enabledTools` defaults to the three intent tools, so an old-style intent
 * binding (no explicit allowlist) is still recognised.
 */
export function mcpServersEnableSaveIntents(
  servers: Record<string, RemoteMcpServer> | undefined,
): boolean {
  if (!servers) return false
  return Object.values(servers).some((s) =>
    ((s.enabledTools ?? INTENT_MCP_TOOL_NAMES) as readonly string[]).includes('save_intents'),
  )
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
  ) {}

  async start(opts: DriverStartOptions): Promise<AgentRun> {
    const queue = new CanonicalQueue()

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
            },
          },
        },
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
    // intent runs — identified by `save_intents` in the MCP allowlist — are touched;
    // work/spec/discussion codex runs keep their tool surface. Three keys ship at once
    // to span codex config-format evolution; an older codex silently ignores keys it
    // does not know (verified on 0.142.4). The `web_search="live"` opts.webSearch sends
    // is overridden to `disabled` in threadOptions below.
    const intentRun = mcpServersEnableSaveIntents(opts.mcpServers)
    if (intentRun) {
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
    // codex natively, and `CODEX_API_KEY` rides the wrapper process env (inherited
    // by the arapuca child) — no env-file. Without a wrapper, use c3's own
    // ProcessLauncher PATH probe (cached; a no-op after the first health check).
    // When the binary is not on PATH, higher layers handle the absence before the
    // adapter is constructed — by this point it is always present.
    codexOptions.codexPathOverride = opts.sandboxWrapperPath ?? resolve('codex') ?? undefined
    const codex = this.createCodex(codexOptions)
    // Codex's launch-time policy IS the per-tool-approval substitute (008). It is
    // derived from the session permission mode (defaultMode → neutral grid →
    // sandbox/approval), so one permission knob drives every vendor and a codex
    // agent needs no separate sandbox/approval config (2026-06-06-008).
    const policy = gateToCodexPolicy(opts.actionMode, opts.toolGate)
    // arapuca is already the filesystem sandbox. On macOS a second Seatbelt
    // application from Codex fails with EPERM, so disable only Codex's nested
    // filesystem sandbox while preserving its approval policy.
    const sandboxMode = opts.sandboxWrapperPath ? 'danger-full-access' : policy.sandboxMode
    const threadOptions: ThreadOptions = {
      workingDirectory: opts.cwd,
      skipGitRepoCheck: true, // c3 may run in a non-git cwd; do not hard-fail the run.
      sandboxMode,
      approvalPolicy: policy.approvalPolicy,
      ...(opts.model ? { model: opts.model } : {}),
      ...(opts.additionalDirectories ? { additionalDirectories: opts.additionalDirectories } : {}),
      // Network: codex's sandbox denies network access by default (orthogonal to the
      // filesystem sandboxMode), so any web fetch/search in work/intent/discussion
      // failed until these were threaded through (2026-06-15). `networkAccess` opens
      // raw socket access for sandboxed shell commands; `webSearch` enables codex's
      // first-party web-search tool. Both omitted ⇒ codex defaults (denied) stand.
      ...(opts.networkAccess !== undefined ? { networkAccessEnabled: opts.networkAccess } : {}),
      // Intent runs force web search OFF (see the shutdown block above) even though
      // run-via-driver passes `webSearch: true` for every interactive run — this
      // emits the old-format `web_search="disabled"` and overrides the `"live"` the
      // flag would otherwise produce. Non-intent runs keep the live web-search tool.
      ...(intentRun
        ? { webSearchEnabled: false }
        : opts.webSearch
          ? { webSearchEnabled: true, webSearchMode: 'live' as const }
          : {}),
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
        const { events } = await thread.runStreamed(codexInput, { signal: controller.signal })
        for await (const ev of events) {
          if (controller.signal.aborted) break
          dispatch(ev)
        }
        queue.close()
      } catch (e) {
        queue.fail(e)
      } finally {
        resolveSid(sid) // never leave sessionId() hanging if the turn never started.
        if (relayToken) this.relay?.unregister(relayToken) // evict the per-run binding.
        cleanupImageTempFiles(imageFiles) // remove the per-turn image temp files.
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
 * otherwise, which 502s the relay hop (ADR-0014). `CODEX_API_KEY` is set by the SDK
 * from `apiKey`, so it is not set here.
 */
function relayEnv(extra?: Record<string, string>): Record<string, string> {
  const env = inheritedEnv()
  if (extra) Object.assign(env, extra)
  env.NO_PROXY = withLoopback(env.NO_PROXY)
  env.no_proxy = withLoopback(env.no_proxy)
  return env
}

/** A copy of the host `process.env` (defined values only) as a plain string map. */
function inheritedEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
  return env
}

/** Add the loopback hosts to a comma-separated NO_PROXY list (idempotent). */
function withLoopback(value?: string): string {
  const parts = (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  for (const host of ['127.0.0.1', 'localhost', '::1']) {
    if (!parts.includes(host)) parts.push(host)
  }
  return parts.join(',')
}
