/**
 * Personalized-settings repository — the browser half of the third settings class.
 *
 * Two stores back the same {@link PersonalizedSettings} shape and this module owns
 * the browser one. An authenticated connection's preferences live server-side under
 * its verified account; without an account (auth disabled, or before sign-in) this
 * browser IS the store, and its value is also what a first sign-in offers the server
 * as the seed for a brand-new account record.
 *
 * Every read normalizes: a missing key, corrupt value, unknown language, or a
 * browser that refuses storage all resolve to the built-in default rather than
 * blocking the page. Nothing here talks to the network — the WS round-trip lives in
 * the controls layer.
 */
import type { PersonalizedSettings, UiLang, UiTheme } from '@ccc/shared/protocol'
import { applyTheme, DEFAULT_THEME, isUiTheme } from './theme'
import { applyFontScale, DEFAULT_FONT_SCALE, isFontScale } from './font-scale'

/**
 * Per-field localStorage keys. The display language keeps the key the console has
 * always written, so a browser that already carries a language choice is a valid
 * fallback without any migration step.
 */
const UI_LANG_KEY = 'c3.uiLang'
const THEME_KEY = 'c3.theme'
const FONT_SCALE_KEY = 'c3.fontScale'

/** UI display languages. Mirrors the `UiLang` union; the assertion below pins them together. */
export const UI_LANGS = ['en', 'zh', 'ja', 'ko', 'ru'] as const
// Fails to compile if `UiLang` gains a member this list does not cover.
const _uiLangsExhaustive: readonly UiLang[] = UI_LANGS
void _uiLangsExhaustive

/** The display language when nothing valid is stored anywhere. */
export const DEFAULT_UI_LANG: UiLang = 'en'

/** The settings a connection with no stored preference at all starts from. */
export const DEFAULT_PERSONALIZED: PersonalizedSettings = {
  uiLang: DEFAULT_UI_LANG,
  theme: DEFAULT_THEME,
  fontScale: DEFAULT_FONT_SCALE,
}

export function isUiLang(value: unknown): value is UiLang {
  return typeof value === 'string' && (UI_LANGS as readonly string[]).includes(value)
}

/**
 * Force any input into a complete, valid {@link PersonalizedSettings}. Used on both
 * the local read and the server echo so the rest of the app never handles a partial
 * or unknown value. Each field falls back on its own, so a corrupt theme cannot cost
 * the user their language (or the other way round).
 */
export function normalizePersonalized(raw: unknown): PersonalizedSettings {
  const rec = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  return {
    uiLang: isUiLang(rec.uiLang) ? rec.uiLang : DEFAULT_UI_LANG,
    theme: isUiTheme(rec.theme) ? rec.theme : DEFAULT_THEME,
    fontScale: isFontScale(rec.fontScale) ? rec.fontScale : DEFAULT_FONT_SCALE,
  }
}

/**
 * The raw values this browser has stored, with no defaults filled in — `{}` when it
 * has never recorded a preference. This is what may seed a new account: an absent
 * field must stay absent so it cannot be mistaken for a deliberate choice.
 */
export function readLocalPersonalized(): PersonalizedSettings {
  try {
    const lang = localStorage.getItem(UI_LANG_KEY)
    const theme = localStorage.getItem(THEME_KEY)
    const fontScale = localStorage.getItem(FONT_SCALE_KEY)
    return {
      ...(isUiLang(lang) ? { uiLang: lang } : {}),
      ...(isUiTheme(theme) ? { theme } : {}),
      // A stored scale is a number string (e.g. `"87.5"`); anything non-numeric
      // or out of range is treated as nothing recorded.
      ...(isFontScale(Number(fontScale)) ? { fontScale: Number(fontScale) } : {}),
    }
  } catch {
    // Storage disabled/unavailable — behave as "nothing recorded".
    return {}
  }
}

/** True when this browser holds at least one valid recorded preference. */
export function hasLocalPersonalized(): boolean {
  return Object.keys(readLocalPersonalized()).length > 0
}

/**
 * Record the current preferences in this browser. Also called after an account save
 * succeeds, so this browser keeps the latest choice for its no-account state (and as
 * the seed any *other* account without a record would get here). Silently ignored
 * when storage is unavailable — the in-page state still applies.
 */
export function writeLocalPersonalized(settings: PersonalizedSettings): void {
  try {
    if (settings.uiLang !== undefined) localStorage.setItem(UI_LANG_KEY, settings.uiLang)
    if (settings.theme !== undefined) localStorage.setItem(THEME_KEY, settings.theme)
    if (settings.fontScale !== undefined)
      localStorage.setItem(FONT_SCALE_KEY, String(settings.fontScale))
  } catch {
    /* localStorage unavailable — non-fatal, the value still applies in-page */
  }
}

/**
 * Cold start: show the theme this browser recorded before anything renders, so the
 * console never flashes the wrong palette while the connection is still being made.
 * With no record (or an unusable store) this applies the built-in dark theme, which
 * is exactly the console's historical look. The account's authoritative value
 * arrives later with the server echo and corrects this if they differ.
 *
 * Lives here rather than in `theme.ts` to keep that module free of storage
 * knowledge: the dependency runs one way, repository → theme runtime.
 */
export function applyStoredTheme(): UiTheme {
  return applyTheme(readLocalPersonalized().theme)
}

/**
 * Cold start: apply the font scale this browser recorded before anything renders,
 * so the console never flashes the built-in size and swaps to the stored one.
 * With no record (or an unusable store) this applies 100% — the built-in look.
 * The account's authoritative value arrives later with the server echo and
 * corrects this if they differ.
 */
export function applyStoredFontScale(): number {
  return applyFontScale(readLocalPersonalized().fontScale)
}
