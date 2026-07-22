import { describe, expect, it } from 'vitest'
import type { IntentStatus } from '@ccc/shared/protocol'
import { deriveIntentEngineeringProgress } from './intent-engineering-progress'

function derive(
  overrides: Partial<Parameters<typeof deriveIntentEngineeringProgress>[0]> = {},
  sddEnabled = true,
) {
  return deriveIntentEngineeringProgress(
    {
      status: 'todo',
      specPath: null,
      specApproved: false,
      specSessionId: null,
      lastWorkSessionId: null,
      prId: null,
      ...overrides,
    },
    sddEnabled,
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
})
