/**
 * System configuration store + reads (server refactor 3/3, ADR-0009 — sunk from
 * the old root `settings.ts`). Persisted under `~/.c3/`:
 *   1. `settings.json` — the agent registry + which agent is the default.
 *   2. `state.json`    — per-session agent assignment (sessionId → agentId).
 *
 * This module owns the persistence mechanics (atomic write, in-memory caches),
 * the whole-settings `normalize`, and the *config-flavoured* reads (timezone,
 * ui-lang, dev-skill, round/speech caps, consensus/auto-resume switches). The
 * *agent-flavoured* reads (resolve agent / launch overrides / degradation chain)
 * live in `kernel/agent-config`, which imports `loadSettings` from here. The
 * pure agent-shape normalizers it shares with `normalize` come from
 * `agent-config/normalize` (a leaf), so there is no import cycle.
 *
 * Both files are written atomically; on any read/parse error we fall back to a
 * clean default (system agent only) so c3 still boots.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type {
  AgentConfig,
  ClaudeAgentConfig,
  PermissionMode,
  SystemSettings,
  UiLang,
} from '@ccc/shared/protocol'
import {
  defaultSettings,
  normalizeDegradationChain,
  normalizeIcon,
  systemAgent,
} from '../agent-config/normalize.js'
import { parseAgentConfig } from '../agent-config/schema.js'

const PERMISSION_MODES: readonly PermissionMode[] = [
  'default',
  'auto',
  'plan',
  'acceptEdits',
  'bypassPermissions',
]

/** UI display languages. Only `en`/`zh` ship translations today; the rest are
 * reserved for the i18n rollout (fall back to `en` messages until translated). */
const UI_LANGS: readonly UiLang[] = ['en', 'zh', 'ja', 'ko', 'ru']
/** UI language when unset/invalid. Decoupled from {@link voiceLang}. */
export const DEFAULT_UI_LANG: UiLang = 'en'

/**
 * The server's own IANA time zone — the default when `timezone` is unset/invalid.
 * Computed at call time so it tracks the host (and so tests can stub it via the
 * environment). Falls back to `'UTC'` on the (unexpected) chance the runtime
 * can't resolve a zone.
 */
export function getServerTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

/** True when `tz` is an IANA time-zone name the runtime's `Intl` accepts. */
export function isValidTimeZone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || !tz.trim()) return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

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

function writeAtomic(file: string, data: unknown): void {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8')
  renameSync(tmp, file)
}

// ---- Settings (agent registry) ----

let settingsCache: SystemSettings | null = null

/** Trim a claude config sub-object out of a flat-or-nested source record. */
function buildClaudeConfig(src: Record<string, unknown>): ClaudeAgentConfig {
  const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')
  return { baseUrl: str(src.baseUrl), apiKey: str(src.apiKey), model: str(src.model) }
}

/**
 * Shape one persisted agent record into a {@link AgentConfig} *candidate* for
 * the zod schema to validate + route. Handles the back-compat migration: a
 * legacy-flat record (no `vendor`, fields at top level) is a Claude profile by
 * definition, so it is wrapped as `vendor: 'claude'` with its flat
 * `baseUrl`/`apiKey`/`model` folded into `config` and its `name` carried to
 * `displayName`. New-shape records keep their `vendor` and nested `config`.
 * Unknown vendors are passed through verbatim so the schema rejects them (no
 * adapter exists for them yet).
 */
function migrateAgentCandidate(id: string, rec: Record<string, unknown>): unknown {
  const displayName =
    (typeof rec.displayName === 'string' && rec.displayName.trim()) ||
    (typeof rec.name === 'string' && rec.name.trim()) ||
    id
  // Back-compat: missing/true ⇒ enabled; only an explicit false disables.
  const enabled = rec.enabled !== false
  const icon = normalizeIcon(rec.icon)
  // Legacy-flat configs carry no `vendor`; they are Claude profiles by definition.
  const vendor = typeof rec.vendor === 'string' ? rec.vendor : 'claude'
  // New shape nests launch fields under `config`; legacy-flat keeps them flat.
  const configSrc =
    rec.config && typeof rec.config === 'object' ? (rec.config as Record<string, unknown>) : rec
  // Provider-config source (2026-06-06-007). Explicit value wins; otherwise infer
  // for legacy records: the old reserved system singleton, or an all-empty
  // provider triple, means "use system config" — everything else is custom.
  const configMode = inferConfigMode(rec.configMode)
  if (vendor === 'claude') {
    return {
      id,
      vendor,
      configMode,
      displayName,
      enabled,
      icon,
      config: buildClaudeConfig(configSrc),
    }
  }
  // codex/opencode (and any unknown vendor): pass the nested config through for the
  // schema to validate + route by tag; an unknown vendor / bad config ⇒ dropped.
  return { id, vendor, configMode, displayName, enabled, icon, config: configSrc }
}

/**
 * Infer an agent's {@link AgentConfigBase.configMode} (2026-06-06-007). An explicit
 * `'system'`/`'custom'` is kept verbatim; otherwise a legacy record (no `configMode`)
 * **defaults to `'custom'`** so the user's previously-configured agents surface in
 * the UI with their provider fields editable. `'system'` is now purely an explicit
 * per-agent choice in the console, never inferred from legacy data.
 */
function inferConfigMode(raw: unknown): 'system' | 'custom' {
  return raw === 'system' || raw === 'custom' ? raw : 'custom'
}

/**
 * Force the settings into a valid shape: a `system` agent always present (with
 * empty overrides) and `defaultAgentId` pointing at an existing agent.
 */
function normalize(raw: Partial<SystemSettings> | undefined): SystemSettings {
  // Treat persisted agents as untrusted JSON: they may be the new
  // vendor-discriminated shape OR the legacy flat Claude shape (no `vendor`/
  // `config`, fields `name`/`baseUrl`/`apiKey`/`model` at top level).
  const incoming: unknown[] = Array.isArray(raw?.agents) ? (raw.agents as unknown[]) : []
  // 2026-06-06-007: the system agent is no longer a forced, undeletable singleton.
  // Every record is migrated + validated like any other; `configMode: 'system'`
  // is now just a per-agent option. We only guarantee the registry is never empty
  // (synthesize a fallback) and that the default points at a real agent.
  const agents: AgentConfig[] = []
  for (const a of incoming) {
    if (!a || typeof a !== 'object') continue
    const rec = a as Record<string, unknown>
    const id = typeof rec.id === 'string' && rec.id ? rec.id : randomUUID()
    if (agents.some((x) => x.id === id)) continue // de-dupe
    // Migrate legacy → discriminated candidate, then validate + route by `vendor`
    // tag through the zod schema. An unknown vendor or a config that fails its arm
    // ⇒ `null` ⇒ dropped (fail-soft, same policy as a dup id).
    const parsed = parseAgentConfig(migrateAgentCandidate(id, rec))
    if (parsed) agents.push(parsed)
  }
  // Never leave the registry empty (a session must always resolve a launch agent):
  // synthesize the claude+system fallback when nothing valid survived.
  if (agents.length === 0) agents.push(systemAgent())
  // The default must reference an existing agent; otherwise fall back to the first.
  const wanted = typeof raw?.defaultAgentId === 'string' ? raw.defaultAgentId : ''
  const defaultAgentId = agents.some((a) => a.id === wanted) ? wanted : agents[0].id
  const defaultMode: PermissionMode = PERMISSION_MODES.includes(raw?.defaultMode as PermissionMode)
    ? (raw!.defaultMode as PermissionMode)
    : 'default'
  // Both flags are strict opt-ins: only an explicit `true` is truthy; anything
  // missing/invalid normalizes to `false` (back-compat with pre-majority configs).
  const consensus = {
    enabled: raw?.consensus?.enabled === true,
    majority: raw?.consensus?.majority === true,
  }
  const voiceLang =
    typeof raw?.voiceLang === 'string' && raw.voiceLang.trim() ? raw.voiceLang.trim() : 'zh-CN'
  // UI display language: a known code is kept; anything else falls back to `en`.
  // Deliberately independent from `voiceLang`.
  const uiLang = UI_LANGS.includes(raw?.uiLang as UiLang)
    ? (raw!.uiLang as UiLang)
    : DEFAULT_UI_LANG
  // System time zone: a valid IANA name is kept; anything else falls back to the
  // server's own zone (so a fresh install schedules in local time out of the box).
  const timezone = isValidTimeZone(raw?.timezone) ? raw!.timezone! : getServerTimezone()
  const showToolSessions = raw?.showToolSessions === true
  const devSkill = normalizeDevSkill(raw?.devSkill)
  const maxRoundsPerStage = normalizeMaxRoundsPerStage(raw?.maxRoundsPerStage)
  const maxSpeechChars = normalizeMaxSpeechChars(raw?.maxSpeechChars)
  const degradationChain = normalizeDegradationChain(raw?.degradationChain, agents)
  // Socket-disconnect auto-resume: enabled unless explicitly disabled (default true).
  const socketAutoResume = raw?.socketAutoResume !== false
  return {
    agents,
    defaultAgentId,
    defaultMode,
    consensus,
    voiceLang,
    uiLang,
    timezone,
    showToolSessions,
    devSkill,
    maxRoundsPerStage,
    maxSpeechChars,
    degradationChain,
    socketAutoResume,
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
 * Force a development-skill value into shape: trim it, default to empty (no skill
 * prefix at launch), and prepend a missing leading `/` when non-empty.
 */
function normalizeDevSkill(raw: unknown): string {
  const trimmed = typeof raw === 'string' ? raw.trim() : ''
  if (!trimmed) return ''
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`
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

/** The permission mode new sessions start in (`default` when unconfigured). */
export function getDefaultMode(): PermissionMode {
  return loadSettings().defaultMode ?? 'default'
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

/** Whether multi-agent consensus voting is enabled in the system settings. */
export function isConsensusEnabled(): boolean {
  return loadSettings().consensus?.enabled === true
}

/**
 * Whether consensus uses majority rule (vs. unanimous-only). Default false;
 * only an explicit `consensus.majority: true` enables it. Independent of
 * {@link isConsensusEnabled} — meaningful only when consensus is also enabled.
 */
export function isConsensusMajorityEnabled(): boolean {
  return loadSettings().consensus?.majority === true
}

/**
 * Whether socket-disconnect single auto-`resume` is enabled (AS-R18 / AVAIL-7).
 * Default true; only an explicit `socketAutoResume: false` disables it.
 */
export function getSocketAutoResume(): boolean {
  return loadSettings().socketAutoResume !== false
}

/** Whether tool-created sessions should appear in the sidebar session list. */
export function getShowToolSessions(): boolean {
  return loadSettings().showToolSessions === true
}

/** The UI display language (normalized; always a known {@link UiLang}, `en` by default). */
export function getUiLang(): UiLang {
  return loadSettings().uiLang ?? DEFAULT_UI_LANG
}

/**
 * The system IANA time zone schedules are computed in (normalized; a valid zone,
 * defaulting to the server's own zone). Passed to `computeNextRunAt` so cron
 * fields are interpreted in this zone.
 */
export function getTimezone(): string {
  const tz = loadSettings().timezone
  return isValidTimeZone(tz) ? tz : getServerTimezone()
}

/** The slash command prefixed to a requirement when launching development; empty ⇒ no prefix. */
export function getDevSkill(): string {
  return normalizeDevSkill(loadSettings().devSkill)
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

/** Test-only: drop the in-memory caches so the next call re-reads from disk. */
export function resetSettingsCacheForTests(): void {
  settingsCache = null
  stateCache = null
}
