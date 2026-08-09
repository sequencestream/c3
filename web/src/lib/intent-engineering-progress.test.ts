import { describe, expect, it } from 'vitest'
import { fakeIntentPrs } from '@/lib/intent-pr-fixture'
import type { IntentStatus } from '@ccc/shared/protocol'
import { deriveIntentEngineeringProgress } from './intent-engineering-progress'

function derive(
  overrides: Partial<Parameters<typeof deriveIntentEngineeringProgress>[0]> = {},
  sddEnabled = true,
  branchMode?: 'worktree' | 'current-branch',
) {
  return deriveIntentEngineeringProgress(
    {
      status: 'todo',
      specPath: null,
      specStatus: 'raw',
      specSessionId: null,
      lastWorkSessionId: null,
      prs: [],
      ...overrides,
    },
    sddEnabled,
    branchMode,
  )
}

describe('deriveIntentEngineeringProgress', () => {
  it('returns three stages with SDD enabled and two with SDD disabled', () => {
    expect(derive().map(({ stage }) => stage)).toEqual(['intent', 'spec', 'work'])
    expect(
      derive({ specPath: 'historical.md', specSessionId: 'historical-session' }, false).map(
        ({ stage }) => stage,
      ),
    ).toEqual(['intent', 'work'])
  })

  it.each([
    ['missing mode', undefined, ['intent', 'spec', 'work']],
    ['current-branch mode', 'current-branch', ['intent', 'spec', 'work']],
    ['worktree mode with SDD', 'worktree', ['intent', 'spec', 'work', 'pr']],
  ] as const)('derives the stage sequence for %s', (_name, branchMode, expected) => {
    expect(derive({}, true, branchMode).map(({ stage }) => stage)).toEqual(expected)
  })

  it('omits the spec stage for a fast intent that has no spec data yet', () => {
    expect(derive({ effectiveSpecMode: 'fast' }).map(({ stage }) => stage)).toEqual([
      'intent',
      'work',
    ])
    // 反向生成的规范落地后又有真实的批准步骤可看,规范段回来。
    expect(
      derive({ effectiveSpecMode: 'fast', specPath: 'reverse.md', specStatus: 'pending' }).map(
        ({ stage, state }) => [stage, state],
      ),
    ).toEqual([
      ['intent', 'completed'],
      ['spec', 'in_progress'],
      ['work', 'not_started'],
    ])
  })

  it('keeps the spec stage for an explicit sdd intent with no spec data', () => {
    expect(derive({ effectiveSpecMode: 'sdd' }).map(({ stage }) => stage)).toEqual([
      'intent',
      'spec',
      'work',
    ])
  })

  it('keeps the PR stage when SDD is disabled in worktree mode', () => {
    expect(derive({}, false, 'worktree').map(({ stage }) => stage)).toEqual([
      'intent',
      'work',
      'pr',
    ])
  })

  it('marks a draft intent in progress and every other intent status completed', () => {
    expect(derive({ status: 'draft' })[0].state).toBe('in_progress')
    for (const status of ['todo', 'in_progress', 'blocked', 'failed', 'done', 'cancelled']) {
      expect(derive({ status: status as IntentStatus })[0].state).toBe('completed')
    }
  })

  it.each([
    ['without spec evidence', {}, 'not_started'],
    ['with only a spec session', { specSessionId: 'spec-session' }, 'in_progress'],
    ['with a raw seeded spec', { specPath: 'spec.md', specStatus: 'raw' }, 'in_progress'],
    ['with an unapproved spec', { specPath: 'spec.md', specStatus: 'pending' }, 'in_progress'],
    ['with an approved spec', { specPath: 'spec.md', specStatus: 'approved' }, 'completed'],
    ['with only an approval flag', { specStatus: 'approved' }, 'not_started'],
  ] as const)('derives the spec stage %s', (_name, overrides, expected) => {
    expect(derive(overrides)[1].state).toBe(expected)
  })

  it.each([
    ['without work evidence', {}, 'not_started'],
    ['with a work session', { lastWorkSessionId: 'work-session' }, 'in_progress'],
    ['with only a PR', { prs: fakeIntentPrs('reviewing') }, 'in_progress'],
    ['when blocked', { status: 'blocked' }, 'in_progress'],
    ['when failed', { status: 'failed' }, 'in_progress'],
    ['when cancelled without evidence', { status: 'cancelled' }, 'not_started'],
    [
      'when cancelled with evidence',
      { status: 'cancelled', lastWorkSessionId: 'work-session' },
      'in_progress',
    ],
    ['when done without evidence', { status: 'done' }, 'completed'],
  ] as const)('derives the work stage %s', (_name, overrides, expected) => {
    expect(derive(overrides).at(-1)?.state).toBe(expected)
  })

  it.each([
    // An unknown / missing persisted status cannot reach here: the store narrows
    // it to `reviewing` on read, so the stage only ever sees the five real ones.
    ['without any PR', {}, 'not_started'],
    ['with an empty PR list', { prs: [] }, 'not_started'],
    ['while reviewing', { prs: fakeIntentPrs('reviewing') }, 'in_progress'],
    ['when merged', { prs: fakeIntentPrs('merged') }, 'completed'],
    ['when rejected', { prs: fakeIntentPrs('rejected') }, 'closed'],
    ['when failed', { prs: fakeIntentPrs('failed') }, 'closed'],
    ['when closed', { prs: fakeIntentPrs('closed') }, 'closed'],
    // Aggregate ladder: one unsettled PR keeps the whole stage in progress.
    [
      'with a merged and a reviewing PR',
      { prs: fakeIntentPrs('merged', 'reviewing') },
      'in_progress',
    ],
    ['with a merged and a closed PR', { prs: fakeIntentPrs('merged', 'closed') }, 'completed'],
  ] as const)('derives the PR stage %s', (_name, overrides, expected) => {
    expect(derive(overrides as Parameters<typeof derive>[0], true, 'worktree').at(-1)?.state).toBe(
      expected,
    )
  })

  it.each([
    [
      'done work with reviewing PR',
      { status: 'done', prs: fakeIntentPrs('reviewing') },
      ['completed', 'in_progress'],
    ],
    [
      'unfinished work with merged PR',
      { status: 'in_progress', prs: fakeIntentPrs('merged') },
      ['in_progress', 'completed'],
    ],
    [
      'done work with closed PR',
      { status: 'done', prs: fakeIntentPrs('closed') },
      ['completed', 'closed'],
    ],
  ] as const)('keeps work and PR independent: %s', (_name, overrides, expected) => {
    expect(
      derive(overrides, false, 'worktree')
        .slice(-2)
        .map(({ state }) => state),
    ).toEqual(expected)
  })
})
