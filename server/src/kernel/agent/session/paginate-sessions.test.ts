/**
 * Cursor pagination over the sorted session list (SR-R14). The input is the
 * already-sorted (newest-first) `SessionInfo[]` `listSessionsVia` produces; the
 * function slices it into pages and refresh windows without skipping or
 * duplicating same-`lastModified` rows.
 */
import { describe, expect, it } from 'vitest'
import type { SessionInfo } from '@ccc/shared/protocol'
import { DEFAULT_SESSION_PAGE_SIZE, paginateSessions } from './paginate-sessions.js'

function s(id: string, lastModified: number): SessionInfo {
  return {
    sessionId: id,
    title: id,
    lastModified,
    mode: 'default',
    isToolSession: false,
    vendor: 'claude',
  }
}

// Newest-first, with a same-timestamp pair (b1, b2 both at 200) on a page boundary.
const ALL = [s('a', 300), s('b1', 200), s('b2', 200), s('d', 100)]

describe('paginateSessions — first page', () => {
  it('returns the newest `limit` with kind=first and hasMore when more remain', () => {
    const page = paginateSessions(ALL, { limit: 2 })
    expect(page.kind).toBe('first')
    expect(page.sessions.map((x) => x.sessionId)).toEqual(['a', 'b1'])
    expect(page.hasMore).toBe(true)
  })

  it('hasMore is false when the page covers the whole list', () => {
    const page = paginateSessions(ALL, { limit: 10 })
    expect(page.sessions).toHaveLength(4)
    expect(page.hasMore).toBe(false)
  })

  it('defaults the page size when `limit` is omitted', () => {
    const many = Array.from({ length: DEFAULT_SESSION_PAGE_SIZE + 5 }, (_, i) =>
      s(`x${i}`, 1000 - i),
    )
    const page = paginateSessions(many)
    expect(page.sessions).toHaveLength(DEFAULT_SESSION_PAGE_SIZE)
    expect(page.hasMore).toBe(true)
  })
})

describe('paginateSessions — load-more (older)', () => {
  it('continues strictly after the keyset cursor, no skip / no dup at a tie', () => {
    // First page ended at b1 (200). The next page must start at b2 (also 200) —
    // a scalar `lastModified < 200` would wrongly skip b2.
    const page = paginateSessions(ALL, { before: { lastModified: 200, sessionId: 'b1' }, limit: 2 })
    expect(page.kind).toBe('older')
    expect(page.sessions.map((x) => x.sessionId)).toEqual(['b2', 'd'])
    expect(page.hasMore).toBe(false)
  })

  it('an older page past the end is empty with hasMore=false', () => {
    const page = paginateSessions(ALL, { before: { lastModified: 100, sessionId: 'd' }, limit: 2 })
    expect(page.sessions).toEqual([])
    expect(page.hasMore).toBe(false)
  })

  it('falls back to the first strictly-older row when the cursor row was deleted', () => {
    const page = paginateSessions(ALL, {
      before: { lastModified: 200, sessionId: 'gone' },
      limit: 2,
    })
    // 'gone' is absent → fall back to the first row with lastModified < 200.
    expect(page.sessions.map((x) => x.sessionId)).toEqual(['d'])
  })
})

describe('paginateSessions — window refresh (since)', () => {
  it('returns every row at or newer than `since`, kind=window', () => {
    const page = paginateSessions(ALL, { since: 200 })
    expect(page.kind).toBe('window')
    expect(page.sessions.map((x) => x.sessionId)).toEqual(['a', 'b1', 'b2'])
    // Older rows (d @ 100) exist beyond the window.
    expect(page.hasMore).toBe(true)
  })

  it('since=0 spans the whole list (Codex zeros included)', () => {
    const withZero = [...ALL, s('cx', 0)]
    const page = paginateSessions(withZero, { since: 0 })
    expect(page.sessions).toHaveLength(5)
    expect(page.hasMore).toBe(false)
  })
})
