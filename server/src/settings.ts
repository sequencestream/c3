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
import type { AgentConfig, PermissionMode, SystemSettings } from '@ccc/shared/protocol'
import { SYSTEM_AGENT_ID } from '@ccc/shared/protocol'

const PERMISSION_MODES: readonly PermissionMode[] = [
  'default',
  'auto',
  'plan',
  'acceptEdits',
  'bypassPermissions',
]

/** Hard floor for the per-stage discussion round cap; lower values are clamped up. */
export const MIN_ROUNDS_PER_STAGE = 8
/** Fallback per-stage round cap when unset/invalid (kept above the floor for depth). */
export const DEFAULT_ROUNDS_PER_STAGE = 12

/** Hard floor for participant speech character guidance; lower values are clamped up. */
export const MIN_SPEECH_CHARS = 300
/** Default character budget for participant speech when unset/invalid. */
export const DEFAULT_SPEECH_CHARS = 300

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
  const defaultMode: PermissionMode = PERMISSION_MODES.includes(raw?.defaultMode as PermissionMode)
    ? (raw!.defaultMode as PermissionMode)
    : 'default'
  const consensus = { enabled: raw?.consensus?.enabled === true }
  const voiceLang =
    typeof raw?.voiceLang === 'string' && raw.voiceLang.trim() ? raw.voiceLang.trim() : 'zh-CN'
  const showToolSessions = raw?.showToolSessions === true
  const devSkill = normalizeDevSkill(raw?.devSkill)
  const lintFixCommand = normalizeLintFixCommand(raw?.lintFixCommand)
  const maxRoundsPerStage = normalizeMaxRoundsPerStage(raw?.maxRoundsPerStage)
  const maxSpeechChars = normalizeMaxSpeechChars(raw?.maxSpeechChars)
  const degradationChain = normalizeDegradationChain(raw?.degradationChain, agents)
  return {
    agents,
    defaultAgentId,
    defaultMode,
    consensus,
    voiceLang,
    showToolSessions,
    devSkill,
    lintFixCommand,
    maxRoundsPerStage,
    maxSpeechChars,
    degradationChain,
  }
}

/**
 * Force the per-stage round cap into shape: a finite number ≥ {@link MIN_ROUNDS_PER_STAGE}
 * is floored and kept; a positive value below the floor is clamped up to it; anything
 * else (missing, non-finite, ≤ 0) falls back to {@link DEFAULT_ROUNDS_PER_STAGE}.
 */
function normalizeMaxRoundsPerStage(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : NaN
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_ROUNDS_PER_STAGE
  return Math.max(MIN_ROUNDS_PER_STAGE, Math.floor(n))
}

/**
 * Force the participant speech char budget into shape: a finite number ≥
 * {@link MIN_SPEECH_CHARS} is kept; a positive value below the floor is
 * clamped up; anything else (missing, non-finite, ≤ 0) falls back to
 * {@link DEFAULT_SPEECH_CHARS}.
 */
export function normalizeMaxSpeechChars(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : NaN
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_SPEECH_CHARS
  return Math.max(MIN_SPEECH_CHARS, Math.floor(n))
}

/**
 * Normalise the degradation chain: keep only ids that reference an existing
 * agent in `agents`, preserve order, and strip duplicates. If the result is
 * empty (nothing was valid, or the input was absent/empty) return undefined ⇒
 * no degradation (current behaviour, single-agent fallback).
 */
export function normalizeDegradationChain(
  raw: unknown,
  agents: AgentConfig[],
): string[] | undefined {
  const valid = new Set(agents.map((a) => a.id))
  if (!Array.isArray(raw)) return undefined
  const seen = new Set<string>()
  const result: string[] = []
  for (const id of raw) {
    if (typeof id !== 'string' || !id) continue
    if (!valid.has(id)) continue
    if (seen.has(id)) continue
    seen.add(id)
    result.push(id)
  }
  return result.length > 0 ? result : undefined
}

/**
 * Force a development-skill value into shape: trim it, default to empty (no skill
 * prefix at launch), and prepend a missing leading `/` when non-empty.
 */
function normalizeDevSkill(raw: unknown): string {
  const trimmed = typeof raw === 'string' ? raw.trim() : ''
  if (!trimmed) return ''
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`
}

/** The lint-fix command used when none is configured (the common pnpm setup). */
export const DEFAULT_LINT_FIX_COMMAND = 'pnpm lint:fix'

/**
 * Force the automation lint-fix command into shape. UNSET (missing / non-string)
 * ⇒ the {@link DEFAULT_LINT_FIX_COMMAND}; an explicit string is trimmed and kept
 * verbatim — including an explicit empty string, which deliberately means "skip
 * the command stage, go straight to the agent fallback".
 */
function normalizeLintFixCommand(raw: unknown): string {
  if (typeof raw !== 'string') return DEFAULT_LINT_FIX_COMMAND
  return raw.trim()
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

/** The permission mode new sessions start in (`default` when unconfigured). */
export function getDefaultMode(): PermissionMode {
  return loadSettings().defaultMode ?? 'default'
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

/** Whether multi-agent consensus voting is enabled in the system settings. */
export function isConsensusEnabled(): boolean {
  return loadSettings().consensus?.enabled === true
}

/** Whether tool-created sessions should appear in the sidebar session list. */
export function getShowToolSessions(): boolean {
  return loadSettings().showToolSessions === true
}

/** The slash command prefixed to a requirement when launching development; empty ⇒ no prefix. */
export function getDevSkill(): string {
  return normalizeDevSkill(loadSettings().devSkill)
}

/**
 * The automation lint self-heal command-first command (normalized). Defaults to
 * {@link DEFAULT_LINT_FIX_COMMAND} when unset; an explicit empty string skips the
 * command stage (the orchestrator goes straight to the agent fallback).
 */
export function getLintFixCommand(): string {
  return normalizeLintFixCommand(loadSettings().lintFixCommand)
}

/** The per-stage discussion round cap (normalized; always ≥ {@link MIN_ROUNDS_PER_STAGE}). */
export function getMaxRoundsPerStage(): number {
  return normalizeMaxRoundsPerStage(loadSettings().maxRoundsPerStage)
}

/**
 * The discussion participant speech char budget (normalized; always ≥
 * {@link MIN_SPEECH_CHARS}). This is a prompt-level guidance — over-long
 * replies are accepted verbatim.
 */
export function getMaxSpeechChars(): number {
  return normalizeMaxSpeechChars(loadSettings().maxSpeechChars)
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
 * The agents that vote in a consensus round: every configured agent except the
 * one the session itself runs on (`currentAgentId`, already resolved).
 */
export function consensusVoters(currentAgentId: string | null): AgentConfig[] {
  return loadSettings().agents.filter((a) => a.id !== currentAgentId)
}

/** Test-only: drop the in-memory caches so the next call re-reads from disk. */
export function resetSettingsCacheForTests(): void {
  settingsCache = null
  stateCache = null
}
