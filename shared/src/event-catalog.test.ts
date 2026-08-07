/**
 * The catalog is the ONE code source the automation form's cascade and the docs
 * read known categories/actions off. These tests pin the parts that are derived
 * from a wire value list (so a new PR operation / intent phase can never drift)
 * and the delivery family, whose actions are the publish points a subscriber is
 * offered — an action dropped here silently disappears from the picker.
 */
import { describe, expect, it } from 'vitest'
import { EVENT_CATALOG } from './event-catalog.js'
import { INTENT_LIFECYCLE_PHASES, PR_OPERATIONS, PR_OPERATION_RESULTS } from './event-model.js'

describe('EVENT_CATALOG', () => {
  it('derives the pr category from the wire operation + result lists', () => {
    expect(Object.keys(EVENT_CATALOG.pr.actions)).toEqual([...PR_OPERATIONS])
    for (const op of PR_OPERATIONS) {
      expect(EVENT_CATALOG.pr.actions[op].statuses).toEqual([...PR_OPERATION_RESULTS])
    }
  })

  it('derives the intent category from the lifecycle phases, plus spec_approve', () => {
    expect(Object.keys(EVENT_CATALOG.intent.actions)).toEqual([
      ...INTENT_LIFECYCLE_PHASES,
      'spec_approve',
    ])
  })

  it('lists the six delivery lifecycle actions', () => {
    expect(Object.keys(EVENT_CATALOG.delivery.actions)).toEqual([
      'created',
      'status_changed',
      'branch_ready',
      'pr_created',
      'delivered',
      'cancelled',
    ])
  })

  it('gives the delivery actions no status dimension — the fact is the action itself', () => {
    for (const action of Object.values(EVENT_CATALOG.delivery.actions)) {
      expect(action.statuses).toEqual([])
    }
  })
})
