/**
 * Agent resolution + degradation chain (server refactor 3/3, ADR-0009 — sunk from
 * the old root `settings.ts`).
 *
 * An *agent* names a set of Claude Code launch overrides (baseUrl / apiKey /
 * model). A session launches Claude Code using its assigned agent, or the
 * default agent when unassigned (see {@link resolveSessionLaunch}). The built-in
 * system agent ({@link SYSTEM_AGENT_ID}) always exists, has empty overrides, and
 * cannot be removed — binding to it means "no overrides, use the SDK defaults".
 *
 * These readers call `loadSettings` / `getSessionAgentId` from `kernel/config`
 * (the persistence store); the pure agent-shape normalizers come from
 * `./normalize` (a leaf). config → normalize and readers → config + normalize,
 * so the boundary stays acyclic.
 */
import type { AgentConfig, SystemSettings } from '@ccc/shared/protocol'
import { SYSTEM_AGENT_ID } from '@ccc/shared/protocol'
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
 * Map one agent's Claude config to SDK launch overrides. Empty fields produce
 * no override, so the system agent yields `{}` (SDK defaults apply). Shared by
 * session launches ({@link resolveSessionLaunch}) and consensus advisor calls.
 */
export function launchForAgent(agent: AgentConfig): {
  envOverrides?: Record<string, string>
  model?: string
} {
  const env: Record<string, string> = {}
  if (agent.baseUrl) env.ANTHROPIC_BASE_URL = agent.baseUrl
  if (agent.apiKey) {
    // Cover both auth schemes: ANTHROPIC_API_KEY for first-party, ANTHROPIC_AUTH_TOKEN
    // for gateways/proxies that expect a bearer token.
    env.ANTHROPIC_API_KEY = agent.apiKey
    env.ANTHROPIC_AUTH_TOKEN = agent.apiKey
  }
  // WORKAROUND (remove later): recent Claude Code introduced an "adaptive
  // thinking" mechanism that changes the request message format. Third-party
  // Anthropic-compatible gateways (e.g. DeepSeek) don't yet accept that format —
  // they reject the inline `system`-role messages with a 400
  // (`messages[].role: unknown variant system`). CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING=1
  // turns off just that mechanism, restoring the compatible message format while
  // keeping CLAUDE.md/memory, Skills, and hooks (unlike the heavier
  // CLAUDE_CODE_SIMPLE=1 / `--bare` fallback).
  // REMOVE this injection once the third-party providers support the new format.
  // Applied only to non-system agents; the system agent (first-party Anthropic)
  // needs no fallback.
  if (agent.id !== SYSTEM_AGENT_ID) env.CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING = '1'
  return {
    ...(Object.keys(env).length > 0 ? { envOverrides: env } : {}),
    ...(agent.model ? { model: agent.model } : {}),
  }
}

/**
 * Resolve how to launch Claude Code for a session: the resolved agent's id plus
 * its Claude config mapped to SDK launch overrides.
 */
export function resolveSessionLaunch(sessionId: string | null): {
  agentId: string
  envOverrides?: Record<string, string>
  model?: string
} {
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
): { agentId: string; envOverrides?: Record<string, string>; model?: string } | null {
  const chain = getDegradationChain()
  if (!chain || chainIndex < 0 || chainIndex >= chain.length) return null
  const agent = resolveAgent(chain[chainIndex])
  return { agentId: agent.id, ...launchForAgent(agent) }
}

/**
 * The agents that vote in a consensus round: every *enabled* agent except the
 * one the session itself runs on (`currentAgentId`, already resolved). Disabled
 * agents never vote.
 */
export function consensusVoters(currentAgentId: string | null): AgentConfig[] {
  return enabledAgents().filter((a) => a.id !== currentAgentId)
}
