/**
 * Cursor launch shaping: the SDK options for one agent and one turn.
 *
 * Everything Cursor can be told about a run is decided here, in two places the
 * SDK draws a hard line between. {@link cursorAgentOptions} builds what is fixed
 * for the life of an agent (working directories, sandbox, settings layers, MCP
 * servers, credentials); {@link cursorSendOptions} builds what may change per
 * turn (model, conversation mode). c3 rebuilds both each turn because a c3
 * session's mode can change between turns, and the SDK honours a per-send `mode`.
 */
import type { DriverStartOptions, RemoteMcpServer } from '../types.js'

/**
 * The model a run uses when the caller names none. `auto` is Cursor's own
 * server-side selection; a local agent requires *some* selection, so this is the
 * one place a default is chosen rather than each call site inventing one.
 */
export const DEFAULT_CURSOR_MODEL = 'auto'

/** Credentials and data-root scoping for a run. */
export interface CursorLaunchConfig {
  /**
   * The Cursor API key the SDK authenticates with. Unlike the CLI, the SDK does
   * NOT read the `cursor-agent login` credential from the OS keychain — an API
   * key is the only credential it accepts — so a run without one cannot start.
   * Absent ⇒ the driver falls back to `CURSOR_API_KEY` from the environment and
   * fails at the door when that is empty too.
   */
  apiKey?: string
}

/**
 * Raised when a run asks for something Cursor cannot honestly deliver. Failing to
 * start is the required outcome — silently running with different permissions,
 * or against no credential at all, is the one thing we must not do.
 */
export class CursorUnsupportedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CursorUnsupportedError'
  }
}

/**
 * The credential for a run, in precedence order: the adapter's resolved config,
 * then this run's `CURSOR_API_KEY` override (how the bound agent's own key
 * reaches the driver — the SDK runs in-process, so the run's env map is the
 * credential channel, not a child process's environment), then the ambient
 * `CURSOR_API_KEY`.
 *
 * Throws when none exists, because the alternative is a run that starts, burns a
 * turn, and ends with the SDK's opaque `Invalid User API Key` — an error the
 * operator cannot act on from where it surfaces.
 */
export function resolveCursorApiKey(
  config: CursorLaunchConfig,
  envOverrides?: Record<string, string>,
): string {
  const key =
    config.apiKey?.trim() ||
    envOverrides?.CURSOR_API_KEY?.trim() ||
    process.env.CURSOR_API_KEY?.trim()
  if (!key) {
    // Both places a key can come from are named, because the operator reading
    // this has no way to know which one applies to their deployment.
    throw new CursorUnsupportedError(
      "cursor: no API key — the Cursor SDK authenticates with an API key only (a `cursor-agent login` session does not apply). Fill the agent's `apiKey` field in the settings panel, or set CURSOR_API_KEY in the server environment.",
    )
  }
  return key
}

/**
 * The conversation mode for a turn. The neutral `plan` action mode maps to
 * Cursor's own `plan` mode, which the SDK exposes as a first-class conversation
 * mode rather than a permission flag; `build` maps to `agent`.
 */
export function cursorMode(opts: DriverStartOptions): 'agent' | 'plan' {
  return opts.actionMode === 'plan' ? 'plan' : 'agent'
}

/**
 * Whether Cursor's Auto-review classifier gates this run's tool calls.
 *
 * The SDK has no per-tool approval channel — nothing can pause a run to ask a
 * human — so the neutral tool gate cannot be honoured call-by-call. What it CAN
 * do is choose between "every tool runs unattended" and "Cursor's own classifier
 * vets each call", which is the closest honest reading of the gate: only an
 * explicit `never-ask` turns the vetting off.
 */
export function cursorAutoReview(opts: DriverStartOptions): boolean {
  return opts.toolGate !== 'never-ask'
}

/**
 * Translate the neutral remote-MCP descriptors into the SDK's `McpServerConfig`
 * map. c3's servers are loopback HTTP, so they cross as `http` entries; a
 * `bearerTokenEnvVar` names an env var whose value becomes the Authorization
 * header, since the SDK config takes headers directly rather than an env-var
 * indirection. Returns `undefined` when there is nothing to attach.
 */
export function cursorMcpServers(
  servers: Record<string, RemoteMcpServer> | undefined,
): Record<string, { type: 'http'; url: string; headers?: Record<string, string> }> | undefined {
  if (!servers) return undefined
  const entries = Object.entries(servers)
  if (entries.length === 0) return undefined
  const out: Record<string, { type: 'http'; url: string; headers?: Record<string, string> }> = {}
  for (const [name, server] of entries) {
    const token = server.bearerTokenEnvVar ? process.env[server.bearerTokenEnvVar] : undefined
    out[name] = {
      type: 'http',
      url: server.url,
      ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}),
    }
  }
  return out
}

/** The agent-scoped SDK options: everything fixed for the life of the agent. */
export interface CursorAgentOptions {
  model: { id: string }
  apiKey: string
  mode: 'agent' | 'plan'
  local: {
    cwd: string | string[]
    autoReview: boolean
    sandboxOptions?: { enabled: boolean }
    settingSources: Array<'project' | 'user'>
  }
  mcpServers?: Record<string, { type: 'http'; url: string; headers?: Record<string, string> }>
}

/**
 * Build the agent-scoped options.
 *
 * `additionalDirectories` ride in `local.cwd` as extra roots — the SDK's own
 * multi-root shape — so a run may read outside its worktree exactly where the
 * launch layer permitted it, and nowhere else.
 *
 * The settings layers are pinned to `project` + `user`: `project` is what makes
 * the workspace's rules, `AGENTS.md` and c3's mounted `.cursor/skills` visible to
 * the run, and `user` is the operator's own machine-wide configuration. The
 * remaining layers (`team`, `mdm`, `plugins`) are deliberately not loaded — c3
 * has not verified what they inject into a headless run.
 *
 * A sandboxed session maps to the SDK's own sandbox rather than c3's arapuca
 * wrapper: the SDK runs inside the c3 server process, so there is no child
 * process for a wrapper script to narrow.
 */
export function cursorAgentOptions(
  opts: DriverStartOptions,
  config: CursorLaunchConfig,
): CursorAgentOptions {
  const roots =
    opts.additionalDirectories && opts.additionalDirectories.length > 0
      ? [opts.cwd, ...opts.additionalDirectories]
      : opts.cwd
  const mcpServers = cursorMcpServers(opts.mcpServers)
  return {
    model: { id: opts.model ?? DEFAULT_CURSOR_MODEL },
    apiKey: resolveCursorApiKey(config, opts.envOverrides),
    mode: cursorMode(opts),
    local: {
      cwd: roots,
      autoReview: cursorAutoReview(opts),
      // The neutral sandbox flag: c3's arapuca wrapper cannot narrow a runtime
      // that executes in c3's own process, so Cursor's own sandbox is what
      // delivers the isolation the session asked for.
      ...(opts.sandboxed ? { sandboxOptions: { enabled: true } } : {}),
      settingSources: ['project', 'user'],
    },
    ...(mcpServers ? { mcpServers } : {}),
  }
}

/** The per-turn SDK options. */
export interface CursorSendOptions {
  model: { id: string }
  mode: 'agent' | 'plan'
}

/**
 * Build the per-turn options. Both fields are re-stated every turn on purpose:
 * a resumed agent was created with the mode and model of an *earlier* turn, and
 * restating them is what makes this turn run under the session's current ones.
 */
export function cursorSendOptions(opts: DriverStartOptions): CursorSendOptions {
  return { model: { id: opts.model ?? DEFAULT_CURSOR_MODEL }, mode: cursorMode(opts) }
}

/**
 * The turn's user message.
 *
 * Cursor has no separate system channel, so the neutral `systemInstruction`
 * rides as a leading paragraph of the user text — byte-identical across turns,
 * which is the stable prefix a prompt cache keys off. Images cross as base64
 * inline data, which the SDK takes natively.
 */
export function cursorUserMessage(opts: DriverStartOptions): {
  text: string
  images?: Array<{ data: string; mimeType: string }>
} {
  const system = opts.systemInstruction?.trim()
  const text = system ? `${system}\n\n${opts.prompt}` : opts.prompt
  const images = opts.images?.map((image) => ({ data: image.data, mimeType: image.mediaType }))
  return { text, ...(images && images.length > 0 ? { images } : {}) }
}
