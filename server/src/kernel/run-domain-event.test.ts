/**
 * Run domain event — sealed-union contract test (server refactor 3/3e-4).
 *
 * The run launcher fires a sealed-union typed event stream (`RunDomainEvent`)
 * with a single `onEvent` callback. This test pins the *shape* of the union:
 * - each event is discriminated by `kind`
 * - a switch over `event.kind` is exhaustive (compile-time)
 * - the `bound` event carries the prev/real id pair
 * - the `settled` event carries the workspace path
 *
 * If a future event is added without extending the test, the exhaustive switch
 * assertion at the bottom fails typecheck — that is the point: the contract is
 * locked in the test file, not the implementation.
 */
import { describe, it, expect } from 'vitest'
import type { RunDomainEvent } from './types.js'

function assertExhaustive(_x: never): never {
  throw new Error('unreachable: non-exhaustive RunDomainEvent switch')
}

describe('RunDomainEvent sealed union', () => {
  it('"bound" carries prevId + realId', () => {
    const e: RunDomainEvent = { kind: 'bound', prevId: 'pending-1', realId: 'real-2' }
    expect(e.kind).toBe('bound')
    if (e.kind !== 'bound') return
    expect(e.prevId).toBe('pending-1')
    expect(e.realId).toBe('real-2')
  })

  it('"settled" carries workspacePath', () => {
    const e: RunDomainEvent = { kind: 'settled', workspacePath: '/tmp/proj' }
    expect(e.kind).toBe('settled')
    if (e.kind !== 'settled') return
    expect(e.workspacePath).toBe('/tmp/proj')
  })

  it('exhaustive switch is type-correct (a new event would fail compile)', () => {
    // This switch is exhaustive at the time of writing; if a third event is
    // added to the union WITHOUT updating this test, the `assertExhaustive`
    // call below would fail typecheck (`event` would not be `never`).
    const classify = (e: RunDomainEvent): string => {
      switch (e.kind) {
        case 'bound':
          return `bind ${e.prevId}->${e.realId}`
        case 'settled':
          return `settle ${e.workspacePath}`
        default:
          return assertExhaustive(e)
      }
    }
    expect(classify({ kind: 'bound', prevId: 'p', realId: 'r' })).toBe('bind p->r')
    expect(classify({ kind: 'settled', workspacePath: '/a' })).toBe('settle /a')
  })
})
