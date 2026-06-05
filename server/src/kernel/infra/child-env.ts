/**
 * Claude Code child-process discovery + env injection (server refactor 3/3,
 * ADR-0009 — sunk from the old root `claude.ts`). Pure process/transport infra:
 * locate the `claude` executable on the host, and build the spawned child's
 * environment (the keepalive/transport-resilience defaults plus the active
 * agent's overrides). No SDK/run/permission knowledge.
 */
import { spawnSync } from 'node:child_process'

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

/**
 * Keepalive / transport-resilience env vars injected into every Claude Code child
 * `runClaude` spawns — the **prevention layer** (scheme E, first line of defence)
 * against `socket connection was closed unexpectedly`, the Bun/JSC + CC SDK runtime
 * defect that fatally trips long agentic turns mid-session. These lower the *rate*
 * of disconnects at the source; the kernel auto-`resume` (AS-R18/R19) recovers from
 * the ones that still happen. Values are tunable defaults — and **lowest priority**:
 * a same-named value the user (shell `process.env`) or agent (`envOverrides`) set
 * always wins (see {@link buildChildEnv}).
 */
export const KEEPALIVE_ENV_DEFAULTS: Record<string, string> = {
  // CC keeps the remote (server↔SDK) connection warm with periodic keepalives.
  CLAUDE_CODE_REMOTE_SEND_KEEPALIVES: 'true',
  // Tolerate a longer idle gap before Bun's HTTP client drops the socket.
  BUN_CONFIG_HTTP_IDLE_TIMEOUT: '120',
  // Retry transient HTTP failures a few times before surfacing an error.
  BUN_CONFIG_HTTP_RETRY_COUNT: '3',
}

/**
 * Build the env passed to a spawned Claude Code child. Precedence (low → high):
 * keepalive defaults < `process.env` (user shell) < `envOverrides` (active agent).
 * So keepalive vars are always present yet never clobber a value the user/agent set
 * explicitly (user priority). `env` must carry the *full* environment, so we merge
 * over `process.env` rather than replace it.
 */
export function buildChildEnv(envOverrides?: Record<string, string>): Record<string, string> {
  return {
    ...KEEPALIVE_ENV_DEFAULTS,
    ...(process.env as Record<string, string>),
    ...(envOverrides ?? {}),
  }
}
