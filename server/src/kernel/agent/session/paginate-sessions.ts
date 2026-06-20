/**
 * Cursor pagination over an already-filtered, already-sorted `SessionInfo[]`
 * (SR-R14). Operates in memory on the full list `listSessionsVia` produces,
 * AFTER the hidden-set / tool-session filters, so a page's size is the
 * post-filter count (a SQL `LIMIT` would be shrunk by those downstream
 * filters). Keyset (not offset) paging keyed on the wire `sessionId` keeps
 * rows that share a `lastModified` from being skipped or duplicated across a
 * page boundary.
 */
import type { SessionInfo, SessionListCursor, SessionPageKind } from '@ccc/shared/protocol'

export interface SessionListQuery {
  /** Load-more: return the page strictly older than this keyset cursor. */
  before?: SessionListCursor
  /** Refresh: return the displayed range — every row `lastModified >= since`. */
  since?: number
  /** Page size for the `first` / `older` cases (defaulted when omitted). */
  limit?: number
}

export interface PaginatedSessions {
  sessions: SessionInfo[]
  kind: SessionPageKind
  /** Whether older rows exist beyond a `first` / `older` page. */
  hasMore: boolean
}

/** Page size when the client omits `limit` (server-initiated first pages). */
export const DEFAULT_SESSION_PAGE_SIZE = 20
const MAX_SESSION_PAGE_SIZE = 200

function clampLimit(limit: number | undefined): number {
  if (limit == null || !Number.isFinite(limit) || limit <= 0) return DEFAULT_SESSION_PAGE_SIZE
  return Math.min(Math.floor(limit), MAX_SESSION_PAGE_SIZE)
}

/**
 * Index of the first row strictly OLDER than `cursor` in the list's
 * newest-first order. Prefers the exact `sessionId` (the row last shown); if
 * that row is gone (deleted between pages), falls back to the first row whose
 * `lastModified` is strictly less than the cursor's. The exact path is precise
 * for same-timestamp siblings; the fallback is a rare delete-race best-effort
 * that the client's id-dedup still reconciles.
 */
function firstOlderIndex(all: SessionInfo[], cursor: SessionListCursor): number {
  const exact = all.findIndex((s) => s.sessionId === cursor.sessionId)
  if (exact >= 0) return exact + 1
  const fallback = all.findIndex((s) => s.lastModified < cursor.lastModified)
  return fallback >= 0 ? fallback : all.length
}

export function paginateSessions(
  all: SessionInfo[],
  query: SessionListQuery = {},
): PaginatedSessions {
  const { since } = query
  if (since != null) {
    const sessions = all.filter((s) => s.lastModified >= since)
    return { sessions, kind: 'window', hasMore: all.length > sessions.length }
  }
  const limit = clampLimit(query.limit)
  const start = query.before ? firstOlderIndex(all, query.before) : 0
  const sessions = all.slice(start, start + limit)
  return {
    sessions,
    kind: query.before ? 'older' : 'first',
    hasMore: all.length > start + limit,
  }
}
