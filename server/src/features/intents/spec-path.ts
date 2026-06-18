/**
 * Spec document path layout — pure, feature-private (ADR-0009).
 *
 * Computes where a spec document lands for an intent:
 *   <specPath>/yyyy/mm/dd/yyyy-mm-dd-<NNN>-<slug>/spec.md
 *
 * `<slug>` is the intent's short English title slugged (falling back to the
 * intent id prefix when empty / non-ASCII), and `<NNN>` is a 3-digit
 * per-day sequence under the day root (max existing + 1, 001 when none).
 *
 * The only impure input — reading the day directory's existing entries — is
 * injected as `listDay`, so the slug / date / sequence logic is unit-testable
 * without touching disk.
 */
import path from 'node:path'

/** Length of the intent-id fallback slug when the short title yields nothing. */
const ID_SLUG_LEN = 8

/**
 * Slug an English title: lowercase, every run of non-alphanumerics → a single
 * `-`, and trimmed of leading/trailing `-`. Returns `''` for null / blank /
 * all-non-ASCII input (the caller falls back to the intent id).
 */
export function slugify(title: string | null): string {
  if (!title) return ''
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/**
 * The directory slug for an intent: the slugged short title, or — when that is
 * empty — the intent id's leading alphanumerics (lowercased, capped). The id
 * fallback is itself sanitised so a UUID's hyphens never break the `NNN-slug`
 * parse.
 */
export function specSlug(shortEnTitle: string | null, intentId: string): string {
  const s = slugify(shortEnTitle)
  if (s.length > 0) return s
  return intentId
    .replace(/[^a-z0-9]/gi, '')
    .slice(0, ID_SLUG_LEN)
    .toLowerCase()
}

/** `yyyy` / `mm` / `dd` parts from a Date (server local time). */
export function dateParts(now: Date): { yyyy: string; mm: string; dd: string } {
  return {
    yyyy: String(now.getFullYear()),
    mm: String(now.getMonth() + 1).padStart(2, '0'),
    dd: String(now.getDate()).padStart(2, '0'),
  }
}

/**
 * Next 3-digit sequence under a day root. `existingNames` is the day dir's
 * entry names (`[]` when the dir is absent). Robust: ignores names that don't
 * match `yyyy-mm-dd-NNN-*`, returns `001` when none match.
 */
export function nextSeq(existingNames: readonly string[], datePrefix: string): string {
  const re = new RegExp(`^${datePrefix}-(\\d{3})-`)
  let max = 0
  for (const name of existingNames) {
    const m = re.exec(name)
    if (m) max = Math.max(max, Number.parseInt(m[1], 10))
  }
  return String(max + 1).padStart(3, '0')
}

/** Resolved spec document layout for one intent. */
export interface SpecLayout {
  /** Absolute directory `<workspace>/<specPath>/yyyy/mm/dd/yyyy-mm-dd-NNN-slug`. */
  dirAbs: string
  /** Absolute `spec.md` path. */
  fileAbs: string
  /** `spec.md` path relative to the workspace root (stored as `spec_path`). */
  fileRel: string
  /** The leaf directory name `yyyy-mm-dd-NNN-slug`. */
  dirName: string
}

/**
 * Compute the spec layout for an intent. `listDay(dayRootAbs)` returns the day
 * directory's existing entry names (must return `[]` rather than throw when the
 * directory is absent); everything else is pure.
 */
export function computeSpecLayout(args: {
  workspacePath: string
  specPath: string
  shortEnTitle: string | null
  intentId: string
  now: Date
  listDay: (dayRootAbs: string) => readonly string[]
}): SpecLayout {
  const { yyyy, mm, dd } = dateParts(args.now)
  const datePrefix = `${yyyy}-${mm}-${dd}`
  const dayRootRel = path.join(args.specPath, yyyy, mm, dd)
  const dayRootAbs = path.join(args.workspacePath, dayRootRel)
  const seq = nextSeq(args.listDay(dayRootAbs), datePrefix)
  const slug = specSlug(args.shortEnTitle, args.intentId)
  const dirName = `${datePrefix}-${seq}-${slug}`
  return {
    dirAbs: path.join(dayRootAbs, dirName),
    fileAbs: path.join(dayRootAbs, dirName, 'spec.md'),
    fileRel: path.join(dayRootRel, dirName, 'spec.md'),
    dirName,
  }
}
