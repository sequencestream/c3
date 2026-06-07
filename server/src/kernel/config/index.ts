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
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type {
  AgentConfig,
  ClaudeAgentConfig,
  PermissionMode,
  ProjectConfig,
  SkillRepoConfig,
  SkillTrust,
  SkillVendor,
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
  // External skill repos (ADR-0016): fail-SOFT passthrough only — keep the array
  // shape so the console can save/round-trip it, but the deep fail-HARD validation
  // (missing ref, dup id, pinned-without-SHA, devSkill collision) lives in
  // `getSkillRepos()`, not here. Boot must never crash on a misconfigured repo.
  const skillRepos = Array.isArray(raw?.skillRepos)
    ? (raw.skillRepos as SkillRepoConfig[])
    : undefined
  // Per-project configurations passthrough (project-level knobs).
  const projectConfigs = raw?.projectConfigs
  return {
    agents,
    defaultAgentId,
    voiceLang,
    uiLang,
    timezone,
    showToolSessions,
    degradationChain,
    socketAutoResume,
    ...(skillRepos ? { skillRepos } : {}),
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
  if (r.defaultMode !== undefined) seed.defaultMode = r.defaultMode as PermissionMode
  if (r.consensus !== undefined) seed.consensus = r.consensus as ProjectConfig['consensus']
  if (r.devSkill !== undefined) seed.devSkill = r.devSkill as string
  if (r.maxRoundsPerStage !== undefined) seed.maxRoundsPerStage = r.maxRoundsPerStage as number
  if (r.maxSpeechChars !== undefined) seed.maxSpeechChars = r.maxSpeechChars as number
  if (Object.keys(seed).length > 0) legacyProjectSeed = seed
}

/**
 * Normalize a partial or raw ProjectConfig into its canonical shape.
 * Applies the same thresholds as the old global-level operations:
 * - `defaultMode` defaults to `'default'`.
 * - `consensus` is strict opt-in (only explicit `true` is truthy).
 * - `devSkill` is trimmed, slash-normalized, and defaults to `''`.
 * - `maxRoundsPerStage` is floored and clamped to ≥ `MIN_ROUNDS_PER_STAGE`.
 * - `maxSpeechChars` is floored and clamped to ≥ `MIN_SPEECH_CHARS`.
 */
export function normalizeProjectConfig(raw: unknown): ProjectConfig {
  const rec = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const defaultMode: PermissionMode = PERMISSION_MODES.includes(rec.defaultMode as PermissionMode)
    ? (rec.defaultMode as PermissionMode)
    : 'default'
  const consensus = {
    enabled: (rec.consensus as { enabled?: boolean })?.enabled === true,
    majority: (rec.consensus as { majority?: boolean })?.majority === true,
  }
  const devSkill = normalizeDevSkill(rec.devSkill)
  const maxRoundsPerStage = normalizeMaxRoundsPerStage(rec.maxRoundsPerStage)
  const maxSpeechChars = normalizeMaxSpeechChars(rec.maxSpeechChars)
  return { defaultMode, consensus, devSkill, maxRoundsPerStage, maxSpeechChars }
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
 * Save a project's configuration. Returns the normalized result. The config
 * is persisted inside `SystemSettings.projectConfigs` and written atomically.
 */
export function saveProjectConfig(projectPath: string, cfg: ProjectConfig): ProjectConfig {
  const normalized = normalizeProjectConfig(cfg)
  const settings = loadSettings()
  const configs = { ...(settings.projectConfigs ?? {}), [projectPath]: normalized }
  saveSettings({ ...settings, projectConfigs: configs })
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

/** The permission mode new sessions start in for a project (`default` when unconfigured). */
export function getDefaultMode(projectPath: string): PermissionMode {
  return loadProjectConfig(projectPath).defaultMode ?? 'default'
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
 * Post-`session_metadata` projection: the pending intent now lives in the
 * `session_metadata` table as a pending row, NOT in `state.json`. The
 * kernel doesn't import the projection store (kernel ↛ features, ADR-0009),
 * so the lookup is a registered callback (composition root wires it to
 * `getPendingIntent` in `features/sessions/store.ts`). The state.json
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
// (post-ADR-0015 + the `session_metadata` amendment). The kernel doesn't
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

/** A 40-hex git commit SHA — the only `pinCommit` shape a `pinned` repo may carry. */
const SHA40 = /^[0-9a-f]{40}$/i

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

const SKILL_VENDORS: readonly SkillVendor[] = ['claude', 'codex', 'opencode', 'all']
const SKILL_TRUSTS: readonly SkillTrust[] = ['pinned', 'review-on-update', 'unreviewed']

function isSkillVendor(v: unknown): v is SkillVendor {
  return SKILL_VENDORS.includes(v as SkillVendor)
}
function isSkillTrust(v: unknown): v is SkillTrust {
  return SKILL_TRUSTS.includes(v as SkillTrust)
}

/**
 * Validate + normalize the configured external skill repos (ADR-0016), **fail-hard**.
 * Unlike the fail-soft settings `normalize` (which drops bad data so c3 still boots),
 * every violation here **throws** with a precise message, so a misconfiguration is
 * surfaced to the operator instead of silently mounting the wrong skill. Returns the
 * normalized configs (defaults applied — `vendor: 'claude'`, `trust: 'unreviewed'`;
 * `repo`/`ref`/`subpath` resolved from the URL). An absent/empty list is valid → `[]`.
 *
 * Rules: `id` required + globally unique; `repo` required; `ref` required (after
 * URL `/tree/<ref>` backfill — never a silent default-branch fallback); a `pinned`
 * repo requires a 40-hex `pinCommit`; and the `devSkill` trigger (sans leading `/`)
 * must not collide with any repo `id`.
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
    const vendor: SkillVendor = isSkillVendor(r.vendor) ? r.vendor : 'claude'
    const trust: SkillTrust = isSkillTrust(r.trust) ? r.trust : 'unreviewed'
    let pinCommit: string | undefined
    if (trust === 'pinned') {
      const pc = typeof r.pinCommit === 'string' ? r.pinCommit.trim() : ''
      if (!SHA40.test(pc))
        throw new Error(`${where}(${id}) trust='pinned' 须提供 40 位 SHA pinCommit`)
      pinCommit = pc.toLowerCase()
    } else if (typeof r.pinCommit === 'string' && r.pinCommit.trim()) {
      // Carried verbatim for non-pinned (informational); only enforced when pinned.
      pinCommit = r.pinCommit.trim()
    }
    out.push({
      id,
      repo: parsed.repo,
      ref,
      ...(subpath ? { subpath } : {}),
      vendor,
      trust,
      ...(pinCommit ? { pinCommit } : {}),
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
 * The validated external skill repos from the current settings (ADR-0016).
 * Fail-hard — throws on any misconfiguration (see {@link validateSkillRepos}).
 * NOTE: devSkill is now per-project, so the global devSkill collision check is
 * dropped here (it was a one-to-one name-space guard that no longer applies at
 * the global level).
 */
export function getSkillRepos(): SkillRepoConfig[] {
  const s = loadSettings()
  return validateSkillRepos(s.skillRepos)
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

/** Test-only: drop the in-memory caches so the next call re-reads from disk. */
export function resetSettingsCacheForTests(): void {
  settingsCache = null
  stateCache = null
}
