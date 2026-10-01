import { describe, expect, it } from 'vitest'
import {
  emptyWorkspaceActivitySummary,
  sessionPageCountsFromSummary,
  type WorkspaceActivitySummary,
} from './activity.js'

function summary(overrides: Partial<WorkspaceActivitySummary> = {}): WorkspaceActivitySummary {
  return {
    ...emptyWorkspaceActivitySummary(),
    ...overrides,
    activeOwners: {
      ...emptyWorkspaceActivitySummary().activeOwners,
      ...overrides.activeOwners,
    },
    attention: {
      ...emptyWorkspaceActivitySummary().attention,
      ...overrides.attention,
    },
  }
}

describe('sessionPageCountsFromSummary', () => {
  it('aggregates spec authoring and review into the spec tab', () => {
    const mapped = sessionPageCountsFromSummary(
      summary({
        runningSessions: 3,
        runningSessionsByKind: { spec: 1, spec_review: 2, work: 0 },
      }),
      false,
    )
    expect(mapped.counts.spec).toBe(3)
    expect(mapped.counts.spec_review).toBe(0)
    expect(mapped.runningSessionCount).toBe(3)
  })

  it('hides tool from page counts when the display switch is off', () => {
    const mapped = sessionPageCountsFromSummary(
      summary({
        runningSessions: 2,
        runningSessionsByKind: { tool: 1, work: 1 },
      }),
      false,
    )
    expect(mapped.counts.tool).toBe(0)
    expect(mapped.counts.work).toBe(1)
    expect(mapped.runningSessionCount).toBe(2)
  })

  it('maps owner sets onto ownerCounts', () => {
    const mapped = sessionPageCountsFromSummary(
      summary({
        activeOwners: { intents: 2, discussions: 1, automations: 4 },
      }),
      true,
    )
    expect(mapped.ownerCounts).toEqual({ intent: 2, discussion: 1, automation: 4 })
  })
})
