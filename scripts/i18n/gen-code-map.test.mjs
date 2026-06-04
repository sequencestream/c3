import { describe, it, expect } from 'vitest'
import { buildCodeMap } from './gen-code-map.mjs'

describe('buildCodeMap', () => {
  it('projects code -> { key, params? } sorted by code (deterministic)', () => {
    const map = buildCodeMap({
      'session.listFailed': { key: 'error.session.listFailed', params: ['detail'] },
      'requirement.notFound': { key: 'error.requirement.notFound' },
    })
    expect(Object.keys(map)).toEqual(['requirement.notFound', 'session.listFailed'])
    expect(map['requirement.notFound']).toEqual({ key: 'error.requirement.notFound' })
    expect(map['session.listFailed']).toEqual({
      key: 'error.session.listFailed',
      params: ['detail'],
    })
  })
  it('omits params when absent', () => {
    const map = buildCodeMap({ 'a.b': { key: 'error.a.b' } })
    expect(map['a.b']).toEqual({ key: 'error.a.b' })
    expect('params' in map['a.b']).toBe(false)
  })
})
