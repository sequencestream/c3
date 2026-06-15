/**
 * Sandbox agent selection (ADR-0024).
 *
 * When a worktree intent-dev run is sandbox-enabled, exactly one custom agent is
 * picked at random from the normalized pool (`WorkspaceSandboxConfig.agentIds`).
 * The pick decides the run's vendor (hence the container binary) and provider env.
 *
 * This is a pure decision (no side effects, no I/O): the resolver is injected so
 * the kernel boundary stays free of `config`/`agent-config` imports, and the RNG
 * is injected so tests are deterministic. The random strategy does NOT health-check
 * or retry — a bad pick hard-fails the run (deny-by-default, user-confirmed).
 */
import type { VendorId } from '@ccc/shared/protocol'

/** Why a sandbox agent pick was rejected (each maps to a hard-fail of the run). */
export type SandboxPickReason =
  | 'empty-pool'
  | 'unavailable'
  | 'unsupported-vendor'
  | 'unsupported-wire'

/** A successful pick (an agent id) or a typed rejection. */
export type SandboxAgentPick =
  | { ok: true; agentId: string }
  | { ok: false; reason: SandboxPickReason; agentId?: string }

/**
 * Randomly pick one agent from the normalized sandbox pool, validating it can
 * actually drive a sandboxed run.
 *
 * @param pool     The normalized `agentIds` (already filtered to enabled + custom).
 * @param resolve  Resolves an id to its agent shell. Falls back to a default/system
 *                 agent when the id is unknown (the kernel `resolveAgent` contract),
 *                 so a `resolved.id !== id` mismatch means the picked agent was
 *                 deleted after the config was saved → unavailable.
 * @param rand     RNG in `[0, 1)` (injected for tests; defaults to `Math.random`).
 * @returns A successful pick, or a typed rejection the caller turns into a hard-fail.
 */
export function pickSandboxAgent(
  pool: readonly string[],
  resolve: (id: string) => { id: string; vendor: VendorId; wireApi?: 'responses' | 'chat' },
  rand: () => number = Math.random,
): SandboxAgentPick {
  if (pool.length === 0) return { ok: false, reason: 'empty-pool' }

  const idx = Math.min(Math.floor(rand() * pool.length), pool.length - 1)
  const pickedId = pool[idx]
  const resolved = resolve(pickedId)

  // A deleted agent falls back to the default/system agent → id mismatch.
  if (resolved.id !== pickedId) return { ok: false, reason: 'unavailable', agentId: pickedId }

  // Sandbox container vendor support (ADR-0024):
  //  - claude: the original supported vendor (provider env via the claude wrapper).
  //  - codex DIRECT (wireApi=responses): the custom provider serves Responses
  //    natively; baseUrl/model ride the wrapper argv and the apiKey is mirrored
  //    into the env-file as CODEX_API_KEY (codexDirectSandboxEnv). Supported.
  //  - codex RELAY (wireApi=chat): the provider is Chat-only, so codex reaches c3's
  //    in-process Responses→Chat relay — which stays loopback-bound — across the
  //    container boundary via `host.docker.internal` (base_url rewrite) with the
  //    per-run token mirrored into the env-file (ADR-0024 follow-up). Supported.
  //  - system-login codex (wireApi undefined): no injected provider credentials reach
  //    the container ⇒ unsupported-wire (a later intent).
  //  - anything else: no container provider plumbing yet ⇒ unsupported-vendor.
  // A bad pick hard-fails this run rather than silently degrading.
  if (resolved.vendor === 'claude') return { ok: true, agentId: pickedId }
  if (resolved.vendor === 'codex') {
    if (resolved.wireApi === 'responses' || resolved.wireApi === 'chat') {
      return { ok: true, agentId: pickedId }
    }
    return { ok: false, reason: 'unsupported-wire', agentId: pickedId }
  }
  return { ok: false, reason: 'unsupported-vendor', agentId: pickedId }
}
