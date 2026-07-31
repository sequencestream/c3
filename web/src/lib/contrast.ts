/**
 * Colour contrast — the WCAG relative-luminance maths plus the little bit of CSS
 * reading needed to point it at real design tokens.
 *
 * A text colour is only readable in combination with the surface it sits on, so the
 * unit of measurement here is a foreground/background pair, never a single token.
 * Translucent overlays (`rgba(...)`, `color-mix(... , transparent)`) are flattened
 * onto their backdrop first, because that composite is what the eye — and the
 * threshold — actually sees.
 *
 * The thresholds themselves come from the style spec: 4.5:1 for body text, 3:1 for
 * large or genuinely auxiliary text.
 */

/** A colour with 8-bit sRGB channels. */
export interface Rgb {
  r: number
  g: number
  b: number
}

/** Contrast floors from the style spec's accessibility section. */
export const CONTRAST_BODY = 4.5
export const CONTRAST_SECONDARY = 3

const HEX_SHORT = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i
const HEX_FULL = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i
const RGBA = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)\s*(?:[,/]\s*([\d.]+)\s*)?\)$/i

/** A parsed colour keeps its alpha so a caller can decide what to composite it over. */
export interface ParsedColor extends Rgb {
  a: number
}

/** Parse `#rgb`, `#rrggbb`, `rgb(...)` or `rgba(...)`. Throws on anything else. */
export function parseColor(value: string): ParsedColor {
  const text = value.trim()

  const short = HEX_SHORT.exec(text)
  if (short) {
    const [r, g, b] = short.slice(1, 4).map((c) => parseInt(c + c, 16))
    return { r: r!, g: g!, b: b!, a: 1 }
  }

  const full = HEX_FULL.exec(text)
  if (full) {
    const [r, g, b] = full.slice(1, 4).map((c) => parseInt(c, 16))
    return { r: r!, g: g!, b: b!, a: 1 }
  }

  const rgba = RGBA.exec(text)
  if (rgba) {
    const [r, g, b, a] = rgba.slice(1, 5)
    return { r: Number(r), g: Number(g), b: Number(b), a: a === undefined ? 1 : Number(a) }
  }

  throw new Error(`unsupported color: ${value}`)
}

/** Flatten a translucent colour onto an opaque backdrop (simple source-over). */
export function composite(front: ParsedColor, backdrop: Rgb): Rgb {
  const mix = (f: number, b: number) => Math.round(f * front.a + b * (1 - front.a))
  return { r: mix(front.r, backdrop.r), g: mix(front.g, backdrop.g), b: mix(front.b, backdrop.b) }
}

/** Resolve a colour string against a backdrop, so the result is always opaque. */
export function flatten(value: string, backdrop: Rgb): Rgb {
  return composite(parseColor(value), backdrop)
}

/** WCAG relative luminance of an opaque sRGB colour. */
export function relativeLuminance({ r, g, b }: Rgb): number {
  const channel = (raw: number) => {
    const c = raw / 255
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

/** WCAG contrast ratio between two opaque colours, from 1:1 to 21:1. */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const la = relativeLuminance(a)
  const lb = relativeLuminance(b)
  const [light, dark] = la >= lb ? [la, lb] : [lb, la]
  return (light! + 0.05) / (dark! + 0.05)
}

/**
 * The custom properties declared in one CSS block, keyed without the `--` prefix
 * stripped — callers look tokens up by their literal name.
 *
 * Deliberately naive: it reads a `selector { ... }` block out of a stylesheet and
 * pulls `--name: value;` declarations. That is all `standard.css` contains, and a
 * full CSS parser would only add a dependency to assert the same thing.
 */
export function readTokenBlock(css: string, selector: string): Record<string, string> {
  const start = css.indexOf(selector)
  if (start < 0) throw new Error(`selector not found: ${selector}`)
  const open = css.indexOf('{', start)
  const end = css.indexOf('\n}', open)
  if (open < 0 || end < 0) throw new Error(`unterminated block: ${selector}`)

  const tokens: Record<string, string> = {}
  for (const [, name, value] of css.slice(open, end).matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    tokens[name!] = value!.trim()
  }
  return tokens
}
