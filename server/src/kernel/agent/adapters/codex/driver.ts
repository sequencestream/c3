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
import { appendFileSync } from 'node:fs'
import { Codex } from '@openai/codex-sdk'
import type {
  ApprovalMode,
  CodexOptions,
  SandboxMode,
  ThreadEvent,
  ThreadOptions,
} from '@openai/codex-sdk'
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
import { CODEX_RELAY_PROVIDER, type CodexRelay } from './relay-contract.js'
import { resolve } from '../../process/launcher.js'

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
  codexPathOverride?: string
  baseUrl?: string
  apiKey?: string
  env?: Record<string, string>
  /** `--config key=value` overrides (flattened by the SDK). Used to define the relay provider. */
  config?: Record<string, unknown>
}

/** Builds a {@link CodexClient}. Injected for tests; defaults to the real SDK. */
export type CodexFactory = (options: CodexFactoryOptions) => CodexClient

const defaultFactory: CodexFactory = (options) =>
  new Codex(options as CodexOptions) as unknown as CodexClient

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
 * `{ url, [bearer_token_env_var] }` — the streamable-HTTP MCP form codex 0.139
 * accepts (the `codex mcp add <name> --url <URL>` config). Returns `undefined`
 * when there is nothing to attach, so the caller can skip the `config` merge.
 */
export function mcpServersToCodexConfig(
  servers: Record<string, RemoteMcpServer> | undefined,
): Record<string, { url: string; bearer_token_env_var?: string }> | undefined {
  if (!servers) return undefined
  const entries = Object.entries(servers)
  if (entries.length === 0) return undefined
  const out: Record<string, { url: string; bearer_token_env_var?: string }> = {}
  for (const [name, s] of entries) {
    out[name] = {
      url: s.url,
      ...(s.bearerTokenEnvVar ? { bearer_token_env_var: s.bearerTokenEnvVar } : {}),
    }
  }
  return out
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
 * Translate the DIRECT-route provider triple into the env-file additions a
 * **sandboxed** codex container needs (ADR-0024 follow-up). DIRECT means
 * `wireApi === 'responses'` — the custom provider serves OpenAI Responses
 * natively, so codex connects to it directly (no relay).
 *
 * In a sandbox run the SDK still builds the codex CLI argv on the host and spawns
 * the wrapper script; the wrapper forwards every argv via `"$@"` into the
 * container, so `baseUrl` (→ `--config openai_base_url`) and `model` (→ `--model`)
 * already reach the container codex. The ONE option the SDK delivers as a
 * host-*process* env var — `apiKey` → `CODEX_API_KEY` — does NOT cross
 * `docker exec --env-file`, so it must be written into the env-file explicitly.
 * `CODEX_API_KEY` is the exact var the codex CLI reads for the provider key
 * (the same var the relay path binds its token to — driver.ts above).
 *
 * Returns `{}` (no codex provider env) for: the RELAY route (`wireApi === 'chat'`,
 * a later intent), a missing key, or system-mode codex (no override) — the caller
 * then writes no codex-specific provider env into the env-file.
 */
export function codexDirectSandboxEnv(opts: {
  apiKey?: string
  wireApi?: 'responses' | 'chat'
}): Record<string, string> {
  if (opts.wireApi !== 'responses' || !opts.apiKey) return {}
  return { CODEX_API_KEY: opts.apiKey }
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
   * @param relay The in-process Responses→Chat relay (ADR-0014). When present and
   *   the run has a custom provider URL, codex is pointed at the relay instead of
   *   the raw provider; when absent (or no custom URL), the provider connects
   *   directly (the original path).
   */
  constructor(
    private readonly createCodex: CodexFactory = defaultFactory,
    private readonly relay?: CodexRelay,
  ) {}

  async start(opts: DriverStartOptions): Promise<AgentRun> {
    const queue = new CanonicalQueue()

    // Internal abort owns the run; the external signal feeds it. The turn-level
    // AbortSignal is Codex's only runtime control (008).
    const controller = new AbortController()
    if (opts.signal.aborted) controller.abort()
    else opts.signal.addEventListener('abort', () => controller.abort(), { once: true })

    // Provider connection comes from the agent's `custom` config. The route is
    // decided by the provider's declared `wireApi` (2026-06-12-006), NOT guessed
    // from the presence of a baseUrl — the old heuristic sent EVERY custom codex
    // provider through the relay, corrupting providers that natively speak
    // Responses. Two routes:
    //  - RELAY (ADR-0014): `wireApi === 'chat'` + a custom provider URL + the relay
    //    present ⇒ the provider is Chat-Completions-only, but codex 0.137 only
    //    speaks Responses. So point codex at c3's in-process Responses→Chat relay:
    //    register the REAL upstream behind an opaque token, pass the token as the
    //    codex API key, define a custom model_provider with `supports_websockets=false`
    //    (forces plain HTTP POST + SSE the relay serves), and inject NO_PROXY so the
    //    loopback hop bypasses a user proxy.
    //  - DIRECT (original path): `wireApi === 'responses'` (provider serves Responses
    //    natively), or no relay / no custom URL (system mode) ⇒ baseUrl/apiKey go
    //    straight to the SDK as constructor options (NOT env — CodexOptions.env
    //    REPLACES process.env and would drop PATH). `system` configMode leaves
    //    them undefined ⇒ the Codex CLI's own login/config applies.
    let relayToken: string | undefined
    let codexOptions: CodexFactoryOptions
    if (this.relay && opts.baseUrl && opts.wireApi === 'chat') {
      relayToken = this.relay.register({ baseUrl: opts.baseUrl, apiKey: opts.apiKey ?? '' })
      // Sandbox (ADR-0024 follow-up): the run executes INSIDE a container (a wrapper
      // path is supplied), so the relay must be reached across the container boundary.
      // The relay STAYS bound to c3's loopback (no network-exposure widening, Q1-A);
      // the container reaches it through Docker's `host.docker.internal` host-gateway
      // alias, so the provider base_url's loopback host is rewritten to that alias.
      // The per-run token must also cross into the container: the SDK only sets it as
      // a HOST-process `CODEX_API_KEY`, which `docker exec --env-file` does not carry
      // in, so mirror token + NO_PROXY (bypass the host.docker.internal hop) into the
      // env-file the wrapper reads. The env-file is read lazily at `docker exec` time
      // (during `runStreamed` below), so appending here — after register, before the
      // turn — lands the token in time.
      const sandboxed = !!opts.sandboxWrapperPath
      const relayBase = sandboxed
        ? rewriteRelayHostForSandbox(this.relay.baseUrl)
        : this.relay.baseUrl
      if (sandboxed && opts.sandboxEnvFile) {
        appendEnvFile(opts.sandboxEnvFile, codexRelaySandboxEnv(relayToken))
      }
      codexOptions = {
        apiKey: relayToken, // becomes CODEX_API_KEY; the relay reads it as the binding token.
        env: relayEnv(opts.envOverrides),
        config: {
          model_provider: CODEX_RELAY_PROVIDER,
          model_providers: {
            [CODEX_RELAY_PROVIDER]: {
              name: CODEX_RELAY_PROVIDER,
              base_url: relayBase,
              env_key: 'CODEX_API_KEY',
              wire_api: 'responses',
              supports_websockets: false,
            },
          },
        },
      }
    } else {
      codexOptions = {
        ...(opts.envOverrides ? { env: opts.envOverrides } : {}),
        ...(opts.baseUrl ? { baseUrl: opts.baseUrl } : {}),
        ...(opts.apiKey ? { apiKey: opts.apiKey } : {}),
      }
    }
    // Remote MCP servers (2026-06-12-005): codex 0.139 supports streamable-HTTP MCP
    // via `config.mcp_servers.<name> = { url }` (the `codex mcp add --url` shape). Merge
    // onto whatever config the relay branch set — the two never share keys. The intent
    // route is c3's only producer today; its per-run binding token rides the URL query.
    const mcpConfig = mcpServersToCodexConfig(opts.mcpServers)
    if (mcpConfig) {
      codexOptions.config = { ...(codexOptions.config ?? {}), mcp_servers: mcpConfig }
    }
    // Binary resolution. In a sandbox run a wrapper script is supplied
    // (`opts.sandboxWrapperPath`) — it becomes the codex executable, so the SDK
    // spawns `docker exec … codex "$@"` and the run executes INSIDE the container
    // (ADR-0024). The wrapper forwards every SDK-built argv via `"$@"`, so
    // `baseUrl` (→ `--config openai_base_url`) and `model` (→ `--model`) cross into
    // the container natively; only the SDK's host-process `CODEX_API_KEY` env does
    // not cross `docker exec --env-file`, which the caller mirrors into the
    // env-file via {@link codexDirectSandboxEnv}. Without a wrapper, bypass the
    // SDK's internal npm-based binary resolution (findCodexPath) in favor of c3's
    // own ProcessLauncher PATH probe (cached; a no-op after the first health
    // check). When the binary is not on PATH, higher layers handle the absence
    // before the adapter is constructed — by this point it is always present.
    codexOptions.codexPathOverride = opts.sandboxWrapperPath ?? resolve('codex') ?? undefined
    const codex = this.createCodex(codexOptions)
    // Codex's launch-time policy IS the per-tool-approval substitute (008). It is
    // derived from the session permission mode (defaultMode → neutral grid →
    // sandbox/approval), so one permission knob drives every vendor and a codex
    // agent needs no separate sandbox/approval config (2026-06-06-008).
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
        if (relayToken) this.relay?.unregister(relayToken) // evict the per-run binding.
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
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
  if (extra) Object.assign(env, extra)
  env.NO_PROXY = withLoopback(env.NO_PROXY)
  env.no_proxy = withLoopback(env.no_proxy)
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

/**
 * The host alias a sandboxed container uses to reach c3's loopback-bound relay
 * (ADR-0024 follow-up). Docker maps it to the host gateway — provided automatically
 * on Docker Desktop (→ the host's loopback), and via the explicit
 * `host.docker.internal:host-gateway` ExtraHost on Linux (DockerDriver). The relay
 * itself never leaves loopback, so this adds no network-exposure surface (Q1-A).
 */
export const SANDBOX_RELAY_HOST = 'host.docker.internal'

/**
 * Rewrite a relay base URL's loopback host to the container-reachable
 * {@link SANDBOX_RELAY_HOST} for a sandboxed codex RELAY run. Port and path are
 * preserved; a non-loopback host (or an unparseable URL) passes through unchanged.
 */
export function rewriteRelayHostForSandbox(baseUrl: string): string {
  try {
    const u = new URL(baseUrl)
    // WHATWG URL returns IPv6 hosts bracketed (`[::1]`); cover both forms.
    const loopback = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])
    if (loopback.has(u.hostname)) {
      u.hostname = SANDBOX_RELAY_HOST
      return u.toString()
    }
    return baseUrl
  } catch {
    return baseUrl
  }
}

/**
 * The env-file additions a sandboxed codex RELAY run needs (ADR-0024 follow-up):
 * the per-run relay token as `CODEX_API_KEY` (the SDK only sets it as a host-process
 * env, which `docker exec --env-file` drops), plus NO_PROXY entries covering the
 * `host.docker.internal` hop and loopback so an in-container proxy cannot hijack it.
 */
export function codexRelaySandboxEnv(token: string): Record<string, string> {
  const noProxy = [SANDBOX_RELAY_HOST, '127.0.0.1', 'localhost', '::1'].join(',')
  return { CODEX_API_KEY: token, NO_PROXY: noProxy, no_proxy: noProxy }
}

/**
 * Append `KEY=VALUE` lines to a docker `--env-file` (later keys override earlier
 * ones, so these win over the base env the wrapper wrote). Values are trimmed of
 * trailing whitespace per docker's env-file convention; the relay token (UUID) and
 * NO_PROXY (comma list) carry no characters needing escaping.
 */
function appendEnvFile(envFile: string, vars: Record<string, string>): void {
  const lines = Object.entries(vars)
    .map(([k, v]) => `${k}=${v.replace(/\s+$/, '')}`)
    .join('\n')
  appendFileSync(envFile, lines + '\n', 'utf-8')
}
