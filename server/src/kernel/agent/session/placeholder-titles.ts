/**
 * The one placeholder-title vocabulary shared by the projection table, the
 * session list path, and each vendor's session store.
 *
 * A title in this set means "no display name has been derived yet" — it is
 * never a user rename and never a vendor-written summary. Every layer that
 * decides whether a title is worth persisting or overwriting must ask this
 * module, so the answer cannot drift between them.
 */

/** The title a freshly-bound projection row carries before a native name exists. */
export const DEFAULT_SESSION_TITLE = 'New session'

/** The fallback some native stores report when they have no derived name yet. */
export const UNTITLED_SESSION_TITLE = 'Untitled session'

/** Titles that stand in for a name c3 has not derived yet. */
export const PLACEHOLDER_TITLES: ReadonlySet<string> = new Set([
  DEFAULT_SESSION_TITLE,
  UNTITLED_SESSION_TITLE,
])

/** Whether `title` is a placeholder rather than a real display name. */
export function isPlaceholderTitle(title: string): boolean {
  return PLACEHOLDER_TITLES.has(title)
}
