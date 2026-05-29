/**
 * System configuration for the agent module, persisted under `~/.c3/`:
 *   1. `settings.json` — the agent registry + which agent is the default.
 *   2. `state.json`    — per-session agent assignment (sessionId → agentId).
 *
 * An *agent* names a set of Claude Code launch overrides (baseUrl / apiKey /
 * model). A session launches Claude Code using its assigned agent, or the
 * default agent when unassigned (see {@link resolveSessionLaunch}). The built-in
 * system agent ({@link SYSTEM_AGENT_ID}) always exists, has empty overrides, and
 * cannot be removed — binding to it means "no overrides, use the SDK defaults".
 *
 * Both files are written atomically; on any read/parse error we fall back to a
 * clean default (system agent only) so c3 still boots.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { AgentConfig, SystemSettings } from '@ccc/shared/protocol'
import { SYSTEM_AGENT_ID } from '@ccc/shared/protocol'

interface SessionAgentState {
  version: 1
  /** sessionId → agentId. A missing entry means "use the default agent". */
  sessionAgents: Record<string, string>
}

function c3Dir(): string {
  return join(homedir(), '.c3')
}

function settingsFile(): string {
  return join(c3Dir(), 'settings.json')
}

function stateFile(): string {
  return join(c3Dir(), 'state.json')
}

function systemAgent(): AgentConfig {
  return { id: SYSTEM_AGENT_ID, name: 'System', baseUrl: '', apiKey: '', model: '' }
}

function defaultSettings(): SystemSettings {
  return { agents: [systemAgent()], defaultAgentId: SYSTEM_AGENT_ID }
}

function writeAtomic(file: string, data: unknown): void {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8')
  renameSync(tmp, file)
}

// ---- Settings (agent registry) ----

let settingsCache: SystemSettings | null = null

/**
 * Force the settings into a valid shape: a `system` agent always present (with
 * empty overrides) and `defaultAgentId` pointing at an existing agent.
 */
function normalize(raw: Partial<SystemSettings> | undefined): SystemSettings {
  const incoming = Array.isArray(raw?.agents) ? raw.agents : []
  const agents: AgentConfig[] = [systemAgent()]
  for (const a of incoming) {
    if (!a || typeof a !== 'object') continue
    const id = typeof a.id === 'string' && a.id ? a.id : randomUUID()
    if (id === SYSTEM_AGENT_ID) continue // system agent is fixed; ignore overrides
    if (agents.some((x) => x.id === id)) continue // de-dupe
    agents.push({
      id,
      name: typeof a.name === 'string' && a.name.trim() ? a.name.trim() : id,
      baseUrl: typeof a.baseUrl === 'string' ? a.baseUrl.trim() : '',
      apiKey: typeof a.apiKey === 'string' ? a.apiKey.trim() : '',
      model: typeof a.model === 'string' ? a.model.trim() : '',
    })
  }
  const wanted = typeof raw?.defaultAgentId === 'string' ? raw.defaultAgentId : SYSTEM_AGENT_ID
  const defaultAgentId = agents.some((a) => a.id === wanted) ? wanted : SYSTEM_AGENT_ID
  return { agents, defaultAgentId }
}

export function loadSettings(): SystemSettings {
  if (settingsCache) return settingsCache
  try {
    const raw = JSON.parse(readFileSync(settingsFile(), 'utf-8')) as Partial<SystemSettings>
    settingsCache = normalize(raw)
  } catch {
    settingsCache = defaultSettings()
  }
  return settingsCache
}

/** Validate + persist new settings; returns the normalized result. */
export function saveSettings(next: SystemSettings): SystemSettings {
  const normalized = normalize(next)
  try {
    writeAtomic(settingsFile(), normalized)
    settingsCache = normalized
  } catch (err) {
    console.error('[c3] failed to persist settings:', err)
  }
  return settingsCache ?? normalized
}

export function getDefaultAgentId(): string {
  return loadSettings().defaultAgentId
}

/** The agent for an id, or the default agent if the id is null/unknown. */
function resolveAgent(agentId: string | null): AgentConfig {
  const settings = loadSettings()
  const byId = agentId ? settings.agents.find((a) => a.id === agentId) : undefined
  return (
    byId ??
    settings.agents.find((a) => a.id === settings.defaultAgentId) ??
    settings.agents.find((a) => a.id === SYSTEM_AGENT_ID) ??
    systemAgent()
  )
}

// ---- Session → agent assignment ----

let stateCache: SessionAgentState | null = null

function loadState(): SessionAgentState {
  if (stateCache) return stateCache
  try {
    const raw = JSON.parse(readFileSync(stateFile(), 'utf-8')) as Partial<SessionAgentState>
    stateCache = {
      version: 1,
      sessionAgents:
        raw.sessionAgents && typeof raw.sessionAgents === 'object' ? raw.sessionAgents : {},
    }
  } catch {
    stateCache = { version: 1, sessionAgents: {} }
  }
  return stateCache
}

function persistState(): void {
  try {
    writeAtomic(stateFile(), loadState())
  } catch (err) {
    console.error('[c3] failed to persist session-agent state:', err)
  }
}

/** The agent id assigned to a session, or null (⇒ use the default agent). */
export function getSessionAgentId(sessionId: string): string | null {
  return loadState().sessionAgents[sessionId] ?? null
}

export function setSessionAgentId(sessionId: string, agentId: string | null): void {
  const state = loadState()
  if (agentId === null || agentId === '') delete state.sessionAgents[sessionId]
  else state.sessionAgents[sessionId] = agentId
  persistState()
}

export function deleteSessionAgentId(sessionId: string): void {
  const state = loadState()
  if (sessionId in state.sessionAgents) {
    delete state.sessionAgents[sessionId]
    persistState()
  }
}

/**
 * Resolve how to launch Claude Code for a session: the agent's Claude config
 * mapped to SDK launch overrides. Empty fields produce no override, so the
 * system agent yields `{}` (SDK defaults apply).
 */
export function resolveSessionLaunch(sessionId: string | null): {
  envOverrides?: Record<string, string>
  model?: string
} {
  const agentId = sessionId ? getSessionAgentId(sessionId) : null
  const agent = resolveAgent(agentId)
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

/** Test-only: drop the in-memory caches so the next call re-reads from disk. */
export function resetSettingsCacheForTests(): void {
  settingsCache = null
  stateCache = null
}
