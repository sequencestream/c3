/**
 * Client merge of a paginated `sessions` reply into the per-workspace window
 * (SR-R14). Covers each page `kind`: first (replace), older (append+dedup),
 * window (refresh the displayed range while keeping loaded-more rows), and live
 * (bounded fan-out upsert that never touches the window).
 */
import { describe, it, expect } from 'vitest'
import type { SessionInfo } from '@ccc/shared/protocol'
import { mergeSessionPage, type SessionWindow } from './session-page'

function s(id: string, lastModified: number, title = id): SessionInfo {
  return {
    sessionId: id,
    title,
    lastModified,
    mode: 'default',
    isToolSession: false,
    vendor: 'claude',
  }
}

function win(sessions: SessionInfo[], hasMore = false, exhausted = false): SessionWindow {
  return { sessions, hasMore, exhausted }
}

describe('mergeSessionPage — first', () => {
  it('replaces the list and resets the window', () => {
    const prev = win([s('old', 1)], true, true)
    const out = mergeSessionPage(prev, [s('a', 300), s('b', 200)], { kind: 'first', hasMore: true })
    expect(out!.sessions.map((x) => x.sessionId)).toEqual(['a', 'b'])
    expect(out!.hasMore).toBe(true)
    expect(out!.exhausted).toBe(false)
  })
})

describe('mergeSessionPage — older', () => {
  it('appends the next page, dedups by id, keeps newest-first', () => {
    const prev = win([s('a', 300), s('b', 200)], true)
    const out = mergeSessionPage(prev, [s('c', 150), s('d', 100)], { kind: 'older', hasMore: true })
    expect(out!.sessions.map((x) => x.sessionId)).toEqual(['a', 'b', 'c', 'd'])
    expect(out!.hasMore).toBe(true)
    expect(out!.exhausted).toBe(false)
  })

  it('an empty/last older page flips to exhausted (hasMore=false)', () => {
    const prev = win([s('a', 300)], true)
    const out = mergeSessionPage(prev, [], { kind: 'older', hasMore: false })
    expect(out!.sessions.map((x) => x.sessionId)).toEqual(['a'])
    expect(out!.hasMore).toBe(false)
    expect(out!.exhausted).toBe(true)
  })
})

describe('mergeSessionPage — window', () => {
  it('refreshes the displayed range: new-at-top in, in-range deletion out, keeps older loaded rows', () => {
    // Loaded: a(300), b(200) [the window], plus c(100) pulled in by a load-more.
    const prev = win([s('a', 300), s('b', 200), s('c', 100)], true)
    // Refresh window since=200: server returns the new top (z@350), a renamed,
    // and DROPS b (deleted). c (<200) is below the window and must be kept.
    const incoming = [s('z', 350), s('a', 300, 'a-renamed')]
    const out = mergeSessionPage(prev, incoming, { kind: 'window', hasMore: false, since: 200 })
    expect(out!.sessions.map((x) => x.sessionId)).toEqual(['z', 'a', 'c'])
    expect(out!.sessions.find((x) => x.sessionId === 'a')!.title).toBe('a-renamed')
    // Pagination depth is preserved from prev (not the window reply).
    expect(out!.hasMore).toBe(true)
  })

  it('dedups by id when a below-window row was bumped into the refreshed range', () => {
    // c was at 100 (below since=200); a run-end bumped it to 360 — it now arrives
    // in the window. The stale 100 copy must not linger.
    const prev = win([s('a', 300), s('c', 100)], false)
    const incoming = [s('c', 360), s('a', 300)]
    const out = mergeSessionPage(prev, incoming, { kind: 'window', hasMore: false, since: 200 })
    expect(out!.sessions.map((x) => x.sessionId)).toEqual(['c', 'a'])
    expect(out!.sessions.filter((x) => x.sessionId === 'c')).toHaveLength(1)
    expect(out!.sessions[0].lastModified).toBe(360)
  })
})

describe('mergeSessionPage — live', () => {
  it('upserts by id without changing the window or pagination flags', () => {
    const prev = win([s('a', 300), s('b', 200)], true, false)
    // A freshly-bound session at the top + a title update for b.
    const out = mergeSessionPage(prev, [s('new', 400), s('b', 200, 'b2')], {
      kind: 'live',
      hasMore: false,
    })
    expect(out!.sessions.map((x) => x.sessionId)).toEqual(['new', 'a', 'b'])
    expect(out!.sessions.find((x) => x.sessionId === 'b')!.title).toBe('b2')
    expect(out!.hasMore).toBe(true) // unchanged
  })

  it('is ignored for a not-yet-loaded workspace', () => {
    const out = mergeSessionPage(undefined, [s('new', 400)], { kind: 'live', hasMore: false })
    expect(out).toBeUndefined()
  })
})
