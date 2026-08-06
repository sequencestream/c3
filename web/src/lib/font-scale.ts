/**
 * Font-scale registry + runtime — the console's global UI font scaling as data,
 * plus the single function that puts one value on screen.
 *
 * A scale is a percentage of the built-in font size (100 = 100%, no scaling). It
 * is not a size per component: every relative-unit font token in `standard.css`
 * is defined as `calc(原始值 * var(--c-font-scale))`, so {@link applyFontScale}
 * does exactly one thing — write the scale (as a ratio) onto the root element's
 * `--c-font-scale` CSS variable — and every token that consumes that variable
 * follows. Components that hard-code px do not scale; that is an accepted limit
 * of the baseline-zoom design, not a bug.
 *
 * Only values in `[FONT_SCALE_MIN, FONT_SCALE_MAX]` reach the DOM: a missing,
 * out-of-range or non-numeric value normalizes to {@link DEFAULT_FONT_SCALE}
 * first, so a corrupt stored value can never become an arbitrary CSS ratio.
 */
/** Lowest accepted scale: 70% of the built-in size. */
export const FONT_SCALE_MIN = 70

/** Highest accepted scale: 120%. Kept conservative so fixed-height layouts
 * (top bar, action menus) stay unbroken — beyond it text risks truncation. */
export const FONT_SCALE_MAX = 120

/** The scale when nothing valid is stored anywhere — the built-in size, 100%. */
export const DEFAULT_FONT_SCALE = 100

/** True for any number within the accepted range (fractions allowed, e.g. 87.5). */
export function isFontScale(value: unknown): value is number {
  return typeof value === 'number' && value >= FONT_SCALE_MIN && value <= FONT_SCALE_MAX
}

/** Force any value into the accepted range, falling back to the default. */
export function resolveFontScale(value: unknown): number {
  return isFontScale(value) ? value : DEFAULT_FONT_SCALE
}

/**
 * Put a scale on screen: write the normalized ratio onto the root element's
 * `--c-font-scale`. Returns the value actually applied, so callers persist what
 * the user is really seeing rather than what they asked for.
 */
export function applyFontScale(value: unknown): number {
  const scale = resolveFontScale(value)
  try {
    document.documentElement.style.setProperty('--c-font-scale', String(scale / 100))
  } catch {
    /* no document (SSR/test) — non-fatal, the resolved value is still returned */
  }
  return scale
}
