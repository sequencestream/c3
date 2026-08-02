/**
 * Cursor MCP wiring: injection of c3's loopback MCP servers into the config the
 * CLI reads, and a post-injection self-check that they are actually visible.
 *
 * Cursor discovers MCP servers from `mcp.json` — either the project's
 * `.cursor/mcp.json` or the data root's `~/.cursor/mcp.json`. c3 injects into the
 * DATA ROOT copy, never the project one: writing into a workspace would leave a
 * `mcp.json` behind in the user's repository. Injection MERGES with whatever the
 * user already has and returns a disposer that restores the prior bytes, so a run
 * neither clobbers the user's own servers nor strands c3's transient ones.
 *
 * The self-check runs `cursor-agent mcp list` and fails closed if a server c3
 * needs is not visible. "Visible" means the CLI reports the server at all — an
 * approval-pending or still-connecting server is configured correctly (the run
 * carries `--approve-mcps` and the loopback endpoint is up by launch), but a
 * server the CLI does not know about means injection failed and the run would
 * silently lose those tools, so it must not start.
 */
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync, rmSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { writeAtomic } from '../../../config/store.js'
import type { RemoteMcpServer } from '../types.js'

/** Raised when a required MCP server cannot be confirmed visible — the run must not start. */
export class CursorMcpError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CursorMcpError'
  }
}

/** Path of the data-root MCP config for a given HOME. */
export function cursorMcpConfigPath(home: string): string {
  return join(home, '.cursor', 'mcp.json')
}

/** The on-disk shape Cursor expects: `{ mcpServers: { <name>: { url } } }`. */
interface CursorMcpFile {
  mcpServers?: Record<string, { url?: string; [key: string]: unknown }>
}

function readConfig(path: string): { config: CursorMcpFile; raw: string | null } {
  if (!existsSync(path)) return { config: {}, raw: null }
  const raw = readFileSync(path, 'utf8')
  try {
    const parsed = JSON.parse(raw) as CursorMcpFile
    return { config: parsed && typeof parsed === 'object' ? parsed : {}, raw }
  } catch {
    // A corrupt user config must not be silently overwritten; surface it.
    throw new CursorMcpError(`cursor: cannot parse existing MCP config at ${path}`)
  }
}

/**
 * Merge c3's servers into the data-root `mcp.json`, preserving the user's own
 * entries, and return a disposer that restores the previous file (removing it if
 * it did not exist). Idempotent for the c3 server names: re-injecting overwrites
 * only c3's own entries.
 */
export function injectCursorMcp(
  home: string,
  servers: Record<string, RemoteMcpServer>,
): { dispose: () => void; injected: string[] } {
  const path = cursorMcpConfigPath(home)
  const { config, raw } = readConfig(path)
  const existing = config.mcpServers ?? {}
  const injected = Object.keys(servers)

  const merged: CursorMcpFile = {
    ...config,
    mcpServers: {
      ...existing,
      ...Object.fromEntries(injected.map((name) => [name, { url: servers[name].url }])),
    },
  }
  mkdirSync(dirname(path), { recursive: true })
  writeAtomic(path, merged)

  return {
    injected,
    dispose: () => {
      try {
        if (raw === null) rmSync(path, { force: true })
        else writeFileSync(path, raw)
      } catch {
        // Restore is best-effort; a failed restore must not mask the run's outcome.
      }
    },
  }
}

/** Parse `mcp list` output (`<name>: <status>` lines) into a name→status map. */
export function parseMcpList(output: string): Map<string, string> {
  const result = new Map<string, string>()
  for (const line of output.split('\n')) {
    const match = /^([A-Za-z0-9_.-]+):\s*(.+)$/.exec(line.trim())
    if (match) result.set(match[1], match[2].trim())
  }
  return result
}

/** CLI runner seam, so tests can fake `mcp list`. */
export type CursorCliRunner = (argv: string[]) => {
  code: number | null
  output: string
  timedOut?: boolean
}

/**
 * `mcp list` connects to every configured server, so bound it — a slow one must
 * not stall the run. A responsive server answers well under a second; c3's own
 * loopback servers keep the probe connection open and hit this bound, which the
 * caller treats as "unverifiable, proceed" rather than a failure.
 */
const MCP_LIST_TIMEOUT_MS = 5_000

const defaultRunner =
  (command: string, env: NodeJS.ProcessEnv, cwd: string): CursorCliRunner =>
  (argv) => {
    const r = spawnSync(command, argv, { encoding: 'utf8', env, cwd, timeout: MCP_LIST_TIMEOUT_MS })
    const timedOut =
      (r.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT' || r.signal === 'SIGTERM'
    return { code: r.status, output: (r.stdout ?? '') + (r.stderr ?? ''), timedOut }
  }

/** The outcome of an MCP visibility self-check. */
export type CursorMcpCheck =
  | { outcome: 'visible' }
  | { outcome: 'missing'; missing: string[] }
  | { outcome: 'unverifiable'; detail: string }

/**
 * Check whether every required server is visible to the CLI.
 *
 * Only a *confirmed* absence — `mcp list` ran cleanly (exit 0) yet does not list a
 * required server — is `missing`, and that is what must hard-fail the run (the
 * model would otherwise run without tools it was promised). A check that could
 * not run to completion (timeout, or the CLI erroring) is `unverifiable`, NOT
 * missing: c3's own loopback servers sometimes keep `mcp list`'s probe connection
 * open until it times out, and treating that as "missing" would wrongly refuse a
 * run whose actual `--approve-mcps` connection works fine.
 */
export function checkCursorMcp(required: readonly string[], run: CursorCliRunner): CursorMcpCheck {
  if (required.length === 0) return { outcome: 'visible' }
  const { code, output, timedOut } = run(['mcp', 'list'])
  if (timedOut) return { outcome: 'unverifiable', detail: 'mcp list timed out' }
  if (code !== 0) {
    return {
      outcome: 'unverifiable',
      detail: `mcp list exited ${code}: ${output.trim().slice(0, 200)}`,
    }
  }
  const visible = parseMcpList(output)
  const missing = required.filter((name) => !visible.has(name))
  if (missing.length > 0) return { outcome: 'missing', missing }
  return { outcome: 'visible' }
}

/**
 * Inject c3's servers and self-check their visibility, returning the disposer to
 * restore the config once the run ends. A confirmed `missing` hard-fails (the run
 * must not start without promised tools); an `unverifiable` check logs a warning
 * and proceeds — the run's own `--approve-mcps` connection is authoritative.
 */
export function prepareCursorMcp(
  home: string,
  servers: Record<string, RemoteMcpServer>,
  command: string,
  env: NodeJS.ProcessEnv,
  cwd: string,
): { dispose: () => void } {
  const names = Object.keys(servers)
  if (names.length === 0) return { dispose: () => undefined }
  const { dispose, injected } = injectCursorMcp(home, servers)
  const check = checkCursorMcp(injected, defaultRunner(command, env, cwd))
  if (check.outcome === 'missing') {
    dispose()
    throw new CursorMcpError(
      `cursor: required MCP server(s) not visible after injection: ${check.missing.join(', ')}`,
    )
  }
  if (check.outcome === 'unverifiable') {
    console.warn(
      `[c3] cursor: MCP self-check inconclusive (${check.detail}); proceeding — the run's own connection is authoritative`,
    )
  }
  return { dispose }
}
