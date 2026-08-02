import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Intent, SpecLaunchStage } from '@ccc/shared/protocol'
import { resetDbForTests } from '../../kernel/infra/db.js'
import {
  addWorkspace,
  pathToId,
  resetStateCacheForTests,
  resolveWorkspaceRoot,
} from '../../state.js'
import { resetSettingsCacheForTests, saveWorkspaceSetting } from '../../kernel/config/index.js'
import {
  getIntent,
  insertIntents,
  resetStoreForTests,
  setBranchName,
  updateIntentDeps,
  updateStatus,
} from './store.js'
import { findDependencyBlockingMainline, prepareSpecLaunch } from './dependency-gate.js'
import { syncUnconfirmedDependencyPrsInBackground } from './pr-status-sync.js'
import { pullCurrentBranch } from './worktree.js'

// The gate's two side effects are the whole point of the tests below: the
// fire-and-forget PR refresh on a block, and the best-effort pull on a pass.
// Both are stubbed so the assertions are about ORDER and OCCURRENCE, not about
// reaching a real forge or a real git remote.
vi.mock('./pr-status-sync.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./pr-status-sync.js')>()),
  syncUnconfirmedDependencyPrsInBackground: vi.fn(),
}))
vi.mock('./worktree.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./worktree.js')>()),
  pullCurrentBranch: vi.fn(() => ({ ok: true, skipped: false })),
}))

const syncMock = vi.mocked(syncUnconfirmedDependencyPrsInBackground)
const pullMock = vi.mocked(pullCurrentBranch)

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
    specReviewSessionId: null,
    specReviewVerdict: null,
    specReviewReason: null,
    specReviewAt: null,
    specReviewFingerprint: null,
    specReviewReworkRounds: 0,
    specReviewMachineApprovalBlocked: false,
    intentSessionId: null,
    sessionActive: false,
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

/**
 * The ONE spec-launch precondition, tested without any transport in sight — the
 * reason it was pulled out of the WS handler and the launch service in the first
 * place. Both entry points now translate exactly this outcome, so a rule proven
 * here holds for the manual and the unattended path alike.
 */
describe('prepareSpecLaunch', () => {
  let dir: string
  let proj: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'c3-spec-launch-gate-'))
    process.env.CLAUDE_CONFIG_DIR = dir
    process.env.C3_DB_PATH = join(dir, 'c3.db')
    process.env.C3_DIR = join(dir, 'c3home')
    resetDbForTests()
    resetStoreForTests()
    resetStateCacheForTests()
    resetSettingsCacheForTests()
    addWorkspace(dir, 1)
    proj = resolveWorkspaceRoot(pathToId(dir)!)!
    syncMock.mockClear()
    pullMock.mockClear()
    pullMock.mockReturnValue({ ok: true, skipped: false })
  })

  afterEach(() => {
    resetDbForTests()
    resetStateCacheForTests()
    resetSettingsCacheForTests()
    delete process.env.CLAUDE_CONFIG_DIR
    delete process.env.C3_DB_PATH
    delete process.env.C3_DIR
    rmSync(dir, { recursive: true, force: true })
  })

  /**
   * The canonical blocking fact: the dependency is DONE, but its feature branch
   * has no merged PR — exactly the case an unattended launch must not admit.
   */
  function seedUnmergedDependency(): { dependency: Intent; target: Intent } {
    const [dependency, target] = insertIntents(proj, [
      { title: 'Dependency', shortEnTitle: 'dep', content: '', priority: 'P1' },
      { title: 'Target', shortEnTitle: 'target', content: '', priority: 'P1' },
    ])
    updateIntentDeps(target.id, [{ dependsOnId: dependency.id, depType: 'blocks' }])
    updateStatus(dependency.id, 'done', 'test')
    setBranchName(dependency.id, 'feature/dep')
    return { dependency: getIntent(dependency.id)!, target: getIntent(target.id)! }
  }

  function run(intent: Intent): { result: ReturnType<typeof prepareSpecLaunch>; stages: string[] } {
    const stages: SpecLaunchStage[] = []
    const result = prepareSpecLaunch({
      workspacePath: proj,
      intent,
      broadcastIntents: vi.fn(),
      progress: (stage) => stages.push(stage),
    })
    return { result, stages }
  }

  it('blocks an unmerged dependency in worktree mode, refreshing PR status without pulling', () => {
    saveWorkspaceSetting(proj, { gitBranchMode: 'worktree', defaultMainBranch: 'main' })
    const { dependency, target } = seedUnmergedDependency()

    const { result, stages } = run(target)

    expect(result).toEqual({
      blocked: true,
      dependency: { id: dependency.id, title: dependency.title },
    })
    // Fire-and-forget refresh: a stale `reviewing` row is the usual false block.
    expect(syncMock).toHaveBeenCalledTimes(1)
    expect(syncMock.mock.calls[0][0]).toMatchObject({
      workspacePath: proj,
      dependsOn: [dependency.id],
    })
    // A refusal must not touch the checkout or report launch progress.
    expect(pullMock).not.toHaveBeenCalled()
    expect(stages).toEqual([])
  })

  it('passes an unblocked worktree intent, pulling between the two progress stages', () => {
    saveWorkspaceSetting(proj, { gitBranchMode: 'worktree', defaultMainBranch: 'main' })
    const [target] = insertIntents(proj, [
      { title: 'Target', shortEnTitle: 'target', content: '', priority: 'P1' },
    ])
    const order: string[] = []
    pullMock.mockImplementation(() => {
      order.push('pull')
      return { ok: true, skipped: false }
    })

    const stages: SpecLaunchStage[] = []
    const result = prepareSpecLaunch({
      workspacePath: proj,
      intent: getIntent(target.id)!,
      broadcastIntents: vi.fn(),
      progress: (stage) => {
        order.push(stage)
        stages.push(stage)
      },
    })

    expect(result).toEqual({ blocked: false })
    expect(syncMock).not.toHaveBeenCalled()
    expect(stages).toEqual(['pulling-code', 'launching'])
    expect(order).toEqual(['pulling-code', 'pull', 'launching'])
  })

  it('skips the dependency check outside worktree mode but still pulls and reports both stages', () => {
    saveWorkspaceSetting(proj, { gitBranchMode: 'current-branch', defaultMainBranch: 'main' })
    const { target } = seedUnmergedDependency()

    const { result, stages } = run(target)

    expect(result).toEqual({ blocked: false })
    expect(syncMock).not.toHaveBeenCalled()
    expect(pullMock).toHaveBeenCalledWith(proj)
    expect(stages).toEqual(['pulling-code', 'launching'])
  })

  it('treats a failed pull as a warning, not a refusal', () => {
    saveWorkspaceSetting(proj, { gitBranchMode: 'worktree', defaultMainBranch: 'main' })
    const [target] = insertIntents(proj, [
      { title: 'Target', shortEnTitle: 'target', content: '', priority: 'P1' },
    ])
    pullMock.mockReturnValue({ ok: false, skipped: false, message: 'diverged' })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const { result, stages } = run(getIntent(target.id)!)

    expect(result).toEqual({ blocked: false })
    expect(stages).toEqual(['pulling-code', 'launching'])
    warn.mockRestore()
  })

  it('runs without a progress callback (the MCP / queue entry supplies none)', () => {
    saveWorkspaceSetting(proj, { gitBranchMode: 'worktree', defaultMainBranch: 'main' })
    const [target] = insertIntents(proj, [
      { title: 'Target', shortEnTitle: 'target', content: '', priority: 'P1' },
    ])

    const result = prepareSpecLaunch({
      workspacePath: proj,
      intent: getIntent(target.id)!,
      broadcastIntents: vi.fn(),
    })

    expect(result).toEqual({ blocked: false })
    expect(pullMock).toHaveBeenCalledTimes(1)
  })
})
