/*
 * session-page.ts — pure merge of a paginated `sessions` reply into the
 * sidebar's per-workspace window (SR-R14). The server sends one page at a time
 * tagged with a {@link SessionPageKind}; this reducer folds it into the window
 * the client already holds. Kept DOM-free so it unit-tests in isolation.
 */
import type { SessionInfo, SessionPageKind } from '@ccc/shared/protocol'

/** Page size the client requests for the first page and each "load more" (SR-R14). */
export const SESSION_PAGE_SIZE = 20

/** The client's loaded view of one workspace's sessions. */
export interface SessionWindow {
  /** Loaded sessions, newest-first (server order mirrored). */
  sessions: SessionInfo[]
  /** Older rows exist beyond the loaded window (drives the "load more" button). */
  hasMore: boolean
  /** A load-more found nothing more — show "Fully loaded" instead of the button. */
  exhausted: boolean
}

/** Newest-first, mirroring the server: a `0` last-modified (Codex) sinks last. */
export function sortSessions(list: readonly SessionInfo[]): SessionInfo[] {
  return [...list].sort((a, b) => {
    if (a.lastModified === 0 && b.lastModified === 0) return 0
    if (a.lastModified === 0) return 1
    if (b.lastModified === 0) return -1
    return b.lastModified - a.lastModified
  })
}

/** Dedup by `sessionId` (first occurrence wins) then sort newest-first. */
function uniqSort(list: readonly SessionInfo[]): SessionInfo[] {
  const seen = new Set<string>()
  const out: SessionInfo[] = []
  for (const s of list) {
    if (seen.has(s.sessionId)) continue
    seen.add(s.sessionId)
    out.push(s)
  }
  return sortSessions(out)
}

export interface SessionPageMerge {
  kind: SessionPageKind
  hasMore: boolean
  /** The `since` the client sent for a `window` refresh (the boundary to keep below). */
  since?: number
}

/**
 * Fold an incoming page into the window per its `kind` (SR-R14). `prev` is
 * `undefined` for a never-loaded workspace. Returns `undefined` only for a
 * `live` push into a not-yet-loaded workspace (ignored — it loads on demand).
 * In every merge `incoming` rows win over existing same-id rows, so any overlap
 * (a tie boundary, a re-broadcast, a bumped last-modified) collapses to one.
 */
export function mergeSessionPage(
  prev: SessionWindow | undefined,
  incoming: SessionInfo[],
  meta: SessionPageMerge,
): SessionWindow | undefined {
  switch (meta.kind) {
    case 'first':
      return { sessions: uniqSort(incoming), hasMore: meta.hasMore, exhausted: false }
    case 'older': {
      const base = prev?.sessions ?? []
      return {
        sessions: uniqSort([...incoming, ...base]),
        hasMore: meta.hasMore,
        // No more older rows ⇒ the next "load more" would be empty: show "Fully loaded".
        exhausted: !meta.hasMore,
      }
    }
    case 'window': {
      // Refresh the displayed range `[since, +∞)`: `incoming` is authoritative
      // for it (new-at-top in, in-range deletions out). Rows BELOW `since` were
      // pulled in by a later "load more"; keep them (minus any now echoed in
      // `incoming` with a bumped time). Pagination depth is unchanged.
      if (!prev) return { sessions: uniqSort(incoming), hasMore: meta.hasMore, exhausted: false }
      const ids = new Set(incoming.map((s) => s.sessionId))
      const boundary = meta.since
      const kept =
        boundary == null
          ? []
          : prev.sessions.filter((s) => s.lastModified < boundary && !ids.has(s.sessionId))
      return {
        sessions: uniqSort([...incoming, ...kept]),
        hasMore: prev.hasMore,
        exhausted: prev.exhausted,
      }
    }
    case 'live': {
      // Bounded fan-out (bind/settle): upsert by id, never touch the window or
      // pagination flags. Ignore for a workspace the user hasn't opened.
      if (!prev) return undefined
      return { ...prev, sessions: uniqSort([...incoming, ...prev.sessions]) }
    }
  }
}
