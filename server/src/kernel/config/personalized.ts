/**
 * Personalized-settings store — the per-account half of the third settings class
 * (`PersonalizedSettings`: preferences that differ per person, with no administrator
 * gate).
 *
 * Two top-level keys of `settings.json` are owned here, both **siblings of**
 * `SystemSettings` rather than fields of it, so a whole-object system-settings save
 * neither carries nor clobbers them (`config/index.ts` re-attaches them on write):
 *
 *  - `personalizedSettings` — verified subject → that account's preferences. Only a
 *    server-verified connection identity ever selects a record; a client cannot name
 *    the account it reads or writes.
 *  - `agentLang` — the language server-side agent prompts are written in (intent
 *    analysis replies, spec documents, automation titles, discussion/consensus
 *    summaries). Those call sites run without a connection — background automations
 *    have no user at all — so they cannot resolve a person's preference. The value
 *    therefore *tracks* the most recent personalized language any client reported,
 *    including an unauthenticated one (whose preference lives only in its browser).
 *    It is not an account default and is never read back as anyone's preference.
 *
 * Writes go through the same cross-process file lock as every other settings write,
 * re-reading the disk inside the lock, so a first-login seed and a concurrent save
 * cannot lose each other. Reads are cached like `loadSettings`; the cache is
 * refreshed by our own writes.
 */
import type {
  PersonalizedSettings,
  PersonalizedSettingsBySubject,
  UiLang,
  UiTheme,
} from '@ccc/shared/protocol'
import { readJsonFile, withFileLock, writeAtomic } from './store.js'
import { settingsFile } from './paths.js'

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

/**
 * The raw settings-file shape as far as this module cares: the two keys it owns,
 * plus whatever else the file holds (preserved verbatim on write). Read untyped and
 * written back untouched, so this store never needs the `SystemSettings` shape and
 * never re-normalizes — in particular it never has to decrypt agent api keys.
 */
interface PersonalizedFileShape extends Record<string, unknown> {
  personalizedSettings?: unknown
  agentLang?: unknown
}

/** In-memory mirror of the two owned keys; `null` until first read. */
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

function readFile(): PersonalizedFileShape {
  return readJsonFile<PersonalizedFileShape>(settingsFile()) ?? {}
}

/** Populate (or reuse) the cache from disk. */
function load(): { bySubject: PersonalizedSettingsBySubject; agentLang: UiLang } {
  if (cache) return cache
  const raw = readFile()
  cache = {
    bySubject: normalizeMap(raw.personalizedSettings),
    agentLang: isUiLang(raw.agentLang) ? raw.agentLang : DEFAULT_UI_LANG,
  }
  return cache
}

/**
 * The owned keys as they must appear on disk, read from a raw file snapshot. Used by
 * the system-settings write path to re-attach them to the object it writes, so a
 * whole-object save preserves them.
 */
export function personalizedFileKeys(diskRaw: unknown): {
  personalizedSettings?: PersonalizedSettingsBySubject
  agentLang?: UiLang
} {
  const raw = (diskRaw && typeof diskRaw === 'object' ? diskRaw : {}) as PersonalizedFileShape
  const bySubject = normalizeMap(raw.personalizedSettings)
  return {
    ...(Object.keys(bySubject).length > 0 ? { personalizedSettings: bySubject } : {}),
    ...(isUiLang(raw.agentLang) ? { agentLang: raw.agentLang } : {}),
  }
}

/**
 * Write the owned keys back into the settings file, preserving every other key
 * verbatim. Runs inside the cross-process settings lock with a fresh disk read, so
 * it never trusts a stale snapshot and never rewrites a sibling key it did not
 * intend to touch. Throws when the write fails (callers surface a UI error rather
 * than echo a pseudo-success).
 */
function mutate<T>(
  apply: (state: { bySubject: PersonalizedSettingsBySubject; agentLang: UiLang }) => T,
): T {
  return withFileLock(settingsFile(), () => {
    const raw = readFile()
    const state = {
      bySubject: normalizeMap(raw.personalizedSettings),
      agentLang: isUiLang(raw.agentLang) ? raw.agentLang : DEFAULT_UI_LANG,
    }
    const result = apply(state)
    writeAtomic(settingsFile(), {
      ...raw,
      // The legacy system-wide display language is dropped here as well as by the
      // system-settings normalize, so no write path can resurrect it.
      uiLang: undefined,
      personalizedSettings: state.bySubject,
      agentLang: state.agentLang,
    })
    cache = state
    return result
  })
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
