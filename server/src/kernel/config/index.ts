/**
 * System configuration store + reads (server refactor 3/3, ADR-0009 — sunk from
 * the old root `settings.ts`). Persisted under `~/.c3/`:
 *   1. `settings.json` — the agent registry + which agent is the default.
 *   2. `state.json`    — the two-key session→agent binding space (ADR-0015):
 *      a mutable `pendingIntents` map (pending session → desired agent, before a
 *      run binds it) and the `sessionAgents` *facts* (real SDK id → the agent that
 *      actually ran + its **frozen vendor**). c3 never stores any session content;
 *      the vendor is the immutable half of a fact because a session's transcript
 *      lives only in that vendor's native store.
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
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { readJsonFile, withFileLock, writeAtomic } from './store.js'
import type {
  AgentConfig,
  ClaudeAgentConfig,
  CodexPolicy,
  ModeToken,
  ProjectConfig,
  ProjectSandboxConfig,
  SkillRepoConfig,
  SystemSandboxDef,
  SystemSettings,
  UiLang,
  VendorId,
} from '@ccc/shared/protocol'
import { PENDING_SESSION_PREFIX } from '@ccc/shared/protocol'
import {
  defaultSettings,
  normalizeDegradationChain,
  normalizeIcon,
  systemAgent,
} from '../agent-config/normalize.js'
import { parseAgentConfig } from '../agent-config/schema.js'

/**
 * Per-vendor default mode tokens (2026-06-07-017). Each vendor's fallback when
 * its key is absent from the per-project {@link ProjectConfig.defaultMode} map.
 * These MUST match each vendor's `defaultToken` in its {@link VendorModeCatalog}
 * (claude=default, codex=auto, opencode=build).
 */
const DEFAULT_MODE_MAP: Record<VendorId, ModeToken> = {
  claude: 'default',
  codex: 'auto',
  opencode: 'build',
}

/** UI display languages. Only `en`/`zh` ship translations today; the rest are
 * reserved for the i18n rollout (fall back to `en` messages until translated). */
const UI_LANGS: readonly UiLang[] = ['en', 'zh', 'ja', 'ko', 'ru']
/** UI language when unset/invalid. Decoupled from {@link voiceLang}. */
export const DEFAULT_UI_LANG: UiLang = 'en'

/**
 * Human-readable language names per {@link UiLang}, each carrying its native
 * endonym in parentheses (e.g. `Chinese (简体中文)`). Used to instruct agents to
 * reply in the user's chosen display language. The English skeleton of a prompt
 * stays English and out of i18n (see `specs/style/i18n-spec.md`); only this name
 * is interpolated so the agent's *output* follows the setting.
 */
export const UI_LANG_NAMES: Record<UiLang, string> = {
  en: 'English',
  zh: 'Chinese (简体中文)',
  ja: 'Japanese (日本語)',
  ko: 'Korean (한국어)',
  ru: 'Russian (Русский)',
}

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

/** TTL for a `pendingIntent` the janitor reaps — a pending session that never ran
 * for 7 days is presumed abandoned (ADR-0015). */
export const PENDING_INTENT_TTL_MS = 7 * 24 * 60 * 60 * 1000

/**
 * A *fact* in the {@link SessionAgentState.sessionAgents} map: the agent a real
 * session actually ran on plus its **frozen** vendor. The vendor is the immutable
 * invariant (ADR-0015) — a session's transcript lives only in that vendor's
 * native store, so re-binding to a different vendor would read nothing back.
 */
interface SessionAgentFact {
  agentId: string
  /** Frozen at the first bind; same-vendor agent swaps are allowed, cross-vendor isn't. */
  vendor: VendorId
}

/**
 * An *intent* in the {@link SessionAgentState.pendingIntents} map: which agent a
 * still-pending session wants to launch with. Mutable until a run binds it (then
 * it is copied to a fact and dropped); the janitor reaps stale ones by `createdAt`.
 */
interface PendingIntent {
  agentId: string
  /** ms since epoch the intent was first recorded — drives janitor expiry. */
  createdAt: number
}

interface SessionAgentState {
  version: 2
  /** pending id → desired agent (intent). Mutable; never produces an orphan fact. */
  pendingIntents: Record<string, PendingIntent>
  /** real SDK id → the agent that ran + its frozen vendor (fact). A missing entry
   * means "use the default agent". */
  sessionAgents: Record<string, SessionAgentFact>
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

/** Migration cache: legacy global values captured once from an old settings.json,
 * used as seed for projects that have no config yet. Cleared after first use. */
let legacyProjectSeed: Partial<ProjectConfig> | null = null

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
  // ---- Legacy migration (one-shot): capture old global top-level fields ----
  // The 5 workspace-level knobs used to live at the SystemSettings top level.
  // Capture them once for the project-level migration; they no longer survive in
  // the normalized settings object (see `projectConfigs`).
  captureLegacyProjectSeed(raw)
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
  const degradationChain = normalizeDegradationChain(raw?.degradationChain, agents)
  // Socket-disconnect auto-resume: enabled unless explicitly disabled (default true).
  const socketAutoResume = raw?.socketAutoResume !== false
  // Skill repos are no longer written here (deprecated — moved to per-project
  // `ProjectConfig.skillRepos`). The captureLegacyProjectSeed one-shot below handles
  // reading the old global value from disk; the per-project authoritative getter is
  // `getSkillRepos(projectPath)`, which reads from `loadProjectConfig(projectPath)`.
  // Per-project configurations passthrough (project-level knobs).
  const projectConfigs = raw?.projectConfigs
  // System sandbox definitions passthrough. Validated by SandboxRegistry at startup.
  const sandboxes = raw?.sandboxes
  return {
    agents,
    defaultAgentId,
    voiceLang,
    uiLang,
    timezone,
    showToolSessions,
    degradationChain,
    socketAutoResume,
    // skillRepos intentionally omitted — deprecated, migrated to ProjectConfig
    ...(sandboxes !== undefined ? { sandboxes } : {}),
    ...(projectConfigs ? { projectConfigs } : {}),
  }
}

/**
 * Capture legacy top-level global defaults from the raw settings object
 * (one-shot migration). Called from `normalize()` when settings are loaded;
 * the captured values are used by `loadProjectConfig` as seed for a project's
 * first-ever config. After seeding once, `legacyProjectSeed` is cleared and
 * this becomes a no-op.
 */
function captureLegacyProjectSeed(raw: Partial<SystemSettings> | undefined): void {
  if (legacyProjectSeed !== null) return // already captured
  if (!raw) return
  // These fields were removed from SystemSettings but may still exist on disk —
  // access them via the raw record for the one-shot migration.
  const r = raw as unknown as Record<string, unknown>
  const seed: Partial<ProjectConfig> = {}
  if (r.defaultMode !== undefined)
    seed.defaultMode = r.defaultMode as unknown as ProjectConfig['defaultMode']
  if (r.consensus !== undefined) seed.consensus = r.consensus as ProjectConfig['consensus']
  if (r.devSkill !== undefined) seed.devSkill = r.devSkill as string
  if (r.maxRoundsPerStage !== undefined) seed.maxRoundsPerStage = r.maxRoundsPerStage as number
  if (r.maxSpeechChars !== undefined) seed.maxSpeechChars = r.maxSpeechChars as number
  if (r.skillRepos !== undefined) seed.skillRepos = r.skillRepos as SkillRepoConfig[]
  if (Object.keys(seed).length > 0) legacyProjectSeed = seed
}

/**
 * Normalize a partial or raw ProjectConfig into its canonical shape.
 * - `defaultMode` accepts both old (single string) and new (`Record<VendorId, ModeToken>`)
 *   formats — the old format is converted by distributing the value to each vendor
 *   where valid, falling back to that vendor's defaultToken otherwise.
 * - `consensus` is strict opt-in (only explicit `true` is truthy).
 * - `devSkill` is trimmed, slash-normalized, and defaults to `''`.
 * - `maxRoundsPerStage` is floored and clamped to ≥ `MIN_ROUNDS_PER_STAGE`.
 * - `maxSpeechChars` is floored and clamped to ≥ `MIN_SPEECH_CHARS`.
 * - `skillRepos` is a fail-soft passthrough (array shape preserved); the deep
 *   fail-HARD validation lives in `validateSkillRepos()` / `getSkillRepos()`.
 */
export function normalizeProjectConfig(raw: unknown): ProjectConfig {
  const rec = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const defaultMode = normalizeDefaultMode(rec.defaultMode)
  const consensus = {
    enabled: (rec.consensus as { enabled?: boolean })?.enabled === true,
    majority: (rec.consensus as { majority?: boolean })?.majority === true,
  }
  const devSkill = normalizeDevSkill(rec.devSkill)
  const maxRoundsPerStage = normalizeMaxRoundsPerStage(rec.maxRoundsPerStage)
  const maxSpeechChars = normalizeMaxSpeechChars(rec.maxSpeechChars)
  const skillRepos = Array.isArray(rec.skillRepos)
    ? (rec.skillRepos as SkillRepoConfig[])
    : undefined
  const sandbox = normalizeSandboxConfig(rec.sandbox)
  return {
    defaultMode,
    consensus,
    devSkill,
    maxRoundsPerStage,
    maxSpeechChars,
    ...(skillRepos ? { skillRepos } : {}),
    ...(sandbox !== undefined ? { sandbox } : {}),
  }
}

/**
 * Normalize a raw project sandbox config value. Returns `undefined` when the
 * value is absent/null/non-object, preserving the "not configured" signal so
 * the UI knows to hide sandbox options. When present, trims string fields and
 * delegates numeric/boolean passthrough. Absent/empty after trimming ⇒ undefined.
 */
function normalizeSandboxConfig(raw: unknown): ProjectSandboxConfig | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const rec = raw as Record<string, unknown>
  const sb: ProjectSandboxConfig = {}
  if (typeof rec.sandbox === 'string' && rec.sandbox.trim()) sb.sandbox = rec.sandbox.trim()
  if (rec.enabled === true) sb.enabled = true
  if (rec.networkDisabled === true) sb.networkDisabled = true
  if (typeof rec.memoryLimitOverride === 'string' && rec.memoryLimitOverride.trim())
    sb.memoryLimitOverride = rec.memoryLimitOverride.trim()
  if (
    typeof rec.cpuLimitOverride === 'number' &&
    Number.isFinite(rec.cpuLimitOverride) &&
    rec.cpuLimitOverride > 0
  )
    sb.cpuLimitOverride = rec.cpuLimitOverride
  if (typeof rec.imageOverride === 'string' && rec.imageOverride.trim())
    sb.imageOverride = rec.imageOverride.trim()
  if (
    rec.envVarsOverride &&
    typeof rec.envVarsOverride === 'object' &&
    !Array.isArray(rec.envVarsOverride)
  )
    sb.envVarsOverride = rec.envVarsOverride as Record<string, string>
  // Return undefined when nothing meaningful was set (keeps old configs clean).
  if (Object.keys(sb).length === 0) return undefined
  return sb
}

/**
 * Per-vendor default mode normalization (2026-06-07-017).
 * Handles three input forms:
 * 1. A string (pre-017 legacy) — seeded as the value for every vendor whose
 *    catalog accepts it; vendors without this token get their vendor defaultToken.
 * 2. A `Record<VendorId, ModeToken>` (new format) — each vendor key is checked;
 *    missing keys or empty strings fall back to DEFAULT_MODE_MAP[vendor].
 * 3. undefined/null/missing — every vendor gets its DEFAULT_MODE_MAP entry.
 */
function normalizeDefaultMode(raw: unknown): Record<VendorId, ModeToken | CodexPolicy> {
  const VENDORS: VendorId[] = ['claude', 'codex', 'opencode']

  // Legacy: single string value → per-vendor distribution.
  if (typeof raw === 'string' && raw.length > 0) {
    const result: Partial<Record<VendorId, ModeToken | CodexPolicy>> = {}
    for (const v of VENDORS) result[v] = raw as ModeToken
    return result as Record<VendorId, ModeToken | CodexPolicy>
  }

  // New format: Record<VendorId, ModeToken | CodexPolicy>, or missing/undefined.
  const obj = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null
  const result: Partial<Record<VendorId, ModeToken | CodexPolicy>> = {}
  for (const v of VENDORS) {
    const val = obj ? obj[v] : undefined
    if (val && typeof val === 'object' && 'sandboxMode' in (val as Record<string, unknown>)) {
      // Codex dual-policy object (2026-06-08).
      result[v] = val as CodexPolicy
    } else if (typeof val === 'string' && (val as string).length > 0) {
      result[v] = val as ModeToken
    } else {
      result[v] = DEFAULT_MODE_MAP[v]
    }
  }
  return result as Record<VendorId, ModeToken | CodexPolicy>
}

/**
 * Load the project configuration for a workspace. Returns the normalized config;
 * falls back to normalized defaults when the project has no entry yet.
 *
 * **Migration (one-shot, idempotent):** the first time a project has no
 * config entry, this function seeds it from the legacy global defaults captured
 * by `captureLegacyProjectSeed` (from an old `settings.json`). The seed is
 * written back so it persists, and `legacyProjectSeed` is cleared so subsequent
 * reads fall through to defaults or existing configs.
 */
export function loadProjectConfig(projectPath: string): ProjectConfig {
  const settings = loadSettings()
  const existing = settings.projectConfigs?.[projectPath]
  if (existing) return normalizeProjectConfig(existing)

  // Migration window: seed from legacy global values (one-shot).
  const seed = legacyProjectSeed
  if (seed) {
    legacyProjectSeed = null // clear — one shot only
    const merged = normalizeProjectConfig(seed)
    // Persist the seeded config so the next read finds it.
    const configs = { ...(settings.projectConfigs ?? {}), [projectPath]: merged }
    saveSettings({ ...settings, projectConfigs: configs })
    return merged
  }

  // No existing config and no migration seed — return normalized defaults.
  return normalizeProjectConfig(undefined)
}

/**
 * Save a project's configuration. Returns the normalized result. Goes through the
 * single locked write path (2026-06-08-003): hold the cross-process lock, re-read
 * the *disk* (NOT the possibly-stale `settingsCache`), set only this project's key
 * (sibling projects — including ones another c3 instance just added — survive),
 * normalize, atomic-write, refresh the cache. Does NOT call {@link saveSettings}:
 * the directory lock is non-reentrant, so a nested acquire would self-deadlock.
 */
export function saveProjectConfig(projectPath: string, cfg: ProjectConfig): ProjectConfig {
  const normalized = normalizeProjectConfig(cfg)
  withFileLock(settingsFile(), () => {
    const disk = readSettingsFromDisk()
    const configs = { ...(disk?.projectConfigs ?? {}), [projectPath]: normalized }
    const mergedSettings = normalize({ ...(disk ?? {}), projectConfigs: configs })
    try {
      writeAtomic(settingsFile(), mergedSettings)
      settingsCache = mergedSettings
    } catch (err) {
      console.error('[c3] failed to persist project config:', err)
    }
  })
  return normalized
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

/**
 * Read the on-disk settings raw (cache-bypassing). This is the authoritative source
 * inside a write lock — the in-memory {@link settingsCache} may be stale relative to
 * another c3 instance that wrote since this process last loaded.
 */
function readSettingsFromDisk(): Partial<SystemSettings> | undefined {
  return readJsonFile<Partial<SystemSettings>>(settingsFile())
}

/**
 * Merge an incoming settings object over the authoritative disk snapshot, preserving
 * the fields a partial writer (the system-settings panel) does not own/carry — the
 * anti-clobber rule that stops `save_settings` from wiping project config:
 *  - `projectConfigs` — per-project map; `undefined` in `next` ⇒ keep disk wholesale;
 *    present ⇒ shallow-merged per key so another process's newly-added project
 *    survives while `next`'s explicit entries win.
 *  - `degradationChain` / `socketAutoResume` — `undefined` ⇒ keep disk; present ⇒ use `next`.
 */
function mergeSettingsOverDisk(
  disk: Partial<SystemSettings> | undefined,
  next: SystemSettings,
): SystemSettings {
  const d = disk ?? {}
  const projectConfigs =
    next.projectConfigs !== undefined
      ? { ...(d.projectConfigs ?? {}), ...next.projectConfigs }
      : d.projectConfigs
  const degradationChain =
    next.degradationChain !== undefined ? next.degradationChain : d.degradationChain
  const socketAutoResume =
    next.socketAutoResume !== undefined ? next.socketAutoResume : d.socketAutoResume
  return {
    ...next,
    ...(projectConfigs !== undefined ? { projectConfigs } : {}),
    ...(degradationChain !== undefined ? { degradationChain } : {}),
    ...(socketAutoResume !== undefined ? { socketAutoResume } : {}),
  }
}

/**
 * Validate + persist new settings; returns the normalized result. Goes through the
 * single locked write path (2026-06-08-003): hold the cross-process lock, re-read
 * the *disk* (authoritative — not the possibly-stale cache), merge over it preserving
 * uncarried fields (see {@link mergeSettingsOverDisk}), normalize, atomic-write,
 * refresh the cache.
 */
export function saveSettings(next: SystemSettings): SystemSettings {
  return withFileLock(settingsFile(), () => {
    const merged = mergeSettingsOverDisk(readSettingsFromDisk(), next)
    const normalized = normalize(merged)
    try {
      writeAtomic(settingsFile(), normalized)
      settingsCache = normalized
    } catch (err) {
      console.error('[c3] failed to persist settings:', err)
    }
    return settingsCache ?? normalized
  })
}

/**
 * The mode token new sessions start in for a project. When `vendor` is given, returns
 * that vendor's entry from the per-vendor map; when omitted, returns the Claude entry
 * (backward-compat fallback for callers that create sessions before the vendor is known).
 * Falls back to the vendor's `DEFAULT_MODE_MAP` entry on missing/empty values.
 */
/**
 * The mode token new sessions start in for a project. Always returns a string
 * {@link ModeToken} — for codex, this is the legacy token (used as `rt.mode`
 * fallback); callers that need the dual {@link CodexPolicy} should use
 * {@link getCodexDefaultPolicy} separately. Falls back to `DEFAULT_MODE_MAP`.
 */
export function getDefaultMode(projectPath: string, vendor?: VendorId): ModeToken {
  const map = loadProjectConfig(projectPath).defaultMode ?? DEFAULT_MODE_MAP
  const v = vendor ?? 'claude'
  const val = map[v]
  // If the stored value is a CodexPolicy object, extract the legacy token.
  if (val && typeof val === 'object' && 'sandboxMode' in (val as object)) {
    return DEFAULT_MODE_MAP[v]
  }
  return (val as ModeToken) ?? DEFAULT_MODE_MAP[v]
}

/**
 * Get the Codex dual-policy default for a project (2026-06-08).
 * Returns the stored {@link CodexPolicy} when the project config has the
 * new object format; falls back to translating the legacy string token
 * through the catalog + `gateToCodexPolicy` when stored as a string or
 * missing. Returns `undefined` for non-codex vendors.
 */
export function getCodexDefaultPolicy(projectPath: string): CodexPolicy | undefined {
  const map = loadProjectConfig(projectPath).defaultMode
  if (!map) return undefined
  const val = map['codex']
  if (val && typeof val === 'object' && 'sandboxMode' in (val as object)) {
    return val as CodexPolicy
  }
  // Legacy string token — translate via catalog + gateToCodexPolicy.
  // Dynamic import to avoid circular deps with the kernel adapter module.
  const DEFAULT_CODEX_TOKEN: ModeToken = 'auto'
  const token = (val as ModeToken) ?? DEFAULT_CODEX_TOKEN
  // Map: auto → on-sensitive, read-only → read-only, full-access → never
  // This is the static equivalent of tokenToGrid(codexModeCatalog, token) + gateToCodexPolicy
  const policyMap: Record<
    string,
    {
      sandboxMode: 'read-only' | 'workspace-write'
      approvalPolicy: 'never' | 'on-failure' | 'on-request'
    }
  > = {
    'read-only': { sandboxMode: 'read-only', approvalPolicy: 'on-request' },
    auto: { sandboxMode: 'workspace-write', approvalPolicy: 'on-request' },
    'full-access': { sandboxMode: 'workspace-write', approvalPolicy: 'never' },
  }
  return policyMap[token] ?? policyMap['auto']
}

// ---- Session → agent assignment ----

let stateCache: SessionAgentState | null = null

/**
 * Migrate a persisted state blob to the current v2 two-key shape (ADR-0015). The
 * legacy v1 shape was a single `sessionAgents: Record<sessionId, agentId>` that
 * conflated pending intents and real-session facts and carried no vendor. We split
 * it: any `pending:`-prefixed key becomes a {@link PendingIntent} (stamped now);
 * every other key becomes a {@link SessionAgentFact} with `vendor: 'claude'` — the
 * only vendor that existed before multi-vendor, so the freeze is historically
 * correct. A v2 blob is read through unchanged (dropping malformed entries).
 */
function migrateState(raw: unknown, now: number): SessionAgentState {
  const rec = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const pendingIntents: Record<string, PendingIntent> = {}
  const sessionAgents: Record<string, SessionAgentFact> = {}

  // v2 pendingIntents (kept verbatim when well-formed).
  if (rec.pendingIntents && typeof rec.pendingIntents === 'object') {
    for (const [id, v] of Object.entries(rec.pendingIntents as Record<string, unknown>)) {
      if (!v || typeof v !== 'object') continue
      const { agentId, createdAt } = v as Record<string, unknown>
      if (typeof agentId !== 'string' || !agentId) continue
      pendingIntents[id] = {
        agentId,
        createdAt: typeof createdAt === 'number' && Number.isFinite(createdAt) ? createdAt : now,
      }
    }
  }

  if (rec.sessionAgents && typeof rec.sessionAgents === 'object') {
    for (const [id, v] of Object.entries(rec.sessionAgents as Record<string, unknown>)) {
      if (typeof v === 'string') {
        // v1 entry: split by key shape; legacy facts predate multi-vendor ⇒ claude.
        if (!v) continue
        if (id.startsWith(PENDING_SESSION_PREFIX))
          pendingIntents[id] = { agentId: v, createdAt: now }
        else sessionAgents[id] = { agentId: v, vendor: 'claude' }
        continue
      }
      // v2 fact.
      if (!v || typeof v !== 'object') continue
      const { agentId, vendor } = v as Record<string, unknown>
      if (typeof agentId !== 'string' || !agentId) continue
      if (vendor !== 'claude' && vendor !== 'codex' && vendor !== 'opencode') continue
      sessionAgents[id] = { agentId, vendor }
    }
  }

  return { version: 2, pendingIntents, sessionAgents }
}

function loadState(): SessionAgentState {
  if (stateCache) return stateCache
  try {
    const raw = JSON.parse(readFileSync(stateFile(), 'utf-8'))
    stateCache = migrateState(raw, Date.now())
  } catch {
    stateCache = { version: 2, pendingIntents: {}, sessionAgents: {} }
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

/**
 * The agent id bound to a session, or null (⇒ use the default agent). Reads from
 * both key spaces (ADR-0015): a `pending:` id resolves to its intent; a real id
 * resolves to its fact's agent. {@link resolveSessionLaunch} relies on this dual
 * read so a pending session launches with its desired agent before it is bound.
 *
 * Post-`work_session_metadata` projection: the pending intent now lives in the
 * `work_session_metadata` table as a pending row, NOT in `state.json`. The
 * kernel doesn't import the projection store (kernel ↛ features, ADR-0009),
 * so the lookup is a registered callback (composition root wires it to
 * `getPendingIntent` in `features/works/work-session-store.ts`). The state.json
 * map still exists for v2→v3 migration bootstrap.
 */
export function getSessionAgentId(sessionId: string): string | null {
  const state = loadState()
  if (sessionId.startsWith(PENDING_SESSION_PREFIX)) {
    // The kernel no longer owns the pending intent (it lives in the
    // projection). Fall back to a registered lookup so callers still
    // resolve a pending session's desired agent.
    const fromState = state.pendingIntents[sessionId]?.agentId ?? null
    if (fromState) return fromState
    return onPendingIntentLookup?.(sessionId) ?? null
  }
  return state.sessionAgents[sessionId]?.agentId ?? null
}

// ---- Composition-time hook for the projection-backed pending intent ----
//
// `getSessionAgentId` (above) is called by `resolveSessionLaunch` and the
// agent-switcher; it needs to read the pending intent from the projection
// (post-ADR-0015 + the `work_session_metadata` amendment). The kernel doesn't
// import the store directly, so the composition root wires this callback.

let onPendingIntentLookup: ((pendingId: string) => string | null) | null = null

/** Register the pending-intent lookup hook (composition root only). */
export function setOnPendingIntentLookup(cb: ((pendingId: string) => string | null) | null): void {
  onPendingIntentLookup = cb
}

/** The frozen vendor of a real session, or null if it has no fact yet (ADR-0015). */
export function getSessionVendor(realId: string): VendorId | null {
  return loadState().sessionAgents[realId]?.vendor ?? null
}

/**
 * Set (or, with a null/empty agent, clear) a pending session's intent — the
 * mutable half of the binding space. No-op-safe to call repeatedly; the
 * `createdAt` stamp is set on first write and refreshed each time the agent
 * changes (so a freshly-retargeted intent isn't reaped mid-edit).
 */
export function setPendingIntent(pendingId: string, agentId: string | null): void {
  const state = loadState()
  if (agentId === null || agentId === '') {
    if (!(pendingId in state.pendingIntents)) return
    delete state.pendingIntents[pendingId]
  } else {
    state.pendingIntents[pendingId] = { agentId, createdAt: Date.now() }
  }
  persistState()
}

/**
 * First bind (pending → real): copy the intent into a fact and **freeze** its
 * vendor, then drop the intent (ADR-0015). `agentId`/`vendor` are the agent that
 * actually ran (resolved by the caller, default-fallback already applied) — facts
 * record reality, not just explicit intent. Idempotent: a real id that already
 * has a fact keeps it (the vendor is never re-frozen on a retry/re-bind); the
 * intent is still cleared so it can't linger as an orphan.
 */
export function bindSessionAgent(
  pendingId: string,
  realId: string,
  agentId: string,
  vendor: VendorId,
): void {
  const state = loadState()
  let dirty = false
  if (pendingId in state.pendingIntents) {
    delete state.pendingIntents[pendingId]
    dirty = true
  }
  if (!(realId in state.sessionAgents)) {
    state.sessionAgents[realId] = { agentId, vendor }
    dirty = true
  }
  if (dirty) persistState()
}

/**
 * Change the agent of an already-bound real session. The vendor is immutable
 * (ADR-0015): a change to a **different** vendor is rejected (returns false,
 * leaving the fact untouched) because the existing transcript lives in the frozen
 * vendor's store. A same-vendor change succeeds; a session with no fact yet has no
 * vendor to violate, so the fact is created. Returns whether the change was applied.
 */
export function changeSessionAgentFact(realId: string, agentId: string, vendor: VendorId): boolean {
  const state = loadState()
  const existing = state.sessionAgents[realId]
  if (existing && existing.vendor !== vendor) return false
  state.sessionAgents[realId] = { agentId, vendor: existing?.vendor ?? vendor }
  persistState()
  return true
}

/** Drop a session from both key spaces (session deleted). */
export function deleteSessionAgentId(sessionId: string): void {
  const state = loadState()
  let dirty = false
  if (sessionId in state.pendingIntents) {
    delete state.pendingIntents[sessionId]
    dirty = true
  }
  if (sessionId in state.sessionAgents) {
    delete state.sessionAgents[sessionId]
    dirty = true
  }
  if (dirty) persistState()
}

/**
 * Janitor: reap pending intents older than `maxAgeMs` — sessions that were
 * created but never ran (a bound session's intent is already gone). Clearing an
 * intent never touches `sessionAgents`, so this can't orphan a fact. Returns the
 * reaped pending ids (for the startup log / tests).
 */
export function cleanupStalePendingIntents(now: number, maxAgeMs: number): string[] {
  const state = loadState()
  const reaped: string[] = []
  for (const [id, intent] of Object.entries(state.pendingIntents)) {
    if (now - intent.createdAt > maxAgeMs) {
      delete state.pendingIntents[id]
      reaped.push(id)
    }
  }
  if (reaped.length > 0) persistState()
  return reaped
}

/**
 * The session→agent binding counts (ADR-0015): how many real sessions carry a
 * frozen vendor *fact* (`bound`) and how many pending sessions still carry a
 * mutable *intent* (`pending`). Surfaced to the console so it can show that a
 * default-agent change is not retroactive — every bound session keeps its own
 * agent/vendor.
 */
export function getSessionBindingStats(): { bound: number; pending: number } {
  const state = loadState()
  return {
    bound: Object.keys(state.sessionAgents).length,
    pending: Object.keys(state.pendingIntents).length,
  }
}

/** Whether multi-agent consensus voting is enabled for a project. */
export function isConsensusEnabled(projectPath: string): boolean {
  return loadProjectConfig(projectPath).consensus?.enabled === true
}

/**
 * Whether consensus uses majority rule (vs. unanimous-only) for a project. Default false;
 * only an explicit `consensus.majority: true` enables it. Independent of
 * {@link isConsensusEnabled} — meaningful only when consensus is also enabled.
 */
export function isConsensusMajorityEnabled(projectPath: string): boolean {
  return loadProjectConfig(projectPath).consensus?.majority === true
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
 * The human-readable name (with native endonym) of the current UI display
 * language — e.g. `Chinese (简体中文)` when `uiLang` is `zh`. Drives the
 * "reply in this language" instruction appended to agent prompts so their output
 * follows the Display language setting. Falls back to the {@link DEFAULT_UI_LANG}
 * name when unset/invalid (via {@link getUiLang}).
 */
export function getUiLangName(): string {
  return UI_LANG_NAMES[getUiLang()]
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

/** The slash command prefixed to a intent when launching development; empty ⇒ no prefix. */
export function getDevSkill(projectPath: string): string {
  return normalizeDevSkill(loadProjectConfig(projectPath).devSkill)
}

// ---- External skill repos (ADR-0016) ----

/** Web repo URL parsed into a base repo + optional ref/subpath (ADR-0016 §URL 解析). */
export interface ParsedSkillRepoUrl {
  /** Base `https://host/owner/repo`, with any `/tree/…` (or `/-/tree/…`) stripped. */
  repo: string
  /** Ref pulled from a `/tree/<ref>` segment, if present. */
  ref?: string
  /** Subpath pulled from `/tree/<ref>/<subpath>`, if present. */
  subpath?: string
}

// GitHub: https://host/owner/repo[/tree/<ref>[/<subpath>]] — the task's reference
// pattern, wrapped with a base-capture group. `[^/]+` segments pin host/owner/repo.
const GITHUB_URL = /^(https?:\/\/[^/]+\/[^/]+\/[^/]+)(?:\/tree\/([^/]+)(?:\/(.+))?)?$/
// GitLab adapter placeholder: its tree segment is `/-/tree/<ref>[/<subpath>]`. Kept
// as a distinct adapter so other forges (Bitbucket `/src/…`, …) slot in the same way.
const GITLAB_URL = /^(https?:\/\/[^/]+\/.+?)\/-\/tree\/([^/]+)(?:\/(.+))?$/

/**
 * Parse a web repo URL into a base repo + optional ref/subpath. GitHub `/tree/`
 * is fully supported; GitLab `/-/tree/` is a placeholder adapter (matched first,
 * since GitHub's looser pattern would otherwise swallow the `/-/` path). A plain
 * repo URL (no tree segment) returns just `{ repo }`; non-matching input is
 * returned verbatim as `repo` (best-effort — real problems surface at clone time).
 */
export function parseSkillRepoUrl(url: string): ParsedSkillRepoUrl {
  const u = url.trim()
  const gl = GITLAB_URL.exec(u)
  if (gl) {
    const [, repo, ref, subpath] = gl
    return { repo, ref, ...(subpath ? { subpath } : {}) }
  }
  const gh = GITHUB_URL.exec(u)
  if (gh) {
    const [, repo, ref, subpath] = gh
    return { repo, ...(ref ? { ref } : {}), ...(subpath ? { subpath } : {}) }
  }
  return { repo: u }
}

/**
 * Validate + normalize the configured external skill repos (ADR-0016), **fail-hard**.
 * Unlike the fail-soft settings `normalize` (which drops bad data so c3 still boots),
 * every violation here **throws** with a precise message, so a misconfiguration is
 * surfaced to the operator instead of silently mounting the wrong skill. Returns the
 * normalized configs (`repo`/`ref`/`subpath` resolved from the URL). An absent/empty
 * list is valid → `[]`. Skills mount into every build-link-capable vendor at the
 * configured `ref`'s head — there are no vendor/trust/pin knobs to validate.
 *
 * Rules: `id` required + globally unique; `repo` required; `ref` required (after
 * URL `/tree/<ref>` backfill — never a silent default-branch fallback); and the
 * `devSkill` trigger (sans leading `/`) must not collide with any repo `id`.
 */
export function validateSkillRepos(
  raw: SkillRepoConfig[] | undefined,
  devSkill?: string,
): SkillRepoConfig[] {
  if (raw == null) return []
  if (!Array.isArray(raw)) throw new Error('skillRepos 必须是数组')
  const out: SkillRepoConfig[] = []
  const seen = new Set<string>()
  for (let i = 0; i < raw.length; i++) {
    const r = raw[i] as Partial<SkillRepoConfig> | null
    const where = `skillRepos[${i}]`
    if (!r || typeof r !== 'object') throw new Error(`${where} 不是合法对象`)
    const id = typeof r.id === 'string' ? r.id.trim() : ''
    if (!id) throw new Error(`${where}.id 必填`)
    if (seen.has(id)) throw new Error(`skillRepos.id 重复: ${id}`)
    seen.add(id)
    const repoRaw = typeof r.repo === 'string' ? r.repo.trim() : ''
    if (!repoRaw) throw new Error(`${where}(${id}).repo 必填`)
    const parsed = parseSkillRepoUrl(repoRaw)
    // ref required — but a URL-embedded `/tree/<ref>` may supply it. Backfill first,
    // then enforce: c3 never silently falls back to the remote's default branch.
    const ref = (typeof r.ref === 'string' && r.ref.trim()) || parsed.ref || ''
    if (!ref) throw new Error(`${where}(${id}).ref 必填(URL 未含 /tree/<ref> 时须显式提供)`)
    const subpath =
      (typeof r.subpath === 'string' && r.subpath.trim()) || parsed.subpath || undefined
    out.push({
      id,
      repo: parsed.repo,
      ref,
      ...(subpath ? { subpath } : {}),
    })
  }
  // devSkill collision: the legacy dev-skill trigger (sans leading `/`) and a repo
  // id share the same "skill name" space — a clash is ambiguous, so reject it.
  const dev = (devSkill ?? '').trim().replace(/^\/+/, '')
  if (dev && seen.has(dev)) {
    throw new Error(`devSkill '${dev}' 与 skillRepos.id 冲突,请改名其一`)
  }
  return out
}

/**
 * The validated external skill repos for a project (ADR-0016).
 * Reads from the project's {@link ProjectConfig.skillRepos} via
 * {@link loadProjectConfig}. Fail-hard — throws on any misconfiguration
 * (see {@link validateSkillRepos}). The devSkill collision check is performed
 * against the project's own devSkill, since both values now live in the
 * same project-level config.
 */
export function getSkillRepos(projectPath: string): SkillRepoConfig[] {
  const cfg = loadProjectConfig(projectPath)
  return validateSkillRepos(cfg.skillRepos, cfg.devSkill)
}

/** The per-stage discussion round cap (normalized; always ≥ {@link MIN_ROUNDS_PER_STAGE}). */
export function getMaxRoundsPerStage(projectPath: string): number {
  return normalizeMaxRoundsPerStage(loadProjectConfig(projectPath).maxRoundsPerStage)
}

/**
 * The discussion participant speech char budget (normalized; always ≥
 * {@link MIN_SPEECH_CHARS}). This is a prompt-level guidance — over-long
 * replies are accepted verbatim.
 */
export function getMaxSpeechChars(projectPath: string): number {
  return normalizeMaxSpeechChars(loadProjectConfig(projectPath).maxSpeechChars)
}

/**
 * Get the system-level sandbox definitions. Returns the raw array from
 * settings (passthrough — shape is validated by SandboxRegistry at startup).
 * Absent/empty ⇒ no sandbox definitions exist.
 */
export function getSystemSandboxes(): SystemSandboxDef[] {
  return loadSettings().sandboxes ?? []
}

/**
 * Get the project-level sandbox config (normalized). Returns `undefined`
 * when the project has no sandbox config (equivalent to disabled).
 */
export function getProjectSandbox(projectPath: string): ProjectSandboxConfig | undefined {
  return normalizeSandboxConfig(loadProjectConfig(projectPath).sandbox)
}

/** Test-only: drop the in-memory caches so the next call re-reads from disk. */
export function resetSettingsCacheForTests(): void {
  settingsCache = null
  stateCache = null
}
