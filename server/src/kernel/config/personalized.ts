/**
 * Personalized-settings store — the per-account half of the third settings class
 * (`PersonalizedSettings`: preferences that differ per person, with no administrator
 * gate).
 *
 * Two things are owned here, both **siblings of** `SystemSettings` rather than fields
 * of it, so a whole-object system-settings save neither carries nor clobbers them —
 * structurally now, since they are separate rows (and, per account, a separate scope)
 * rather than keys of one shared document:
 *
 *  - `personalized_configs` — verified subject → that account's preferences, one
 *    scope per subject. Only a server-verified connection identity ever selects a
 *    record; a client cannot name the account it reads or writes.
 *  - `agentLang` — the language server-side agent prompts are written in (intent
 *    analysis replies, spec documents, automation titles, discussion/consensus
 *    summaries). Those call sites run without a connection — background automations
 *    have no user at all — so they cannot resolve a person's preference. The value
 *    therefore *tracks* the most recent personalized language any client reported,
 *    including an unauthenticated one (whose preference lives only in its browser).
 *    It is not an account default and is never read back as anyone's preference.
 *
 * Writes run in one transaction that re-reads first, so a first-login seed and a
 * concurrent save cannot lose each other. Reads are cached like `loadSettings`; the
 * cache is refreshed by our own writes.
 */
import type {
  PersonalizedSettings,
  PersonalizedSettingsBySubject,
  UiLang,
  UiTheme,
} from '@ccc/shared/protocol'
import { fromEntries, toEntries } from './config-codec.js'
import { AGENT_LANG_KEY, PERSONALIZED_RULES } from './config-schema.js'
import { configTx, listScopeOwners, readAllScopes, readKey, writeScope } from './config-store.js'

/** UI display languages, in dropdown order. The single source for validity here. */
export const UI_LANGS: readonly UiLang[] = ['en', 'zh', 'ja', 'ko', 'ru']

/** The display language when a record is missing, malformed, or names an unknown language. */
export const DEFAULT_UI_LANG: UiLang = 'en'

/**
 * Web-console display themes. The console owns the theme registry (names, palette,
 * how a theme reaches the DOM); the server only needs the set of ids it will accept
 * into a stored record, so a corrupt or made-up value never survives a round trip.
 */
export const UI_THEMES: readonly UiTheme[] = ['dark', 'light']

/** The theme when a record is missing, malformed, or names an unknown theme. */
export const DEFAULT_THEME: UiTheme = 'dark'

/** Accepted font-scale range (percent of the built-in size). */
export const FONT_SCALE_MIN = 70
export const FONT_SCALE_MAX = 120

/** The scale when a record is missing, malformed, or out of range — 100%, the built-in size. */
export const DEFAULT_FONT_SCALE = 100

/** In-memory mirror of the stored records; `null` until first read. */
let cache: { bySubject: PersonalizedSettingsBySubject; agentLang: UiLang } | null = null

/** Drop the cache so the next read re-reads the (possibly relocated) file. Test seam. */
export function resetPersonalizedCache(): void {
  cache = null
}

function isUiLang(v: unknown): v is UiLang {
  return typeof v === 'string' && UI_LANGS.includes(v as UiLang)
}

function isUiTheme(v: unknown): v is UiTheme {
  return typeof v === 'string' && UI_THEMES.includes(v as UiTheme)
}

function isFontScale(v: unknown): v is number {
  return typeof v === 'number' && v >= FONT_SCALE_MIN && v <= FONT_SCALE_MAX
}

/**
 * Force a raw record into a valid {@link PersonalizedSettings}. Every field
 * normalizes to its own default, so a record written by an older or newer client is
 * always readable and a corrupt value never propagates — in particular a theme this
 * server does not know falls back to dark without disturbing the stored language.
 */
export function normalizePersonalized(raw: unknown): PersonalizedSettings {
  const rec = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  return {
    uiLang: isUiLang(rec.uiLang) ? rec.uiLang : DEFAULT_UI_LANG,
    theme: isUiTheme(rec.theme) ? rec.theme : DEFAULT_THEME,
    fontScale: isFontScale(rec.fontScale) ? rec.fontScale : DEFAULT_FONT_SCALE,
  }
}

/** Normalize the subject → settings map, dropping non-object entries and empty keys. */
function normalizeMap(raw: unknown): PersonalizedSettingsBySubject {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: PersonalizedSettingsBySubject = {}
  for (const [subject, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!subject) continue
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue
    out[subject] = normalizePersonalized(value)
  }
  return out
}

/** Read every stored record straight from the tables (cache-bypassing). */
function readStored(): { bySubject: PersonalizedSettingsBySubject; agentLang: UiLang } {
  const raw: Record<string, unknown> = {}
  for (const [subject, entries] of readAllScopes('personalized')) {
    raw[subject] = fromEntries(entries, PERSONALIZED_RULES)
  }
  const lang = readKey({ kind: 'system' }, AGENT_LANG_KEY)?.value
  return { bySubject: normalizeMap(raw), agentLang: isUiLang(lang) ? lang : DEFAULT_UI_LANG }
}

/** Populate (or reuse) the cache. */
function load(): { bySubject: PersonalizedSettingsBySubject; agentLang: UiLang } {
  if (cache) return cache
  cache = readStored()
  return cache
}

/**
 * Apply a change to the stored records inside one transaction, re-reading first so a
 * first-login seed and a concurrent save cannot lose each other. Each account is its
 * own scope, so a write here can never disturb another account's record — nor the
 * system settings, which used to share the same file. Throws when the write fails
 * (callers surface a UI error rather than echo a pseudo-success).
 */
function mutate<T>(
  apply: (state: { bySubject: PersonalizedSettingsBySubject; agentLang: UiLang }) => T,
): T {
  return configTx(() => {
    const state = readStored()
    const before = new Set(Object.keys(state.bySubject))
    const result = apply(state)
    for (const [subject, record] of Object.entries(state.bySubject)) {
      writeScope({ kind: 'personalized', owner: subject }, toEntries(record, PERSONALIZED_RULES))
      before.delete(subject)
    }
    for (const subject of before) {
      writeScope({ kind: 'personalized', owner: subject }, [])
    }
    writeScope(
      { kind: 'system' },
      [{ key: AGENT_LANG_KEY, value: state.agentLang, type: 'string' }],
      { replace: false },
    )
    cache = state
    return result
  })
}

/** Subjects that currently have a stored record. */
export function listPersonalizedSubjects(): string[] {
  return listScopeOwners('personalized')
}

/** This account's stored preferences, or `null` when it has no record yet. */
export function loadPersonalizedFor(subject: string): PersonalizedSettings | null {
  const record = load().bySubject[subject]
  return record ? { ...record } : null
}

/**
 * Resolve the preferences a connection should use, seeding a brand-new account from
 * the browser's own values.
 *
 * With a subject: an existing account record is authoritative and returned as-is —
 * `localFallback` can only seed a subject that has **no** record, and the check-and-
 * create happens inside the lock, so concurrent logins produce exactly one creation
 * and every later caller reads the created value. Without a subject nothing is
 * stored per account; the normalized local value is simply echoed back.
 *
 * Either way the reported language advances {@link getAgentLang}, so server-side
 * agent prompts follow the most recent human choice even on an unauthenticated
 * deployment where the preference itself never leaves the browser.
 */
export function resolvePersonalized(
  subject: string | null,
  localFallback: PersonalizedSettings | undefined,
): PersonalizedSettings {
  const seed = normalizePersonalized(localFallback)
  if (!subject) {
    // No account applies: the browser is the store. Only the agent-prompt language
    // is worth persisting, and only when it actually changed (a plain reconnect
    // must not rewrite settings.json).
    if (localFallback && seed.uiLang !== load().agentLang) {
      mutate((state) => {
        state.agentLang = seed.uiLang!
      })
    }
    return seed
  }
  const existing = loadPersonalizedFor(subject)
  if (existing) {
    if (existing.uiLang && existing.uiLang !== load().agentLang) {
      mutate((state) => {
        state.agentLang = existing.uiLang!
      })
    }
    return existing
  }
  return mutate((state) => {
    // Re-check inside the lock: another connection may have created the record
    // between the cached read above and acquiring the lock. The first creation wins.
    const current = state.bySubject[subject]
    if (current) return { ...current }
    state.bySubject[subject] = { ...seed }
    state.agentLang = seed.uiLang!
    return { ...seed }
  })
}

/**
 * Persist a connection's preferences. With a subject the account record is replaced
 * by the normalized value; without one no account record is created (the browser
 * keeps its own copy) and only the agent-prompt language advances. Returns the
 * normalized value that was stored/echoed.
 */
export function savePersonalizedFor(
  subject: string | null,
  next: PersonalizedSettings,
): PersonalizedSettings {
  const normalized = normalizePersonalized(next)
  return mutate((state) => {
    if (subject) state.bySubject[subject] = { ...normalized }
    state.agentLang = normalized.uiLang!
    return { ...normalized }
  })
}

/**
 * The language server-side agent prompts are written in. See the module doc for why
 * this is a tracked value rather than a per-person read.
 */
export function getAgentLang(): UiLang {
  return load().agentLang
}
