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
import { z } from 'zod'
import { readJsonFile, withFileLock, writeAtomic } from './store.js'
import {
  c3HomeDir,
  setSettingsPath as setSettingsPathOverride,
  settingsFile,
  stateFile,
} from './paths.js'
import type {
  AgentConfig,
  ClaudeAgentConfig,
  CodexPolicy,
  ConsensusConfig,
  GitBranchMode,
  ModeToken,
  WorkspaceSetting,
  WorkspaceSandboxConfig,
  SessionCleanupConfig,
  SkillRepoConfig,
  StoreScope,
  SystemSettings,
  UiLang,
  VendorId,
} from '@ccc/shared/protocol'
import { PENDING_SESSION_PREFIX, SESSION_KINDS, isVendorId } from '@ccc/shared/protocol'
import { resolveDefaultAgentId } from '@ccc/shared'
import type { SandboxExtraMount, SessionKind } from '@ccc/shared/protocol'
import {
  canonicalizeAgentOrder,
  defaultSettings,
  guardReservedAgentIds,
  normalizeDegradationChain,
  normalizeIcon,
  systemAgent,
} from '../agent-config/normalize.js'
import type { AgentOrderEntry } from '../agent-config/normalize.js'
import { parseAgentConfig } from '../agent-config/schema.js'
import { normalizeAuth, migrateLegacySessionTtl } from './auth-schema.js'
import { DEFAULT_SESSION_RETENTION_DAYS, MIN_SESSION_RETENTION_DAYS } from './session-cleanup.js'
import { encryptAgentApiKeys, decryptAgentApiKeys } from './encryption.js'
import {
  DEFAULT_UI_LANG,
  getAgentLang,
  personalizedFileKeys,
  resetPersonalizedCache,
} from './personalized.js'
import { mcpApiKeyFileKeys, resetMcpApiKeyCache } from './mcp-api-keys.js'

export { c3HomeDir, DEFAULT_UI_LANG, getAgentLang }

/**
 * Per-vendor default mode tokens (2026-06-07-017). Each vendor's fallback when
 * its key is absent from the per-project {@link WorkspaceSetting.defaultMode} map.
 * These MUST match each vendor's `defaultToken` in its {@link VendorModeCatalog}
 * (claude=default, codex=auto, cursor=agent).
 */
const DEFAULT_MODE_MAP: Record<VendorId, ModeToken> = {
  claude: 'default',
  codex: 'auto',
  cursor: 'agent',
}

/**
 * Human-readable language names per {@link UiLang}, each carrying its native
 * endonym in parentheses (e.g. `Chinese (简体中文)`). Used to instruct agents to
 * reply in the language the console is being used in. The English skeleton of a
 * prompt stays English and out of i18n (see `specs/style/i18n-spec.md`); only this
 * name is interpolated so the agent's *output* follows the setting.
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

/** Allowed proxy URL schemes. Only these are permitted by `sanitizeProxyUrl`. */
const ALLOWED_PROXY_PROTOCOLS: readonly string[] = ['http:', 'https:', 'socks5:']

/**
 * Validate and sanitize a raw proxy URL string.
 * - Trims whitespace; empty ⇒ `''`.
 * - Parses via `new URL()`; unparseable ⇒ `''`.
 * - Protocol must be in {@link ALLOWED_PROXY_PROTOCOLS}; otherwise ⇒ `''`.
 */
function sanitizeProxyUrl(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  const trimmed = raw.trim()
  if (!trimmed) return ''
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return ''
  }
  if (!ALLOWED_PROXY_PROTOCOLS.includes(url.protocol)) return ''
  return trimmed
}

/**
 * Normalize a raw proxy config block into its canonical shape.
 * - `enabled` defaults to `false` (strict bool: only `=== true` is on).
 * - `httpProxy`/`httpsProxy` are trimmed and validated (URL parse + protocol
 *   whitelist); invalid values fall back to `''` (fail-soft).
 * - An absent block (undefined) yields the same defaults as a present empty block.
 */
function normalizeProxyConfig(raw: unknown): {
  enabled: boolean
  httpProxy: string
  httpsProxy: string
} {
  const obj = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const enabled = obj.enabled === true
  const httpProxy = sanitizeProxyUrl(obj.httpProxy)
  const httpsProxy = sanitizeProxyUrl(obj.httpsProxy)
  return { enabled, httpProxy, httpsProxy }
}

/**
 * Normalize the system-wide session-cleanup config.
 *
 * - `enabled` is opt-in: only an explicit `true` persists, so an installation
 *   that never asked for cleanup keeps every session transcript.
 * - `retentionDays` accepts a finite positive number, floored to a whole day and
 *   clamped up to {@link MIN_SESSION_RETENTION_DAYS}; anything else (absent,
 *   non-finite, ≤ 0) is left unset so the default applies at read time. Only an
 *   explicit non-default value is persisted, keeping configs clean. The window
 *   can be saved while cleanup is off — it simply does not run.
 *
 * Returns `undefined` when neither field is meaningful, so the whole block is
 * omitted. A legacy per-workspace `sandbox.sessionRetentionDays` lives under a
 * different object entirely: it is unknown to both normalizers and dropped, and
 * it never back-fills this block (no implicit opt-in on upgrade).
 */
function normalizeSessionCleanupConfig(raw: unknown): SessionCleanupConfig | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const rec = raw as Record<string, unknown>
  const out: { enabled?: boolean; retentionDays?: number } = {}
  if (rec.enabled === true) out.enabled = true
  const rawDays = typeof rec.retentionDays === 'number' ? rec.retentionDays : NaN
  if (Number.isFinite(rawDays) && rawDays > 0) {
    const days = Math.max(MIN_SESSION_RETENTION_DAYS, Math.floor(rawDays))
    if (days !== DEFAULT_SESSION_RETENTION_DAYS) out.retentionDays = days
  }
  if (Object.keys(out).length === 0) return undefined
  return out
}

/**
 * The session-cleanup decision: whether cleanup runs at all, and the effective
 * retention window in days. Cleanup is opt-in — an unconfigured installation
 * reports `enabled: false` and nothing is ever pruned. The window falls back to
 * {@link DEFAULT_SESSION_RETENTION_DAYS} when unset (normalize only persists a
 * non-default value).
 */
export function getSessionCleanup(): { enabled: boolean; retentionDays: number } {
  const cfg = loadSettings().sessionCleanup
  return {
    enabled: cfg?.enabled === true,
    retentionDays: cfg?.retentionDays ?? DEFAULT_SESSION_RETENTION_DAYS,
  }
}

/**
 * The session subprocess proxy configuration — the single source of truth for
 * proxy env‑var injection. Callers (e.g. `launchForAgent`) must read from here
 * rather than parsing settings directly.
 */
export function getProxyConfig(): { enabled: boolean; httpProxy: string; httpsProxy: string } {
  return normalizeProxyConfig(loadSettings().proxy)
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
  /**
   * Which native store holds this session's transcript — frozen at first bind
   * from whether the run was sandboxed (ADR-0015). Lets the read/resume path
   * locate the vendor data root even after the workspace sandbox toggle changes.
   * Absent on legacy facts ⇒ treated as `'host'` (every pre-sandbox session).
   */
  storeScope?: StoreScope
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

/**
 * Point every subsequent load/save at another settings.json (CLI `--settings
 * <path>`; the cli's `start` action calls this). Every cache keyed to the old path
 * is dropped, so a relocation mid-process cannot serve stale values.
 */
export function setSettingsPath(path: string): void {
  setSettingsPathOverride(path)
  settingsCache = null
  resetPersonalizedCache()
  resetMcpApiKeyCache()
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
  // Group membership (ADR-0029): a shared shell field carried through verbatim so it
  // survives the load/save normalize round-trip (this migrate whitelists fields, so
  // an omitted `group` would be silently dropped on every save).
  const group = typeof rec.group === 'string' ? { group: rec.group } : {}
  if (vendor === 'claude') {
    return {
      id,
      vendor,
      configMode,
      displayName,
      enabled,
      icon,
      ...group,
      config: buildClaudeConfig(configSrc),
    }
  }
  // codex (and any unknown vendor): pass the nested config through for the
  // schema to validate + route by tag; an unknown vendor / bad config ⇒ dropped.
  return { id, vendor, configMode, displayName, enabled, icon, ...group, config: configSrc }
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
let legacyProjectSeed: Partial<WorkspaceSetting> | null = null

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
  // Collect parsed agents alongside the raw `order_seq` each carried on disk, so
  // the order regularization can tell an explicit position from a missing one
  // (the zod default would otherwise erase that distinction).
  const entries: AgentOrderEntry[] = []
  const seenIds = new Set<string>()
  for (const a of incoming) {
    if (!a || typeof a !== 'object') continue
    const rec = a as Record<string, unknown>
    const id = typeof rec.id === 'string' && rec.id ? rec.id : randomUUID()
    if (seenIds.has(id)) continue // de-dupe
    // Migrate legacy → discriminated candidate, then validate + route by `vendor`
    // tag through the zod schema. An unknown vendor or a config that fails its arm
    // ⇒ `null` ⇒ dropped (fail-soft, same policy as a dup id).
    const parsed = parseAgentConfig(migrateAgentCandidate(id, rec))
    if (!parsed) continue
    seenIds.add(id)
    const rawOrder =
      typeof rec.order_seq === 'number' && Number.isFinite(rec.order_seq)
        ? rec.order_seq
        : undefined
    entries.push({ agent: parsed, rawOrder })
  }
  // Never leave the registry empty (a session must always resolve a launch agent):
  // synthesize the claude+system fallback when nothing valid survived.
  if (entries.length === 0) entries.push({ agent: systemAgent(), rawOrder: 0 })
  // Regularize the user-controlled order: pin the system agent, sort by explicit
  // `order_seq`, append missing ones by array order, stamp a dense 0..n sequence.
  const agents: AgentConfig[] = guardReservedAgentIds(canonicalizeAgentOrder(entries))
  // The default must reference an existing *enabled* agent; an unknown, removed,
  // or now-disabled default falls through to the next enabled agent in order_seq
  // (rewrite-on-store, AC-R2/AC-R10) — `resolveDefaultAgentId` returns SYSTEM_AGENT_ID
  // only when every agent is disabled.
  const wanted = typeof raw?.defaultAgentId === 'string' ? raw.defaultAgentId : ''
  const defaultAgentId = resolveDefaultAgentId(agents, wanted)
  // toolAgentId: background tool sessions' executor. Empty string ⇒ "follow the
  // default agent" — kept empty (NOT auto-filled to the first enabled agent, unlike
  // the default), so the runtime falls back through `resolveAgent` to defaultAgentId.
  // A *set* toolAgentId that's now removed/disabled is rewritten by the same
  // order_seq fall-through the default uses (rewrite-on-store, AC-R2/AC-R10).
  const wantedTool = typeof raw?.toolAgentId === 'string' ? raw.toolAgentId : ''
  const toolAgentId = wantedTool === '' ? '' : resolveDefaultAgentId(agents, wantedTool)
  // intentAgentId: intent-communication sessions' executor. Identical semantics to
  // toolAgentId — empty string ⇒ "follow the default agent" (kept empty, never
  // auto-filled), and a *set* value pointing at a removed/disabled agent is rewritten
  // by the same order_seq fall-through (rewrite-on-store, AC-R2/AC-R10/AC-R23).
  const wantedIntent = typeof raw?.intentAgentId === 'string' ? raw.intentAgentId : ''
  const intentAgentId = wantedIntent === '' ? '' : resolveDefaultAgentId(agents, wantedIntent)
  // specAgentId: spec-authoring sessions' executor. Identical semantics to
  // intentAgentId — empty string ⇒ "follow the default agent" (kept empty, never
  // auto-filled), and a *set* value pointing at a removed/disabled agent is rewritten
  // by the same order_seq fall-through (rewrite-on-store, AC-R2/AC-R10/AC-R24).
  const wantedSpec = typeof raw?.specAgentId === 'string' ? raw.specAgentId : ''
  const specAgentId = wantedSpec === '' ? '' : resolveDefaultAgentId(agents, wantedSpec)
  // specReviewAgentId: spec-REVIEW sessions' executor. Identical semantics to
  // specAgentId, and deliberately a single slot: there is no sandbox-specific
  // reviewer, because whether a review runs in the sandbox is decided by
  // `sandboxSessionKinds` containing 'spec_review', not by picking another agent.
  const wantedSpecReview = typeof raw?.specReviewAgentId === 'string' ? raw.specReviewAgentId : ''
  const specReviewAgentId =
    wantedSpecReview === '' ? '' : resolveDefaultAgentId(agents, wantedSpecReview)
  // automationAgentId: default vendor+agent pre-filled into the "new automation" form.
  // Storage-normalization is identical to specAgentId — empty string ⇒ "follow the
  // default agent" (kept empty, never auto-filled), and a *set* value pointing at a
  // removed/disabled agent is rewritten by the same order_seq fall-through
  // (rewrite-on-store, AC-R2/AC-R10/AC-R25). Unlike the three above it is NOT consumed
  // by the runtime resolveAgent router — it only seeds the create form's default.
  const wantedAutomation = typeof raw?.automationAgentId === 'string' ? raw.automationAgentId : ''
  const automationAgentId =
    wantedAutomation === '' ? '' : resolveDefaultAgentId(agents, wantedAutomation)
  // Legacy `sandbox*AgentId` keys (the removed sandbox-only role profile) are read
  // as unknown fields: ignored here and absent from the returned object, so they
  // disappear from disk on the next save. A sandbox run reuses the agent this same
  // chain resolved for it — there is no sandbox-specific selection any more.
  // ---- Legacy migration (one-shot): capture old global top-level fields ----
  // The 5 workspace-level knobs used to live at the SystemSettings top level.
  // Capture them once for the project-level migration; they no longer survive in
  // the normalized settings object (see `projectConfigs`).
  captureLegacyProjectSeed(raw)
  const voiceLang =
    typeof raw?.voiceLang === 'string' && raw.voiceLang.trim() ? raw.voiceLang.trim() : 'zh-CN'
  // A legacy top-level `uiLang` on disk is read as an unknown field: the display
  // language is a personalized preference (see config/personalized.ts), so it is
  // absent from the returned object and disappears from disk on the next save. It is
  // deliberately NOT carried into any account record — that would keep propagating
  // one person's choice to everyone.
  // System time zone: a valid IANA name is kept; anything else falls back to the
  // server's own zone (so a fresh install automations in local time out of the box).
  const timezone = isValidTimeZone(raw?.timezone) ? raw!.timezone! : getServerTimezone()
  // Public-facing base URL: trim + strip trailing slashes. Empty/absent/non-string
  // ⇒ omitted (optional semantics — "not configured" ≡ no value).
  const baseUrlRaw = typeof raw?.baseUrl === 'string' ? raw.baseUrl.trim().replace(/\/+$/, '') : ''
  const showToolSessions = raw?.showToolSessions === true
  const showSessionsPage = raw?.showSessionsPage === true
  const degradationChain = normalizeDegradationChain(raw?.degradationChain, agents)
  const vendorCliVersions = normalizeVendorCliVersions(raw?.vendorCliVersions)
  // Socket-disconnect auto-resume: enabled unless explicitly disabled (default true).
  const socketAutoResume = raw?.socketAutoResume !== false
  // Skill repos are no longer written here (deprecated — moved to per-project
  // `WorkspaceSetting.skillRepos`). The captureLegacyProjectSeed one-shot below handles
  // reading the old global value from disk; the per-project authoritative getter is
  // `getSkillRepos(workspacePath)`, which reads from `loadWorkspaceSetting(workspacePath)`.
  // Per-project configurations passthrough (project-level knobs).
  const projectConfigs = raw?.projectConfigs
  // Auth config (ADR-0023): validate via the zod schema; a malformed or absent
  // block normalizes to undefined ⇒ "no auth" (the C-SEC-5 localhost-only
  // default). Contract-only — no runtime enforcement exists yet.
  // One-shot migration (2026-06-13): bump the legacy 1h session TTL up to the
  // 30-day default so existing installs stop re-prompting hourly.
  const parsedAuth = normalizeAuth(raw?.auth)
  const auth = parsedAuth ? migrateLegacySessionTtl(parsedAuth) : undefined
  // Session-store cleanup: system-wide and opt-in (see normalizeSessionCleanupConfig).
  const sessionCleanup = normalizeSessionCleanupConfig(raw?.sessionCleanup)
  return {
    agents,
    defaultAgentId,
    toolAgentId,
    intentAgentId,
    specAgentId,
    specReviewAgentId,
    automationAgentId,
    voiceLang,
    timezone,
    ...(baseUrlRaw ? { baseUrl: baseUrlRaw } : {}),
    showToolSessions,
    showSessionsPage,
    degradationChain,
    socketAutoResume,
    proxy: normalizeProxyConfig(raw?.proxy),
    ...(sessionCleanup !== undefined ? { sessionCleanup } : {}),
    // skillRepos intentionally omitted — deprecated, migrated to WorkspaceSetting
    ...(auth !== undefined ? { auth } : {}),
    ...(projectConfigs ? { projectConfigs } : {}),
    ...(vendorCliVersions ? { vendorCliVersions } : {}),
  }
}

function normalizeVendorCliVersions(raw: unknown): Partial<Record<VendorId, string>> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const rec = raw as Record<string, unknown>
  const out: Partial<Record<VendorId, string>> = {}
  for (const vendor of ['claude', 'codex'] as const) {
    const value = rec[vendor]
    if (typeof value !== 'string') continue
    const trimmed = value.trim()
    if (trimmed) out[vendor] = trimmed
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/**
 * Capture legacy top-level global defaults from the raw settings object
 * (one-shot migration). Called from `normalize()` when settings are loaded;
 * the captured values are used by `loadWorkspaceSetting` as seed for a project's
 * first-ever config. After seeding once, `legacyProjectSeed` is cleared and
 * this becomes a no-op.
 */
function captureLegacyProjectSeed(raw: Partial<SystemSettings> | undefined): void {
  if (legacyProjectSeed !== null) return // already captured
  if (!raw) return
  // These fields were removed from SystemSettings but may still exist on disk —
  // access them via the raw record for the one-shot migration.
  const r = raw as unknown as Record<string, unknown>
  const seed: Partial<WorkspaceSetting> = {}
  if (r.defaultMode !== undefined)
    seed.defaultMode = r.defaultMode as unknown as WorkspaceSetting['defaultMode']
  if (r.consensus !== undefined) seed.consensus = r.consensus as WorkspaceSetting['consensus']
  if (r.devSkill !== undefined) seed.devSkill = r.devSkill as string
  if (r.maxRoundsPerStage !== undefined) seed.maxRoundsPerStage = r.maxRoundsPerStage as number
  if (r.maxSpeechChars !== undefined) seed.maxSpeechChars = r.maxSpeechChars as number
  if (r.skillRepos !== undefined) seed.skillRepos = r.skillRepos as SkillRepoConfig[]
  if (Object.keys(seed).length > 0) legacyProjectSeed = seed
}

/**
 * Normalize the consensus config. `enabled`/`majority` are strict opt-in (only an
 * explicit `true` is truthy). `mode` defaults to `'all'` (back-compat: existing
 * configs without the field keep the full same-vendor voter set). For `'custom'`
 * mode the `agentIds` allowlist is cleaned against the current agent table —
 * deduped and stripped of ids that no longer exist or are disabled (`enabled !==
 * false`, matching `enabledAgents()`), so a stale id can never resurrect a voter.
 * `'all'` mode never carries `agentIds` (it is ignored there).
 */
function normalizeConsensusConfig(raw: unknown, agents: readonly AgentConfig[]): ConsensusConfig {
  const rec = raw as Partial<ConsensusConfig> | undefined
  const mode: 'all' | 'custom' = rec?.mode === 'custom' ? 'custom' : 'all'
  const base: ConsensusConfig = {
    enabled: rec?.enabled === true,
    majority: rec?.majority === true,
    mode,
  }
  if (mode !== 'custom') return base
  const enabledIds = new Set(agents.filter((a) => a.enabled !== false).map((a) => a.id))
  const rawIds = Array.isArray(rec?.agentIds) ? rec.agentIds : []
  const agentIds = [...new Set(rawIds.filter((id) => typeof id === 'string' && enabledIds.has(id)))]
  return { ...base, agentIds }
}

/**
 * Normalize a partial or raw WorkspaceSetting into its canonical shape.
 * - `defaultMode` accepts both old (single string) and new (`Record<VendorId, ModeToken>`)
 *   formats — the old format is converted by distributing the value to each vendor
 *   where valid, falling back to that vendor's defaultToken otherwise.
 * - `consensus` is strict opt-in (only explicit `true` is truthy); `mode` defaults
 *   to `'all'` and `custom`-mode `agentIds` are cleaned (see {@link normalizeConsensusConfig}).
 * - `devSkill` is trimmed, slash-normalized, and defaults to `''`.
 * - `maxRoundsPerStage` is floored and clamped to ≥ `MIN_ROUNDS_PER_STAGE`.
 * - `maxSpeechChars` is floored and clamped to ≥ `MIN_SPEECH_CHARS`.
 * - `skillRepos` is a fail-soft passthrough (array shape preserved); the deep
 *   fail-HARD validation lives in `validateSkillRepos()` / `getSkillRepos()`.
 * - `gitBranchMode` falls back to `worktree` for any absent/unknown value;
 *   the legacy on-disk key `gitCommitMode` is read as a fallback when absent.
 * - `defaultMainBranch` is trimmed; empty ⇒ omitted.
 * - `sddEnabled` defaults to `true` (only an explicit boolean `false` disables SDD).
 *   The SDD spec root is a FIXED, centralized, non-configurable location
 *   (`~/.c3/specs/<project-path-segment>`, see `features/intents/specs-root.ts`),
 *   so there is no `specPath` config field — any such input is ignored here.
 * - `specMachineApprovalEnabled` is a strict opt-in (only an explicit boolean `true`
 *   opens machine spec approval); it is persisted only when `true` and read as
 *   `false` when absent, so saving other fields never drops an enabled flag and a
 *   migrated workspace never gains automatic approval silently.
 * - `automationEnabled` defaults to `true` (only an explicit boolean `false`
 *   closes the workspace automation gate); the normalized boolean is always
 *   present so saving other fields never drops the gate.
 */
export function normalizeWorkspaceSetting(
  raw: unknown,
  agents: readonly AgentConfig[] = [],
): WorkspaceSetting {
  const rec = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const defaultMode = normalizeDefaultMode(rec.defaultMode)
  const consensus = normalizeConsensusConfig(rec.consensus, agents)
  const devSkill = normalizeDevSkill(rec.devSkill)
  const maxRoundsPerStage = normalizeMaxRoundsPerStage(rec.maxRoundsPerStage)
  const maxSpeechChars = normalizeMaxSpeechChars(rec.maxSpeechChars)
  const skillRepos = Array.isArray(rec.skillRepos)
    ? (rec.skillRepos as SkillRepoConfig[])
    : undefined
  // Backward compat: new key `gitBranchMode` takes precedence; fall back to the
  // legacy on-disk key `gitCommitMode` so pre-rename saved configs aren't lost.
  const gitBranchMode = normalizeGitBranchMode(rec.gitBranchMode ?? rec.gitCommitMode)
  // Sandbox config is independent of the branch mode — switching modes must not
  // silently drop a saved sandbox config.
  const sandbox = normalizeSandboxConfig(rec.sandbox)
  const defaultMainBranch = normalizeDefaultMainBranch(rec.defaultMainBranch)
  const sddEnabled = normalizeSddEnabled(rec.sddEnabled)
  const automationEnabled = normalizeAutomationEnabled(rec.automationEnabled)
  const specMachineApprovalEnabled = normalizeSpecMachineApprovalEnabled(
    rec.specMachineApprovalEnabled,
  )
  const forge = normalizeWorkspaceForge(rec.forge)
  return {
    forge,
    defaultMode,
    consensus,
    devSkill,
    maxRoundsPerStage,
    maxSpeechChars,
    gitBranchMode,
    sddEnabled,
    automationEnabled,
    ...(defaultMainBranch ? { defaultMainBranch } : {}),
    ...(skillRepos ? { skillRepos } : {}),
    ...(sandbox !== undefined ? { sandbox } : {}),
    ...(specMachineApprovalEnabled ? { specMachineApprovalEnabled } : {}),
  }
}

/** Runtime contract for the workspace forge selector. */
const workspaceForgeSchema = z.enum(['auto', 'github', 'gitlab'])

/** Normalize the workspace forge selector; absent or unknown values detect from origin. */
function normalizeWorkspaceForge(raw: unknown): 'auto' | 'github' | 'gitlab' {
  return workspaceForgeSchema.safeParse(raw).data ?? 'auto'
}

/**
 * Normalize the SDD master switch — only an explicit boolean `false` disables it;
 * any other value (absent or non-boolean) falls back to `true`.
 */
function normalizeSddEnabled(raw: unknown): boolean {
  return raw !== false
}

/**
 * Normalize the machine spec-approval opt-in — only an explicit boolean `true`
 * opens it; any other value (absent, `false`, non-boolean) reads as `false`. This
 * keeps the feature a deliberate per-workspace opt-in so a migrated workspace
 * never silently gains automatic approval.
 */
function normalizeSpecMachineApprovalEnabled(raw: unknown): boolean {
  return raw === true
}

/**
 * Normalize the workspace automation gate — enabled by default. Only an explicit
 * boolean `false` closes the gate; any other value (absent, non-boolean, a legacy
 * persisted string) normalizes to `true`. This keeps existing workspaces
 * auto-dispatching after upgrade and treats a corrupted value as "keep running"
 * rather than silently muting automations.
 */
function normalizeAutomationEnabled(raw: unknown): boolean {
  return raw !== false
}

/**
 * Normalize the git branch mode — preserve both explicit modes and fall back to
 * `worktree` for absent or unknown values.
 */
function normalizeGitBranchMode(raw: unknown): GitBranchMode {
  return raw === 'current-branch' ? 'current-branch' : 'worktree'
}

/** Normalize the default main branch — trims; absent / blank ⇒ `undefined`. */
function normalizeDefaultMainBranch(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const trimmed = raw.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

/**
 * Normalize a raw workspace sandbox config value (arapuca process-level
 * isolation). Returns `undefined` when the value is absent/null/non-object or
 * nothing meaningful survives, preserving the "not configured" signal so the UI
 * knows to hide sandbox options.
 *
 * The config is independent of `gitBranchMode`: it validates the sandbox content
 * only, so switching branch mode never drops a saved `enabled` / `extraMounts` /
 * `sandboxSessionKinds`. Whether a given run enters the sandbox (and which dirs
 * are read-write) is decided at run time from the run's execution root, not here.
 *
 * Legacy on-disk container keys (`sandbox` name ref, `allowExternalNetwork`,
 * `readonlyRootfs`, image/resource/env overrides, `agentIds`, `networkDisabled`)
 * are read and DROPPED — there is no semantic carry-over under arapuca.
 */
function normalizeSandboxConfig(raw: unknown): WorkspaceSandboxConfig | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const rec = raw as Record<string, unknown>
  const sb: WorkspaceSandboxConfig = {}
  if (rec.enabled === true) sb.enabled = true
  // Supplementary allowed dirs: same-path passthrough, read-only by default.
  // Drop entries without an absolute-path string; trim the path.
  if (Array.isArray(rec.extraMounts)) {
    const seen = new Set<string>()
    const extraMounts: SandboxExtraMount[] = []
    for (const item of rec.extraMounts) {
      if (!item || typeof item !== 'object') continue
      const m = item as Record<string, unknown>
      const path = typeof m.path === 'string' ? m.path.trim() : ''
      if (!path || !path.startsWith('/') || seen.has(path)) continue
      seen.add(path)
      extraMounts.push(m.readonly === false ? { path, readonly: false } : { path })
    }
    if (extraMounts.length > 0) sb.extraMounts = extraMounts
  }
  // Session kinds that enter the sandbox: dedupe, drop values outside
  // SESSION_KINDS; an empty set after normalize falls back to ['work'].
  if (Array.isArray(rec.sandboxSessionKinds)) {
    const valid = new Set<string>(SESSION_KINDS)
    const seen = new Set<string>()
    const kinds: SessionKind[] = []
    for (const k of rec.sandboxSessionKinds) {
      if (typeof k !== 'string' || !valid.has(k) || seen.has(k)) continue
      seen.add(k)
      kinds.push(k as SessionKind)
    }
    sb.sandboxSessionKinds = kinds.length > 0 ? kinds : ['work']
  }
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
  const VENDORS: VendorId[] = ['claude', 'codex']

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
export function loadWorkspaceSetting(workspacePath: string): WorkspaceSetting {
  const settings = loadSettings()
  const existing = settings.projectConfigs?.[workspacePath]
  if (existing) return normalizeWorkspaceSetting(existing, settings.agents)

  // Migration window: seed from legacy global values (one-shot).
  const seed = legacyProjectSeed
  if (seed) {
    legacyProjectSeed = null // clear — one shot only
    const merged = normalizeWorkspaceSetting(seed, settings.agents)
    // Persist the seeded config so the next read finds it.
    const configs = { ...(settings.projectConfigs ?? {}), [workspacePath]: merged }
    saveSettings({ ...settings, projectConfigs: configs })
    return merged
  }

  // No existing config and no migration seed — return normalized defaults.
  return normalizeWorkspaceSetting(undefined, settings.agents)
}

/**
 * Save a project's configuration. Returns the normalized result. Goes through the
 * single locked write path (2026-06-08-003): hold the cross-process lock, re-read
 * the *disk* (NOT the possibly-stale `settingsCache`), set only this project's key
 * (sibling projects — including ones another c3 instance just added — survive),
 * normalize, atomic-write, refresh the cache. Does NOT call {@link saveSettings}:
 * the directory lock is non-reentrant, so a nested acquire would self-deadlock.
 */
export function saveWorkspaceSetting(
  workspacePath: string,
  cfg: WorkspaceSetting,
): WorkspaceSetting {
  const normalized = normalizeWorkspaceSetting(cfg, loadSettings().agents)
  withFileLock(settingsFile(), () => {
    const disk = readSettingsFromDisk()
    const configs = { ...(disk?.projectConfigs ?? {}), [workspacePath]: normalized }
    const mergedSettings = normalize({ ...(disk ?? {}), projectConfigs: configs })
    try {
      // Encrypt apiKeys for disk only; the cache keeps the plaintext `mergedSettings`.
      writeAtomic(settingsFile(), encryptAgentApiKeys(mergedSettings))
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
    // Decrypt at-rest agent apiKeys back to plaintext before normalize, so the
    // in-memory cache (and thus launchForAgent's env injection) always sees the
    // original key. Legacy (no-prefix) keys pass through untouched.
    decryptAgentApiKeys(raw)
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
  const raw = readJsonFile<Partial<SystemSettings>>(settingsFile())
  // Same plaintext invariant as loadSettings: decrypt before any merge/normalize so
  // a re-read inside a write lock (saveSettings / saveWorkspaceSetting) round-trips
  // plaintext through the cache and re-encrypts on write — never caches ciphertext.
  if (raw) decryptAgentApiKeys(raw)
  return raw
}

/**
 * Merge an incoming settings object over the authoritative disk snapshot, preserving
 * the fields a partial writer (the system-settings panel) does not own/carry — the
 * anti-clobber rule that stops `save_settings` from wiping project config:
 *  - `projectConfigs` — per-project map; `undefined` in `next` ⇒ keep disk wholesale;
 *    present ⇒ shallow-merged per key so another process's newly-added project
 *    survives while `next`'s explicit entries win.
 *  - `degradationChain` / `socketAutoResume` / `proxy` — `undefined` ⇒ keep disk; present ⇒ use `next`.
 *  - `vendorCliVersions` — `undefined` ⇒ keep disk; present ⇒ use `next`.
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
  const proxy = next.proxy !== undefined ? next.proxy : d.proxy
  const vendorCliVersions =
    next.vendorCliVersions !== undefined ? next.vendorCliVersions : d.vendorCliVersions
  return {
    ...next,
    ...(projectConfigs !== undefined ? { projectConfigs } : {}),
    ...(degradationChain !== undefined ? { degradationChain } : {}),
    ...(socketAutoResume !== undefined ? { socketAutoResume } : {}),
    ...(proxy !== undefined ? { proxy } : {}),
    ...(vendorCliVersions !== undefined ? { vendorCliVersions } : {}),
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
    const disk = readSettingsFromDisk()
    const merged = mergeSettingsOverDisk(disk, next)
    const normalized = normalize(merged)
    try {
      // Encrypt apiKeys for disk only; the cache keeps the plaintext `normalized`
      // so the runtime (launchForAgent env injection) always reads the real key.
      // The personalized-settings and external-MCP-key collections are siblings of
      // SystemSettings and never travel in a system-settings snapshot, so re-attach
      // the disk copy — a whole-object save must not wipe another settings class,
      // and (for the keys) must not be able to inject or read back hash material.
      writeAtomic(settingsFile(), {
        ...encryptAgentApiKeys(normalized),
        ...personalizedFileKeys(disk),
        ...mcpApiKeyFileKeys(disk),
      })
      settingsCache = normalized
    } catch (err) {
      console.error('[c3] failed to persist settings:', err)
    }
    return settingsCache ?? normalized
  })
}

export function getVendorCliVersions(): Partial<Record<VendorId, string>> {
  return loadSettings().vendorCliVersions ?? {}
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
export function getDefaultMode(workspacePath: string, vendor?: VendorId): ModeToken {
  const map = loadWorkspaceSetting(workspacePath).defaultMode ?? DEFAULT_MODE_MAP
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
export function getCodexDefaultPolicy(workspacePath: string): CodexPolicy | undefined {
  const map = loadWorkspaceSetting(workspacePath).defaultMode
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
      const { agentId, vendor, storeScope } = v as Record<string, unknown>
      if (typeof agentId !== 'string' || !agentId) continue
      // Accept any vendor c3 knows (guarded by the authoritative list, not a
      // hard-coded pair, so a newer vendor's persisted fact is never dropped).
      if (!isVendorId(vendor)) continue
      // Preserve a frozen storeScope when present; a fact written before the
      // scope existed is a host session (sandbox stores are newer), so absence
      // stays absent and reads as 'host' at the getter.
      sessionAgents[id] =
        storeScope === 'host' || storeScope === 'sandbox'
          ? { agentId, vendor, storeScope }
          : { agentId, vendor }
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
 * The frozen store scope of a real session (ADR-0015). Defaults to `'host'` when
 * the fact predates the scope (every pre-sandbox session) or has no fact yet —
 * so the read/resume path looks in the host store unless a sandbox run explicitly
 * froze it there.
 */
export function getSessionStoreScope(realId: string): StoreScope {
  return loadState().sessionAgents[realId]?.storeScope ?? 'host'
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
  storeScope: StoreScope,
): void {
  const state = loadState()
  let dirty = false
  if (pendingId in state.pendingIntents) {
    delete state.pendingIntents[pendingId]
    dirty = true
  }
  if (!(realId in state.sessionAgents)) {
    state.sessionAgents[realId] = { agentId, vendor, storeScope }
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
  // storeScope is frozen like vendor — an agent swap never relocates the store;
  // preserve the existing scope (absent stays absent ⇒ reads as 'host').
  state.sessionAgents[realId] = {
    agentId,
    vendor: existing?.vendor ?? vendor,
    ...(existing?.storeScope ? { storeScope: existing.storeScope } : {}),
  }
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
export function isConsensusEnabled(workspacePath: string): boolean {
  return loadWorkspaceSetting(workspacePath).consensus?.enabled === true
}

/**
 * The normalized consensus config for a project (mode + cleaned agentIds), or
 * `undefined` when none is configured. Passed to `selectConsensusVoters` so the
 * voter set respects the `custom`-mode allowlist. Returns the already-normalized
 * value (`loadWorkspaceSetting` ran `normalizeWorkspaceSetting`), so `agentIds`
 * is pre-cleaned of stale/disabled ids.
 */
export function getConsensusConfig(workspacePath: string): ConsensusConfig | undefined {
  return loadWorkspaceSetting(workspacePath).consensus
}

/**
 * Whether consensus uses majority rule (vs. unanimous-only) for a project. Default false;
 * only an explicit `consensus.majority: true` enables it. Independent of
 * {@link isConsensusEnabled} — meaningful only when consensus is also enabled.
 */
export function isConsensusMajorityEnabled(workspacePath: string): boolean {
  return loadWorkspaceSetting(workspacePath).consensus?.majority === true
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

/**
 * The human-readable name (with native endonym) of the language server-side agent
 * prompts are written in — e.g. `Chinese (简体中文)`. Drives the "reply in this
 * language" instruction appended to agent prompts so their output follows the
 * language the console is actually being used in. See `config/personalized.ts` for
 * how that language is tracked; `en` when nothing has been reported yet.
 */
export function getAgentLangName(): string {
  return UI_LANG_NAMES[getAgentLang()]
}

/**
 * The system IANA time zone automations are computed in (normalized; a valid zone,
 * defaulting to the server's own zone). Passed to `computeNextRunAt` so cron
 * fields are interpreted in this zone.
 */
export function getTimezone(): string {
  const tz = loadSettings().timezone
  return isValidTimeZone(tz) ? tz : getServerTimezone()
}

/** The slash command prefixed to a intent when launching development; empty ⇒ no prefix. */
export function getDevSkill(workspacePath: string): string {
  return normalizeDevSkill(loadWorkspaceSetting(workspacePath).devSkill)
}

/** Whether spec-driven development is enabled for the workspace (default true). */
export function getSddEnabled(workspacePath: string): boolean {
  return normalizeSddEnabled(loadWorkspaceSetting(workspacePath).sddEnabled)
}

/**
 * Whether this workspace has explicitly opted in to MACHINE spec approval
 * (default `false`). Only a literal `true` opens the path: an absent, malformed
 * or legacy value reads as off, so upgrading never changes a workspace's approval
 * behaviour behind the user's back. A failed config read likewise yields `false` —
 * the fail-closed direction for a gate whose whole point is human oversight.
 */
export function getSpecMachineApprovalEnabled(workspacePath: string): boolean {
  return loadWorkspaceSetting(workspacePath).specMachineApprovalEnabled === true
}

/**
 * Whether the workspace-level automation auto-dispatch gate is open (default
 * `true`). Read by the cron tick loop and the event-trigger dispatcher before
 * dispatching; a missing/failed config read yields `true` so a transient fault
 * never silently mutes existing automations.
 */
export function getAutomationEnabled(workspacePath: string): boolean {
  return normalizeAutomationEnabled(loadWorkspaceSetting(workspacePath).automationEnabled)
}

/**
 * The workspace's git branch mode for `start_development`. Absent/unknown ⇒
 * `worktree` (the isolated development path).
 */
export function getGitBranchMode(workspacePath: string): GitBranchMode {
  return normalizeGitBranchMode(loadWorkspaceSetting(workspacePath).gitBranchMode)
}

/**
 * The workspace's configured default main branch (base for `worktree` mode), or
 * `undefined` when unset — callers then branch from current HEAD.
 */
export function getDefaultMainBranch(workspacePath: string): string | undefined {
  return normalizeDefaultMainBranch(loadWorkspaceSetting(workspacePath).defaultMainBranch)
}

/**
 * Return the workspace's explicit forge override. `auto` deliberately becomes
 * undefined so callers retain origin detection rather than passing a pseudo-provider.
 */
export function getForgeOverride(workspacePath: string): 'github' | 'gitlab' | undefined {
  const forge = normalizeWorkspaceForge(loadWorkspaceSetting(workspacePath).forge)
  return forge === 'auto' ? undefined : forge
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
 * Reads from the project's {@link WorkspaceSetting.skillRepos} via
 * {@link loadWorkspaceSetting}. Fail-hard — throws on any misconfiguration
 * (see {@link validateSkillRepos}). The devSkill collision check is performed
 * against the project's own devSkill, since both values now live in the
 * same project-level config.
 */
export function getSkillRepos(workspacePath: string): SkillRepoConfig[] {
  const cfg = loadWorkspaceSetting(workspacePath)
  return validateSkillRepos(cfg.skillRepos, cfg.devSkill)
}

/** The per-stage discussion round cap (normalized; always ≥ {@link MIN_ROUNDS_PER_STAGE}). */
export function getMaxRoundsPerStage(workspacePath: string): number {
  return normalizeMaxRoundsPerStage(loadWorkspaceSetting(workspacePath).maxRoundsPerStage)
}

/**
 * The discussion participant speech char budget (normalized; always ≥
 * {@link MIN_SPEECH_CHARS}). This is a prompt-level guidance — over-long
 * replies are accepted verbatim.
 */
export function getMaxSpeechChars(workspacePath: string): number {
  return normalizeMaxSpeechChars(loadWorkspaceSetting(workspacePath).maxSpeechChars)
}

/**
 * Get the project-level sandbox config (normalized). Returns `undefined`
 * when the project has no sandbox config (equivalent to disabled).
 */
export function getProjectSandbox(workspacePath: string): WorkspaceSandboxConfig | undefined {
  // Already normalized (branch-independent sandbox content) by
  // loadWorkspaceSetting → normalizeWorkspaceSetting → normalizeSandboxConfig.
  return loadWorkspaceSetting(workspacePath).sandbox
}

/** Test-only: drop the in-memory caches so the next call re-reads from disk. */
export function resetSettingsCacheForTests(): void {
  settingsCache = null
  stateCache = null
  resetPersonalizedCache()
  resetMcpApiKeyCache()
}
