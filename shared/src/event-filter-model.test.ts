import { describe, it, expect } from 'vitest'
import { normalizeGenericEventFilter } from './event-filter-model.js'

describe('generic event filter — normalizeGenericEventFilter', () => {
  it('rejects a filter with no valid type (never widens to "any type")', () => {
    expect(normalizeGenericEventFilter(null)).toBeNull()
    expect(normalizeGenericEventFilter({})).toBeNull()
    expect(normalizeGenericEventFilter({ type: '' })).toBeNull()
    expect(normalizeGenericEventFilter({ type: '   ' })).toBeNull()
    expect(normalizeGenericEventFilter({ type: 'x'.repeat(65) })).toBeNull()
  })

  it('keeps a bare type, dropping empty status/metadata dimensions', () => {
    expect(normalizeGenericEventFilter({ type: 'run:settled' })).toEqual({ type: 'run:settled' })
    expect(
      normalizeGenericEventFilter({ type: 'run:settled', statuses: [], metadata: null }),
    ).toEqual({ type: 'run:settled' })
  })

  it('trims, dedups, and caps statuses; drops empty/over-long entries', () => {
    const res = normalizeGenericEventFilter({
      type: 'run:settled',
      statuses: [' complete ', 'complete', 'error', '', '   ', 'x'.repeat(257)],
    })
    expect(res).toEqual({ type: 'run:settled', statuses: ['complete', 'error'] })
  })

  it('normalizes the metadata dimension via the shared metadata filter', () => {
    const res = normalizeGenericEventFilter({
      type: 'pr:operation',
      metadata: {
        combinator: 'OR',
        conditions: [
          { key: 'operation', value: 'create' },
          { key: 'operation', value: 'merge' },
          { key: '', value: 'bad' },
        ],
      },
    })
    expect(res).toEqual({
      type: 'pr:operation',
      metadata: {
        combinator: 'OR',
        conditions: [
          { key: 'operation', value: 'create' },
          { key: 'operation', value: 'merge' },
        ],
      },
    })
  })
})

describe('normalizeGenericEventFilter — save-boundary hygiene', () => {
  it('requires a non-empty type; a missing/blank type yields null (never "match all")', () => {
    expect(normalizeGenericEventFilter(null)).toBeNull()
    expect(normalizeGenericEventFilter({})).toBeNull()
    expect(normalizeGenericEventFilter({ type: '' })).toBeNull()
    expect(normalizeGenericEventFilter({ type: '   ' })).toBeNull()
    expect(normalizeGenericEventFilter({ statuses: ['a'] })).toBeNull()
  })

  it('trims the type and rejects an over-long one', () => {
    expect(normalizeGenericEventFilter({ type: '  pr:operation  ' })).toEqual({
      type: 'pr:operation',
    })
    expect(normalizeGenericEventFilter({ type: 'x'.repeat(65) })).toBeNull()
  })

  it('trims, dedupes, and drops empty/over-long statuses; empties → undefined (any)', () => {
    expect(
      normalizeGenericEventFilter({
        type: 'run:settled',
        statuses: [' complete ', 'complete', '', '   ', 'error'],
      }),
    ).toEqual({ type: 'run:settled', statuses: ['complete', 'error'] })
    expect(normalizeGenericEventFilter({ type: 't', statuses: ['', '   '] })).toEqual({ type: 't' })
    expect(normalizeGenericEventFilter({ type: 't', statuses: 'nope' })).toEqual({ type: 't' })
  })

  it('folds a valid metadata filter and drops an empty one', () => {
    expect(
      normalizeGenericEventFilter({
        type: 'pr:operation',
        metadata: { conditions: [{ key: 'operation', value: 'merge' }], combinator: 'OR' },
      }),
    ).toEqual({
      type: 'pr:operation',
      metadata: { conditions: [{ key: 'operation', value: 'merge' }], combinator: 'OR' },
    })
    expect(
      normalizeGenericEventFilter({ type: 't', metadata: { conditions: [], combinator: 'AND' } }),
    ).toEqual({ type: 't' })
  })
})
