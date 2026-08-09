/**
 * Cursor launch shaping: the argv and environment for one `cursor-agent` turn.
 *
 * Everything c3 can tell Cursor about a run is decided here, as pure functions
 * over the neutral start options — no process is spawned and no state is touched,
 * so a test can assert the exact command line a given neutral configuration
 * produces. {@link cursorCliArgs} builds the command, {@link cursorCliEnv} builds
 * the environment, and {@link cursorUserMessage} builds the text that goes on
 * stdin.
 *
 * @module
 */
import { inheritedEnv } from '../process-env.js'
import type { DriverStartOptions } from '../types.js'
import { withLoopbackNoProxy } from '../../../infra/no-proxy.js'

/**
 * The model a run uses when the caller names none. `auto` is Cursor's own
 * server-side selection; a run requires *some* selection, so this is the one
 * place a default is chosen rather than each call site inventing one.
 */
export const DEFAULT_CURSOR_MODEL = 'auto'

/** Credentials for a run. */
export interface CursorLaunchConfig {
  /**
   * The Cursor API key, when the bound agent carries one. Absent is normal and
   * not an error: `cursor-agent` then authenticates with the subscription login
   * in the host keychain, which is the credential most operators actually have.
   */
  apiKey?: string
}

/**
 * Raised when a run asks for something Cursor cannot honestly deliver. Failing to
 * start is the required outcome — silently running with different permissions is
 * the one thing we must not do.
 */
export class CursorUnsupportedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CursorUnsupportedError'
  }
}

/**
 * The credential for a run, in precedence order: the adapter's resolved config,
 * then this run's `CURSOR_API_KEY` override (how a bound agent's own key reaches
 * the driver), then the ambient `CURSOR_API_KEY`.
 *
 * Returns `undefined` when there is none, which is a legitimate configuration
 * rather than a failure: the CLI falls back to the keychain login. A run that has
 * neither fails inside the child, where the CLI's own message says which of the
 * two is missing far better than a guess made here could.
 */
export function resolveCursorApiKey(
  config: CursorLaunchConfig,
  envOverrides?: Record<string, string>,
): string | undefined {
  return (
    config.apiKey?.trim() ||
    envOverrides?.CURSOR_API_KEY?.trim() ||
    process.env.CURSOR_API_KEY?.trim() ||
    undefined
  )
}

/**
 * The conversation mode for a turn. The neutral `plan` action mode maps to
 * Cursor's own `plan` mode, which is a first-class conversation mode rather than
 * a permission flag; `build` maps to the default agent mode, which has no flag.
 */
export function cursorMode(opts: DriverStartOptions): 'agent' | 'plan' {
  return opts.actionMode === 'plan' ? 'plan' : 'agent'
}

/**
 * Whether Cursor's Auto-review classifier gates this run's tool calls.
 *
 * There is no per-tool approval channel — nothing can pause a headless run to ask
 * a human — so the neutral tool gate cannot be honoured call by call. What it CAN
 * choose is between "every tool runs unattended" and "Cursor's own classifier
 * vets each call", which is the closest honest reading of the gate: only an
 * explicit `never-ask` turns the vetting off.
 */
export function cursorAutoReview(opts: DriverStartOptions): boolean {
  return opts.toolGate !== 'never-ask'
}

/**
 * Build the command line for one turn.
 *
 * `--trust` is unconditional: without it the CLI stops at its workspace-trust
 * prompt and exits before doing any work, which in a headless run is simply a
 * failure. c3 has already decided this directory is the run's workspace, so the
 * prompt has nothing left to ask.
 *
 * `--workspace` is passed even though the child also starts in `cwd`, because it
 * is what selects the project-scoped configuration layer the run loads.
 *
 * A resumed turn names its chat; a new one names the id c3 minted before the
 * launch, so either way the run's identity is fixed before the first frame.
 */
export function cursorCliArgs(opts: DriverStartOptions, sessionId: string): string[] {
  const args = [
    '--print',
    '--output-format',
    'stream-json',
    '--trust',
    '--workspace',
    opts.cwd,
    '--model',
    opts.model ?? DEFAULT_CURSOR_MODEL,
  ]

  for (const dir of opts.additionalDirectories ?? []) {
    args.push('--add-dir', dir)
  }

  if (cursorMode(opts) === 'plan') args.push('--mode', 'plan')

  if (cursorAutoReview(opts)) args.push('--auto-review')
  else args.push('--force')

  // arapuca already confines the process, and a second sandbox layer inside it
  // fails on the syscalls the outer one has taken away. A sandboxed run without a
  // wrapper has no outer layer, so Cursor's own sandbox is what provides it.
  if (opts.sandboxWrapperPath) args.push('--sandbox', 'disabled')
  else if (opts.sandboxed) args.push('--sandbox', 'enabled')

  if (opts.mcpServers && Object.keys(opts.mcpServers).length > 0) args.push('--approve-mcps')

  args.push('--resume', sessionId)
  return args
}

/**
 * Build the child's complete environment.
 *
 * `envOverrides` carries the bound agent's own credential, so it is layered over
 * the inherited environment rather than beside it. c3's MCP servers are on the
 * loopback interface, which an operator's ambient proxy would otherwise swallow.
 */
export function cursorCliEnv(
  opts: DriverStartOptions,
  config: CursorLaunchConfig,
): Record<string, string> {
  const env = inheritedEnv()
  if (opts.envOverrides) Object.assign(env, opts.envOverrides)
  const apiKey = resolveCursorApiKey(config, opts.envOverrides)
  if (apiKey) env.CURSOR_API_KEY = apiKey
  if (opts.mcpServers && Object.keys(opts.mcpServers).length > 0) {
    env.NO_PROXY = withLoopbackNoProxy(env.NO_PROXY)
    env.no_proxy = withLoopbackNoProxy(env.no_proxy)
  }
  return env
}

/**
 * The turn's prompt text.
 *
 * Cursor has no separate system channel, so the neutral `systemInstruction` rides
 * as a leading paragraph — byte-identical across turns, which is the stable
 * prefix a prompt cache keys off.
 */
export function cursorUserMessage(opts: DriverStartOptions): string {
  const system = opts.systemInstruction?.trim()
  return system ? `${system}\n\n${opts.prompt}` : opts.prompt
}
