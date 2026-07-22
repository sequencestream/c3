import { describe, expect, it } from 'vitest'
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
      specApproved: false,
      specSessionId: null,
      lastWorkSessionId: null,
      prId: null,
      prStatus: null,
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
    ['with an unapproved spec', { specPath: 'spec.md' }, 'in_progress'],
    ['with an approved spec', { specPath: 'spec.md', specApproved: true }, 'completed'],
    ['with only an approval flag', { specApproved: true }, 'not_started'],
  ] as const)('derives the spec stage %s', (_name, overrides, expected) => {
    expect(derive(overrides)[1].state).toBe(expected)
  })

  it.each([
    ['without work evidence', {}, 'not_started'],
    ['with a work session', { lastWorkSessionId: 'work-session' }, 'in_progress'],
    ['with only a PR', { prId: '42' }, 'in_progress'],
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
    ['without a PR id', {}, 'not_started'],
    ['without a PR id but with stale status', { prStatus: 'merged' }, 'not_started'],
    ['while reviewing', { prId: '42', prStatus: 'reviewing' }, 'in_progress'],
    ['without a status', { prId: '42', prStatus: null }, 'in_progress'],
    ['with an unknown future status', { prId: '42', prStatus: 'queued' }, 'in_progress'],
    ['when merged', { prId: '42', prStatus: 'merged' }, 'completed'],
    ['when rejected', { prId: '42', prStatus: 'rejected' }, 'closed'],
    ['when failed', { prId: '42', prStatus: 'failed' }, 'closed'],
    ['when closed', { prId: '42', prStatus: 'closed' }, 'closed'],
  ] as const)('derives the PR stage %s', (_name, overrides, expected) => {
    expect(derive(overrides as Parameters<typeof derive>[0], true, 'worktree').at(-1)?.state).toBe(
      expected,
    )
  })

  it.each([
    [
      'done work with reviewing PR',
      { status: 'done', prId: '42', prStatus: 'reviewing' },
      ['completed', 'in_progress'],
    ],
    [
      'unfinished work with merged PR',
      { status: 'in_progress', prId: '42', prStatus: 'merged' },
      ['in_progress', 'completed'],
    ],
    [
      'done work with closed PR',
      { status: 'done', prId: '42', prStatus: 'closed' },
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
