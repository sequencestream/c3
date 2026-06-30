import { describe, expect, it } from 'vitest'
import type { Intent } from '@ccc/shared/protocol'
import { findDependencyBlockingMainline } from './dependency-gate.js'

function dep(overrides: Partial<Intent> = {}): Intent {
  return {
    id: 'dep',
    workspaceId: 'w',
    title: 'Dependency',
    shortEnTitle: null,
    content: '',
    priority: 'P1',
    module: '',
    status: 'done',
    dependsOn: [],
    dependsOnTypes: {},
    lastWorkSessionId: null,
    automate: false,
    createdAt: 0,
    updatedAt: 0,
    completedAt: null,
    runStatus: 'idle',
    branchName: 'feature/dep',
    latestCommitHash: null,
    prId: null,
    prUrl: null,
    prStatus: null,
    specPath: null,
    specApproved: false,
    specApproveUser: null,
    specSessionId: null,
    intentSessionId: null,
    ...overrides,
  }
}

describe('findDependencyBlockingMainline', () => {
  it('covers missing, unfinished, merged, branchless, mainline, and unmerged feature dependencies', () => {
    expect(findDependencyBlockingMainline(['missing'], [], 'main')).toBeUndefined()
    expect(findDependencyBlockingMainline(['dep'], [dep({ status: 'todo' })], 'main')?.id).toBe(
      'dep',
    )
    expect(
      findDependencyBlockingMainline(['dep'], [dep({ prStatus: 'merged' })], 'main'),
    ).toBeUndefined()
    expect(
      findDependencyBlockingMainline(['dep'], [dep({ branchName: null })], 'main'),
    ).toBeUndefined()
    expect(
      findDependencyBlockingMainline(['dep'], [dep({ branchName: 'origin/main' })], 'main'),
    ).toBeUndefined()
    expect(findDependencyBlockingMainline(['dep'], [dep()], 'main')?.id).toBe('dep')
  })
})
