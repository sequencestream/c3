/**
 * Claude Code child-process discovery + env injection (server refactor 3/3,
 * ADR-0009 — sunk from the old root `claude.ts`). Pure process/transport infra:
 * locate the `claude` executable on the host, and build the spawned child's
 * environment (the keepalive/transport-resilience defaults plus the active
 * agent's overrides). No SDK/run/permission knowledge.
 *
 * Binary discovery itself now lives in the vendor-agnostic ProcessLauncher
 * (ADR-0012, `agent/process/launcher.ts`); the two functions below are
 * Claude-pinned shims that delegate to it, preserving their names, the
 * `CLAUDE_PATH` override, and the exact behavior the 4 runtime call sites rely on.
 */
import { lookupCommand, resolve as resolveHostBinary } from '../agent/process/launcher.js'
import { withLoopbackNoProxy } from './no-proxy.js'

/**
 * The platform-correct "find `claude` on PATH" command. Thin Claude-pinned wrapper
 * over the launcher's vendor-agnostic {@link lookupCommand} — kept for the existing
 * `child-env.test.ts` seam and any caller still referencing the Claude-specific name.
 */
export function claudeLookupCommand(
  platform: NodeJS.Platform = process.platform,
): [cmd: string, args: string[]] {
  return lookupCommand('claude', platform)
}

// In a Bun-compiled binary the SDK's bundled `cli-<platform>` lookup misses
// (no node_modules to walk). Resolve `claude` from the host PATH (via the
// ProcessLauncher, which also honors $CLAUDE_PATH) and hand it to the SDK via
// pathToClaudeCodeExecutable. Returns `undefined` (not `null`) when absent, the
// shape the SDK-option spread expects.
export function findClaudeExecutable(): string | undefined {
  return resolveHostBinary('claude') ?? undefined
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
 *
 * `NO_PROXY` is the ONE deliberate exception to that precedence: it is computed LAST
 * from whatever the host (or an agent override) set, with c3's loopback hosts
 * appended. Every c3 tool the child consumes — the intent / spec-query / work-event
 * MCP routes and the provider relay — is served on c3's own localhost origin, and a
 * host that exports `HTTP(S)_PROXY` without a bypass list makes the CLI send those
 * loopback requests to the proxy, which 502s. The MCP server then never connects and
 * its tools are silently ABSENT from the model's tool set (the model sees no
 * `mcp__c3__*` tool at all and can only guess names). Appending never narrows a
 * bypass list the user configured — see {@link withLoopbackNoProxy}. This mirrors
 * the codex driver, which already does the same for its own spawns.
 */
export function buildChildEnv(envOverrides?: Record<string, string>): Record<string, string> {
  const merged: Record<string, string> = {
    ...KEEPALIVE_ENV_DEFAULTS,
    ...(process.env as Record<string, string>),
    ...(envOverrides ?? {}),
  }
  merged.NO_PROXY = withLoopbackNoProxy(merged.NO_PROXY)
  merged.no_proxy = withLoopbackNoProxy(merged.no_proxy)
  return merged
}
