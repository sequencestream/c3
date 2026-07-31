/**
 * Theme registry — the console's display themes as data, plus the single runtime
 * that puts one on screen.
 *
 * A theme is an id and a display name, never a palette: every colour already lives
 * in `standard.css` as `--c-*` tokens, selected by the root element's `data-theme`.
 * So {@link applyTheme} does exactly one thing — map a theme id onto that attribute
 * (plus the matching `color-scheme`, which drives native form controls and
 * scrollbars) — and adding a preset later means one entry here and one CSS variable
 * block there, with no new branch in this module or in the settings page.
 *
 * Only registered ids reach the DOM: an unknown, missing or corrupt value normalizes
 * to {@link DEFAULT_THEME} first, so a stray string can never become a selector.
 */
import type { UiTheme } from '@ccc/shared/protocol'
import type { LocaleKey } from '@/i18n'

/** One registered theme. `labelKey` is an i18n key — theme names are ordinary UI copy. */
export interface ThemeDef {
  /** Stable id; also the `data-theme` value and what gets persisted. */
  id: UiTheme
  /** i18n key for the name shown in the theme selector. */
  labelKey: LocaleKey
  /** CSS `color-scheme` this theme renders under (native controls, scrollbars). */
  colorScheme: 'dark' | 'light'
}

/**
 * The available themes, in selector order. `dark` is first because it is the
 * built-in default and the console's original look.
 */
export const THEMES: readonly ThemeDef[] = [
  { id: 'dark', labelKey: 'personalizedSetting.theme.dark.label', colorScheme: 'dark' },
  { id: 'light', labelKey: 'personalizedSetting.theme.light.label', colorScheme: 'light' },
] as const

/** The theme used when nothing valid is stored anywhere — the existing dark console. */
export const DEFAULT_THEME: UiTheme = 'dark'

// Fails to compile if `UiTheme` gains a member the registry does not cover.
const _themesExhaustive: Record<UiTheme, true> = { dark: true, light: true }
void _themesExhaustive

export function isUiTheme(value: unknown): value is UiTheme {
  return typeof value === 'string' && THEMES.some((theme) => theme.id === value)
}

/** The registry entry for a theme id, or the default entry for anything unknown. */
export function resolveTheme(value: unknown): ThemeDef {
  const id = isUiTheme(value) ? value : DEFAULT_THEME
  return THEMES.find((theme) => theme.id === id)!
}

/**
 * Put a theme on screen: write the normalized id to the root element's `data-theme`
 * and its `color-scheme`. Returns the id actually applied, so callers persist what
 * the user is really looking at rather than what they asked for.
 *
 * `color-scheme` is also declared in CSS next to each theme's tokens; writing it here
 * as well keeps the applied theme correct even before the stylesheet has loaded.
 */
export function applyTheme(value: unknown): UiTheme {
  const theme = resolveTheme(value)
  try {
    document.documentElement.dataset.theme = theme.id
    document.documentElement.style.colorScheme = theme.colorScheme
  } catch {
    /* no document (SSR/test) — non-fatal, the resolved id is still returned */
  }
  return theme.id
}
