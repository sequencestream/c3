/**
 * The environment a vendor CLI child starts from.
 *
 * Every adapter that spawns a CLI passes the child a *complete* environment
 * rather than a patch, because `spawn` replaces rather than merges. This is the
 * base every one of them layers its own variables over.
 *
 * @module
 */

/**
 * A mutable string copy of the current process environment.
 *
 * Copied rather than passed through so a caller can layer overrides onto it
 * without mutating `process.env`, and narrowed to defined values because `spawn`
 * rejects an `undefined` entry.
 */
export function inheritedEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value
  }
  return env
}
