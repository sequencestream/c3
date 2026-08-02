/**
 * Cursor launch shaping: the argv and environment for one `cursor-agent -p` run.
 *
 * Everything Cursor can be told about a run is decided here, once, before the
 * process starts — the stream is read-only afterwards, so there is no second
 * chance to adjust permissions, mode or MCP wiring mid-turn.
 */
import type { DriverStartOptions } from '../types.js'

/** Where the CLI is and how this run is scoped to a data root. */
export interface CursorLaunchConfig {
  /** Absolute path of the `cursor-agent` executable (or a sandbox wrapper). */
  command: string
  /**
   * The `HOME` the run must see. Cursor has no data-root override env var: its
   * store is always `$HOME/.cursor`, so relocating the store means relocating
   * `HOME`. Absent ⇒ inherit the host's.
   */
  home?: string
}

/**
 * Raised when a run asks for something Cursor cannot honestly deliver. Failing to
 * start is the required outcome for an unavailable mode — silently running with
 * different permissions than the caller asked for is the one thing we must not do.
 */
export class CursorUnsupportedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CursorUnsupportedError'
  }
}

/**
 * Build the CLI argv for a run.
 *
 * `--output-format stream-json` is what makes the run observable; `-p` is what
 * makes it non-interactive. `--trust` is required because a headless run cannot
 * answer the workspace-trust prompt, and c3 only ever launches inside a workspace
 * the user already registered.
 */
export function cursorExecArgs(opts: DriverStartOptions, _config: CursorLaunchConfig): string[] {
  // Cursor's plan surface is not proven read-only, so a plan run is refused
  // rather than quietly started in a writable mode.
  if (opts.actionMode === 'plan') {
    throw new CursorUnsupportedError(
      'cursor: plan mode is unavailable — Cursor cannot guarantee a read-only run, and c3 will not silently downgrade it to a writable one',
    )
  }

  const args = ['-p', '--output-format', 'stream-json', '--trust', '--workspace', opts.cwd]

  // The permission decision is launch-time and total: either every tool runs
  // unattended, or the user's own ~/.cursor allowlist governs. There is no
  // per-tool channel to fall back on, so nothing here promises one.
  if (opts.toolGate === 'never-ask') args.push('--force')

  if (opts.model) args.push('--model', opts.model)

  // Injected MCP servers are pre-approved for this run; without this the CLI
  // leaves them "needs approval" and the model silently loses those tools.
  if (opts.mcpServers && Object.keys(opts.mcpServers).length > 0) args.push('--approve-mcps')

  // Resume replays Cursor's own stored context — the recovery truth.
  if (opts.resume) args.push('--resume', opts.resume)

  // The prompt is positional and must come last.
  args.push(opts.prompt)
  return args
}

/** Build the run's environment. */
export function cursorExecEnv(
  opts: DriverStartOptions,
  config: CursorLaunchConfig,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...opts.envOverrides }
  if (config.home) env.HOME = config.home

  // c3's MCP servers listen on the loopback interface; a host-wide proxy would
  // otherwise swallow those requests and the tools would vanish with no error.
  if (opts.mcpServers && Object.keys(opts.mcpServers).length > 0) {
    env.NO_PROXY = mergeNoProxy(env.NO_PROXY)
    env.no_proxy = mergeNoProxy(env.no_proxy)
  }
  return env
}

/** Ensure loopback hosts bypass any inherited proxy, preserving existing entries. */
function mergeNoProxy(current: string | undefined): string {
  const loopback = ['127.0.0.1', 'localhost', '::1']
  const existing = (current ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
  for (const host of loopback) if (!existing.includes(host)) existing.push(host)
  return existing.join(',')
}
