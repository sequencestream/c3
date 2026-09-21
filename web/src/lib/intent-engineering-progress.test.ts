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
      // L5 by default: keeps the review segment out of tests that aren't about it.
      impactLevel: 'L5',
      ...overrides,
    },
    sddEnabled,
    branchMode,
  )
}

describe('deriveIntentEngineeringProgress', () => {
  it.each([
    [[], 'not_started'],
    [fakeIntentPrs('reviewing'), 'not_started'],
    [fakeIntentPrs('merged'), 'completed'],
    [fakeIntentPrs('rejected'), 'closed'],
    [fakeIntentPrs('failed'), 'closed'],
    [fakeIntentPrs('closed'), 'closed'],
    [fakeIntentPrs('merged', 'reviewing'), 'not_started'],
    [fakeIntentPrs('merged', 'failed'), 'closed'],
    [fakeIntentPrs('merged', 'rejected'), 'closed'],
    [fakeIntentPrs('merged', 'closed'), 'completed'],
  ] as const)('derives merge from the aggregate for %j', (prs, expected) => {
    expect(derive({ prs: [...prs] }, true, 'worktree').at(-1)).toEqual({
      stage: 'merge',
      state: expected,
    })
  })

  it.each([null, undefined, 'pending', 'approved', 'rejected'] as const)(
    'completes review after merging regardless of review status %s',
    (reviewStatus) => {
      const progress = derive(
        { impactLevel: 'L3', prs: fakeIntentPrs('merged'), reviewStatus },
        true,
        'worktree',
      )
      expect(progress.filter(({ stage }) => ['pr', 'review', 'merge'].includes(stage))).toEqual([
        { stage: 'pr', state: 'completed' },
        { stage: 'review', state: 'completed' },
        { stage: 'merge', state: 'completed' },
      ])
    },
  )

  it('keeps review in progress while another PR remains under review', () => {
    expect(
      derive(
        { impactLevel: 'L3', prs: fakeIntentPrs('merged', 'reviewing') },
        true,
        'worktree',
      ).find(({ stage }) => stage === 'review')?.state,
    ).toBe('in_progress')
    expect(derive({ impactLevel: 'L3' }, true, 'worktree').map(({ stage }) => stage)).toEqual([
      'intent',
      'spec',
      'work',
      'pr',
      'merge',
    ])
  })

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
    ['worktree mode with SDD', 'worktree', ['intent', 'spec', 'work', 'pr', 'merge']],
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
      'merge',
    ])
  })

  it('marks a draft intent in progress and every other intent status completed', () => {
    expect(derive({ status: 'draft' })[0].state).toBe('in_progress')
    for (const status of [
      'todo',
      'in_progress',
      'reviewing',
      'blocked',
      'failed',
      'done',
      'cancelled',
    ]) {
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
    ['when reviewing', { status: 'reviewing' }, 'completed'],
  ] as const)('derives the work stage %s', (_name, overrides, expected) => {
    expect(derive(overrides).at(-1)?.state).toBe(expected)
  })

  it.each([
    // An unknown / missing persisted status cannot reach here: the store narrows
    // it to `reviewing` on read, so the stage only ever sees the five real ones.
    ['without any PR', {}, 'not_started'],
    ['with an empty PR list', { prs: [] }, 'not_started'],
    ['while reviewing', { prs: fakeIntentPrs('reviewing') }, 'completed'],
    ['when merged', { prs: fakeIntentPrs('merged') }, 'completed'],
    ['when rejected', { prs: fakeIntentPrs('rejected') }, 'completed'],
    ['when failed', { prs: fakeIntentPrs('failed') }, 'completed'],
    ['when closed', { prs: fakeIntentPrs('closed') }, 'completed'],
    [
      'with a merged and a reviewing PR',
      { prs: fakeIntentPrs('merged', 'reviewing') },
      'completed',
    ],
    ['with a merged and a closed PR', { prs: fakeIntentPrs('merged', 'closed') }, 'completed'],
  ] as const)('derives the PR stage %s', (_name, overrides, expected) => {
    expect(
      derive(overrides as Parameters<typeof derive>[0], true, 'worktree').find(
        ({ stage }) => stage === 'pr',
      )?.state,
    ).toBe(expected)
  })

  it.each([
    [
      'done work with reviewing PR',
      { status: 'done', prs: fakeIntentPrs('reviewing') },
      ['completed', 'completed'],
    ],
    [
      'unfinished work with merged PR',
      { status: 'in_progress', prs: fakeIntentPrs('merged') },
      ['in_progress', 'completed'],
    ],
    [
      'done work with closed PR',
      { status: 'done', prs: fakeIntentPrs('closed') },
      ['completed', 'completed'],
    ],
  ] as const)('keeps work and PR independent: %s', (_name, overrides, expected) => {
    expect(
      derive(overrides, false, 'worktree')
        .filter(({ stage }) => stage === 'work' || stage === 'pr')
        .map(({ state }) => state),
    ).toEqual(expected)
  })

  it.each([
    ['L1', 'L1'],
    ['L2', 'L2'],
    ['L3', 'L3'],
    ['L4', 'L4'],
    ['ungraded', null],
  ] as const)('shows the review segment for %s when a PR exists', (_name, impactLevel) => {
    const stages = derive({ impactLevel, prs: fakeIntentPrs('reviewing') }, true, 'worktree').map(
      ({ stage }) => stage,
    )
    expect(stages).toEqual(['intent', 'spec', 'work', 'pr', 'review', 'merge'])
  })

  it('skips the review segment for an L5 intent', () => {
    const stages = derive(
      { impactLevel: 'L5', prs: fakeIntentPrs('reviewing') },
      true,
      'worktree',
    ).map(({ stage }) => stage)
    expect(stages).toEqual(['intent', 'spec', 'work', 'pr', 'merge'])
  })

  it('shows the review segment with a written conclusion even without a PR row', () => {
    const stages = derive({ impactLevel: 'L3', reviewStatus: 'approved' }, true, 'worktree').map(
      ({ stage }) => stage,
    )
    expect(stages).toEqual(['intent', 'spec', 'work', 'pr', 'review', 'merge'])
  })

  it.each([
    ['never reviewed', null, 'in_progress'],
    ['missing review status', undefined, 'in_progress'],
    ['in flight', 'pending', 'in_progress'],
    ['approved', 'approved', 'completed'],
    ['rejected', 'rejected', 'closed'],
  ] as const)('maps the review segment state when %s', (_name, reviewStatus, expected) => {
    const review = derive(
      { impactLevel: 'L3', prs: fakeIntentPrs('reviewing'), reviewStatus },
      true,
      'worktree',
    ).find(({ stage }) => stage === 'review')
    expect(review?.state).toBe(expected)
  })

  it.each([
    ['a bound fix session only', { fixSessionId: 'fix-session' }, 'not_started'],
    ['a pending fix', { fixStatus: 'pending' }, 'in_progress'],
    ['a completed fix', { fixStatus: 'fixed' }, 'completed'],
  ] as const)('derives the fix segment state for %s', (_name, overrides, expected) => {
    const items = derive(overrides as Parameters<typeof derive>[0], true, 'worktree')
    expect(items.map(({ stage }) => stage)).toEqual([
      'intent',
      'spec',
      'work',
      'pr',
      'fix',
      'merge',
    ])
    expect(items.find(({ stage }) => stage === 'fix')?.state).toBe(expected)
  })

  it('omits the fix segment when no fix session and no conclusion exist', () => {
    const stages = derive({}, true, 'worktree').map(({ stage }) => stage)
    expect(stages).toEqual(['intent', 'spec', 'work', 'pr', 'merge'])
  })

  it('orders review and fix after the PR segment', () => {
    const stages = derive(
      {
        impactLevel: 'L3',
        prs: fakeIntentPrs('reviewing'),
        reviewStatus: 'rejected',
        fixStatus: 'fixed',
      },
      true,
      'worktree',
    ).map(({ stage }) => stage)
    expect(stages).toEqual(['intent', 'spec', 'work', 'pr', 'review', 'fix', 'merge'])
  })

  it.each([
    ['missing mode', undefined],
    ['current-branch mode', 'current-branch'],
  ] as const)('omits review and fix outside worktree mode (%s)', (_name, branchMode) => {
    const stages = derive(
      {
        impactLevel: 'L3',
        prs: fakeIntentPrs('reviewing'),
        reviewStatus: 'rejected',
        fixStatus: 'fixed',
      },
      true,
      branchMode,
    ).map(({ stage }) => stage)
    expect(stages).toEqual(['intent', 'spec', 'work'])
  })
})
