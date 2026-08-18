/*
 * logs-route.ts — the runtime-log viewer's standalone route.
 *
 * The console is a single mounted app, so the viewer gets its own hash route
 * instead of a tab: opening it in a new browser tab gives it its own document,
 * its own WebSocket and its own poll loop, and the main app in the original tab
 * keeps running untouched. `main.ts` reads this before mounting and picks the
 * root component; nothing else in the app reacts to it.
 *
 * The shape (`#/logs`) can never collide with the three-segment deep links
 * `parseDeepLink` accepts.
 */

/** The viewer's hash route. */
export const LOGS_ROUTE_HASH = '#/logs'

/** Whether a `location.hash` addresses the log viewer (with or without `#`). */
export function isLogsRoute(hash: string): boolean {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash
  const path = raw.startsWith('/') ? raw.slice(1) : raw
  return path.replace(/\/+$/, '') === 'logs'
}

/** The URL to open the viewer in a new tab, anchored at the current document. */
export function logsUrl(loc: { pathname: string; search: string }): string {
  return `${loc.pathname}${loc.search}${LOGS_ROUTE_HASH}`
}
