/**
 * Agent resolution + degradation chain (server refactor 3/3, ADR-0009 — sunk from
 * the old root `settings.ts`).
 *
 * An *agent* is a vendor-agnostic shell + a `vendor`-discriminated `config`
 * (claude ⇒ baseUrl / apiKey / model). A session launches using its assigned
 * agent, or the default agent when unassigned (see {@link resolveSessionLaunch}).
 * The built-in system agent ({@link SYSTEM_AGENT_ID}) always exists as a claude
 * agent with an empty default config, and cannot be removed — binding to it
 * means "no overrides, use the SDK defaults".
 *
 * These readers call `loadSettings` / `getSessionAgentId` from `kernel/config`
 * (the persistence store); the pure agent-shape normalizers come from
 * `./normalize` (a leaf). config → normalize and readers → config + normalize,
 * so the boundary stays acyclic.
 */
import type {
  AgentConfig,
  CodexApprovalPolicy,
  CodexSandboxMode,
  SystemSettings,
  VendorId,
} from '@ccc/shared/protocol'
import { SYSTEM_AGENT_ID } from '@ccc/shared/protocol'

/**
 * The launch overrides {@link launchForAgent} resolves from one agent. `claude`
 * routes provider config into {@link envOverrides} (env vars); driver-path vendors
 * (`codex`) carry raw {@link baseUrl}/{@link apiKey} their SDK takes as
 * constructor options; `model` is neutral. {@link codexPolicy} is the codex-only
 * launch-time gate. Empty/system-mode agents yield `{}` (no overrides).
 */
export interface LaunchOverrides {
  envOverrides?: Record<string, string>
  model?: string
  baseUrl?: string
  apiKey?: string
  codexPolicy?: { sandboxMode: CodexSandboxMode; approvalPolicy: CodexApprovalPolicy }
}
import { getSessionAgentId, loadSettings } from '../config/index.js'
import { systemAgent } from './normalize.js'

export {
  AGENT_ICON_MAX_CHARS,
  defaultSettings,
  normalizeDegradationChain,
  normalizeIcon,
  systemAgent,
} from './normalize.js'
export { isDegradableError, isSocketDisconnect } from './errors.js'

export function getDefaultAgentId(): string {
  return loadSettings().defaultAgentId
}

/**
 * The enabled agents only — the canonical "list of agents" every consumer pool
 * draws from (discussion participants, consensus voters, default-agent picker).
 * Back-compat: an agent with no `enabled` field counts as enabled. NOTE this is
 * deliberately NOT used by {@link resolveAgent}/{@link resolveSessionLaunch}: a
 * disabled agent is still a valid launch fallback so a session is never locked
 * out (AC-R10).
 */
export function enabledAgents(settings: SystemSettings = loadSettings()): AgentConfig[] {
  return settings.agents.filter((a) => a.enabled !== false)
}

/** The agent for an id, or the default agent if the id is null/unknown. */
export function resolveAgent(agentId: string | null): AgentConfig {
  const settings = loadSettings()
  const byId = agentId ? settings.agents.find((a) => a.id === agentId) : undefined
  return (
    byId ??
    settings.agents.find((a) => a.id === settings.defaultAgentId) ??
    settings.agents.find((a) => a.id === SYSTEM_AGENT_ID) ??
    systemAgent()
  )
}

/**
 * Map one agent's config to {@link LaunchOverrides}, routed by its `vendor` tag
 * and gated by its `configMode` (2026-06-06-007). `configMode: 'system'` ⇒ use
 * the vendor CLI's own config: NO provider override (`baseUrl`/`apiKey`/`model`
 * are ignored) — the old system-agent behaviour, now available on any vendor.
 * `configMode: 'custom'` ⇒ apply the provider triple. Codex's launch-time policy
 * gate (`sandboxMode`/`approvalPolicy`) is NOT a provider override, so it applies
 * in BOTH modes. Shared by session launches and consensus advisor calls.
 */
export function launchForAgent(agent: AgentConfig): LaunchOverrides {
  const env: Record<string, string> = {}
  let model: string | undefined
  let baseUrl: string | undefined
  let apiKey: string | undefined
  let codexPolicy: LaunchOverrides['codexPolicy']

  // `custom` applies the provider triple; `system` leaves it to the vendor CLI.
  const custom = agent.configMode === 'custom'

  switch (agent.vendor) {
    case 'claude': {
      if (custom) {
        const { baseUrl: u, apiKey: k, model: m } = agent.config
        if (u) env.ANTHROPIC_BASE_URL = u
        if (k) {
          // Cover both auth schemes: ANTHROPIC_API_KEY for first-party,
          // ANTHROPIC_AUTH_TOKEN for gateways/proxies that expect a bearer token.
          env.ANTHROPIC_API_KEY = k
          env.ANTHROPIC_AUTH_TOKEN = k
        }
        if (m) model = m
        // WORKAROUND (remove later): recent Claude Code introduced an "adaptive
        // thinking" mechanism that changes the request message format. Third-party
        // Anthropic-compatible gateways (e.g. DeepSeek) don't yet accept that format —
        // they reject the inline `system`-role messages with a 400
        // (`messages[].role: unknown variant system`). CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING=1
        // turns off just that mechanism, restoring the compatible message format while
        // keeping CLAUDE.md/memory, Skills, and hooks (unlike the heavier
        // CLAUDE_CODE_SIMPLE=1 / `--bare` fallback). REMOVE once third-party providers
        // support the new format. Only a `custom` claude agent is third-party; a
        // `system` claude agent (first-party Anthropic) skips this whole arm.
        env.CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING = '1'
      }
      break
    }
    case 'opencode': {
      // OpenCode runs as a shared c3-supervised server (2026-06-06-003), so only
      // the model is a per-run override; baseUrl/apiKey are server-level provider
      // config applied at supervisor boot, not per-run child env.
      if (custom && agent.config.model) model = agent.config.model
      break
    }
    case 'codex': {
      // Provider connection (custom only): raw baseUrl/apiKey for the Codex SDK
      // constructor (NOT env — CodexOptions.env replaces process.env), model neutral.
      if (custom) {
        const { baseUrl: u, apiKey: k, model: m } = agent.config
        if (u) baseUrl = u
        if (k) apiKey = k
        if (m) model = m
      }
      // The launch-time policy gate is the per-tool-approval substitute (008); it
      // is part of the codex config in BOTH modes, so always thread it through.
      codexPolicy = {
        sandboxMode: agent.config.sandboxMode,
        approvalPolicy: agent.config.approvalPolicy,
      }
      break
    }
  }

  return {
    ...(Object.keys(env).length > 0 ? { envOverrides: env } : {}),
    ...(model ? { model } : {}),
    ...(baseUrl ? { baseUrl } : {}),
    ...(apiKey ? { apiKey } : {}),
    ...(codexPolicy ? { codexPolicy } : {}),
  }
}

/**
 * Resolve how to launch Claude Code for a session: the resolved agent's id plus
 * its Claude config mapped to SDK launch overrides.
 */
export function resolveSessionLaunch(
  sessionId: string | null,
): { agentId: string } & LaunchOverrides {
  const agentId = sessionId ? getSessionAgentId(sessionId) : null
  const agent = resolveAgent(agentId)
  return { agentId: agent.id, ...launchForAgent(agent) }
}

/**
 * The degradation chain for the current settings. Returns undefined when
 * unconfigured — the caller then runs a single attempt with no fallback
 * (the existing behaviour). The returned array is always non-empty when
 * present (normalizeDegradationChain filters down to known agent ids).
 */
export function getDegradationChain(): string[] | undefined {
  return loadSettings().degradationChain
}

/**
 * Resolve an agent by its chain position, returning the same shape as
 * {@link resolveSessionLaunch}. Returns null when the chain is absent or
 * the index is out of range.
 */
export function resolveDegradationAgent(
  chainIndex: number,
): ({ agentId: string } & LaunchOverrides) | null {
  const chain = getDegradationChain()
  if (!chain || chainIndex < 0 || chainIndex >= chain.length) return null
  const agent = resolveAgent(chain[chainIndex])
  return { agentId: agent.id, ...launchForAgent(agent) }
}

/**
 * The agents that vote in a consensus round: every *enabled* agent except the
 * one the session itself runs on (`currentAgentId`, already resolved). Disabled
 * agents never vote. **Vendor-homogeneous** — only same-vendor agents are kept
 * (see {@link vendorScopedVoters}); cross-vendor agents never vote because tool
 * names and risk semantics are not comparable across vendors.
 */
export function consensusVoters(currentAgentId: string | null): AgentConfig[] {
  return vendorScopedVoters(currentAgentId).voters
}

/**
 * Consensus is **vendor-homogeneous** (2026-06-06-006 heterogeneous-tolerance):
 * voting is limited to agents of the **session's own vendor**, because a tool
 * name + risk meaning the voter must judge is not comparable across vendors
 * (a Claude `Bash` and a Codex `shell` are different verdicts). So this resolves
 * the session agent's vendor, keeps only same-vendor enabled non-self agents as
 * voters, and reports how many enabled non-self agents of a **different** vendor
 * were excluded — so the gateway can label the outcome honestly rather than
 * implying the whole heterogeneous table weighed in. A table where the session's
 * vendor is the only one present yields `voters: []` ⇒ consensus is skipped and
 * the human is prompted as usual (the existing no-voter fallback).
 */
export function vendorScopedVoters(currentAgentId: string | null): {
  voters: AgentConfig[]
  vendorScope: VendorId
  crossVendorExcluded: number
} {
  const vendorScope = resolveAgent(currentAgentId).vendor
  const others = enabledAgents().filter((a) => a.id !== currentAgentId)
  const voters = others.filter((a) => a.vendor === vendorScope)
  return { voters, vendorScope, crossVendorExcluded: others.length - voters.length }
}
