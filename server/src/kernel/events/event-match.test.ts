import { describe, it, expect } from 'vitest'
import type { GenericEventFilter } from '@ccc/shared/protocol'
import { normalizeGenericEventFilter } from '@ccc/shared'
import { genericEventFilterMatches, type GenericEventView } from './event-match.js'

describe('generic event filter — genericEventFilterMatches', () => {
  const ws = '/abs/workspace'
  const view = (event: GenericEventView['event'], workspacePath = ws): GenericEventView => ({
    workspacePath,
    event,
  })

  it('matches on all four dimensions when every one passes', () => {
    const filter: GenericEventFilter = {
      type: 'run:settled',
      statuses: ['complete'],
      metadata: { combinator: 'AND', conditions: [{ key: 'src', value: 'ci' }] },
    }
    const res = genericEventFilterMatches(
      ws,
      filter,
      view({ type: 'run:settled', status: 'complete', metadata: { src: 'ci' } }),
    )
    expect(res.matched).toBe(true)
    expect(res.breakdown.map((b) => b.name)).toEqual(['workspace', 'type', 'status', 'metadata'])
  })

  it('fails closed on a null filter (type never matches)', () => {
    const res = genericEventFilterMatches(ws, null, view({ type: 'run:settled' }))
    expect(res.matched).toBe(false)
    expect(res.breakdown.find((b) => b.name === 'type')?.passed).toBe(false)
  })

  it('fails on a workspace mismatch', () => {
    const res = genericEventFilterMatches(
      ws,
      { type: 'run:settled' },
      view({ type: 'run:settled' }, '/other/workspace'),
    )
    expect(res.matched).toBe(false)
    expect(res.breakdown.find((b) => b.name === 'workspace')?.passed).toBe(false)
  })

  it('fails on a type mismatch', () => {
    const res = genericEventFilterMatches(
      ws,
      { type: 'run:settled' },
      view({ type: 'run:started' }),
    )
    expect(res.matched).toBe(false)
    expect(res.breakdown.find((b) => b.name === 'type')?.passed).toBe(false)
  })

  it('absent/empty statuses matches any status (including no status)', () => {
    expect(
      genericEventFilterMatches(ws, { type: 't' }, view({ type: 't', status: 'anything' })).matched,
    ).toBe(true)
    expect(genericEventFilterMatches(ws, { type: 't' }, view({ type: 't' })).matched).toBe(true)
  })

  it('non-empty statuses requires an exact, case-sensitive membership', () => {
    const filter: GenericEventFilter = { type: 't', statuses: ['complete', 'error'] }
    expect(
      genericEventFilterMatches(ws, filter, view({ type: 't', status: 'error' })).matched,
    ).toBe(true)
    expect(
      genericEventFilterMatches(ws, filter, view({ type: 't', status: 'Complete' })).matched,
    ).toBe(false)
    // An event that carries no status fails a non-empty statuses filter.
    expect(genericEventFilterMatches(ws, filter, view({ type: 't' })).matched).toBe(false)
  })

  it('metadata AND requires every condition; OR requires at least one', () => {
    const andFilter: GenericEventFilter = {
      type: 't',
      metadata: {
        combinator: 'AND',
        conditions: [
          { key: 'a', value: '1' },
          { key: 'b', value: '2' },
        ],
      },
    }
    expect(
      genericEventFilterMatches(ws, andFilter, view({ type: 't', metadata: { a: '1', b: '2' } }))
        .matched,
    ).toBe(true)
    expect(
      genericEventFilterMatches(ws, andFilter, view({ type: 't', metadata: { a: '1' } })).matched,
    ).toBe(false)

    const orFilter: GenericEventFilter = {
      type: 't',
      metadata: {
        combinator: 'OR',
        conditions: [
          { key: 'operation', value: 'create' },
          { key: 'operation', value: 'merge' },
        ],
      },
    }
    expect(
      genericEventFilterMatches(ws, orFilter, view({ type: 't', metadata: { operation: 'merge' } }))
        .matched,
    ).toBe(true)
    expect(
      genericEventFilterMatches(ws, orFilter, view({ type: 't', metadata: { operation: 'close' } }))
        .matched,
    ).toBe(false)
  })

  it('missing event metadata key fails a metadata condition', () => {
    const filter: GenericEventFilter = {
      type: 't',
      metadata: { combinator: 'AND', conditions: [{ key: 'a', value: '1' }] },
    }
    expect(genericEventFilterMatches(ws, filter, view({ type: 't' })).matched).toBe(false)
  })

  it('requires ALL dimensions together — one failing dimension fails the match', () => {
    const filter: GenericEventFilter = { type: 't', statuses: ['ok'] }
    // type + status pass individually but a workspace mismatch still fails overall.
    const res = genericEventFilterMatches(ws, filter, view({ type: 't', status: 'ok' }, '/other'))
    expect(res.matched).toBe(false)
    expect(res.breakdown.filter((b) => b.passed).map((b) => b.name)).toEqual([
      'type',
      'status',
      'metadata',
    ])
  })
})

describe('genericEventFilterMatches — pure matcher semantics', () => {
  const WS = '/abs/ws'
  const view = (event: GenericEventView['event'], workspacePath = WS): GenericEventView => ({
    workspacePath,
    event,
  })
  const F = (f: Partial<GenericEventFilter> & { type: string }): GenericEventFilter => f

  it('a null filter never matches (fails closed on type)', () => {
    const res = genericEventFilterMatches(WS, null, view({ type: 'x' }))
    expect(res.matched).toBe(false)
    expect(res.breakdown.find((b) => b.name === 'type')?.passed).toBe(false)
  })

  it('matches when every dimension passes, with a stable breakdown order', () => {
    const res = genericEventFilterMatches(
      WS,
      F({
        type: 'pr:operation',
        statuses: ['success'],
        metadata: { conditions: [{ key: 'operation', value: 'merge' }], combinator: 'AND' },
      }),
      view({ type: 'pr:operation', status: 'success', metadata: { operation: 'merge' } }),
    )
    expect(res.matched).toBe(true)
    expect(res.breakdown.map((b) => b.name)).toEqual(['workspace', 'type', 'status', 'metadata'])
  })

  it('fails on a workspace mismatch', () => {
    const res = genericEventFilterMatches(WS, F({ type: 'x' }), view({ type: 'x' }, '/abs/other'))
    expect(res.matched).toBe(false)
    expect(res.breakdown.find((b) => b.name === 'workspace')?.passed).toBe(false)
  })

  it('fails on a type mismatch', () => {
    expect(genericEventFilterMatches(WS, F({ type: 'a' }), view({ type: 'b' })).matched).toBe(false)
  })

  it('status: absent/empty statuses matches any (incl. an event with no status)', () => {
    expect(genericEventFilterMatches(WS, F({ type: 't' }), view({ type: 't' })).matched).toBe(true)
    expect(
      genericEventFilterMatches(WS, F({ type: 't', statuses: [] }), view({ type: 't' })).matched,
    ).toBe(true)
  })

  it('status: a non-empty statuses requires an exact, case-sensitive membership', () => {
    const f = F({ type: 't', statuses: ['complete', 'error'] })
    expect(genericEventFilterMatches(WS, f, view({ type: 't', status: 'error' })).matched).toBe(
      true,
    )
    expect(genericEventFilterMatches(WS, f, view({ type: 't', status: 'aborted' })).matched).toBe(
      false,
    )
    expect(genericEventFilterMatches(WS, f, view({ type: 't', status: 'Error' })).matched).toBe(
      false,
    )
    // An event that carries no status fails a non-empty statuses filter.
    expect(genericEventFilterMatches(WS, f, view({ type: 't' })).matched).toBe(false)
  })

  it('metadata: AND requires all, OR requires one, missing key fails, exact case', () => {
    const and = F({
      type: 't',
      metadata: {
        conditions: [
          { key: 'a', value: '1' },
          { key: 'b', value: '2' },
        ],
        combinator: 'AND',
      },
    })
    expect(
      genericEventFilterMatches(WS, and, view({ type: 't', metadata: { a: '1', b: '2' } })).matched,
    ).toBe(true)
    expect(
      genericEventFilterMatches(WS, and, view({ type: 't', metadata: { a: '1' } })).matched,
    ).toBe(false)
    const or = F({
      type: 't',
      metadata: {
        conditions: [
          { key: 'a', value: '1' },
          { key: 'b', value: '2' },
        ],
        combinator: 'OR',
      },
    })
    expect(
      genericEventFilterMatches(WS, or, view({ type: 't', metadata: { b: '2' } })).matched,
    ).toBe(true)
    expect(
      genericEventFilterMatches(WS, or, view({ type: 't', metadata: { a: 'X' } })).matched,
    ).toBe(false)
    // Exact case on the value.
    expect(
      genericEventFilterMatches(WS, or, view({ type: 't', metadata: { a: '1' } })).matched,
    ).toBe(true)
  })

  it('all dimensions must pass together (type ok but status wrong → no match)', () => {
    const res = genericEventFilterMatches(
      WS,
      F({ type: 't', statuses: ['ok'] }),
      view({ type: 't', status: 'bad' }),
    )
    expect(res.matched).toBe(false)
    expect(res.breakdown.find((b) => b.name === 'type')?.passed).toBe(true)
    expect(res.breakdown.find((b) => b.name === 'status')?.passed).toBe(false)
  })
})
