/**
 * Manual Start-Dev session-end Git/PR cleanup tests (MSC-R2…R6).
 *
 * The cleanup is fully dependency-injected, so every branch-mode / success /
 * skip / failure path is exercised with mocks — no real git tree, db, or wire.
 */
import { describe, expect, it, vi } from 'vitest'
import type { Intent } from '@ccc/shared/protocol'
import { runManualDevCleanup, type DevCleanupDeps } from './dev-cleanup.js'

const WS = '/abs/ws'

function makeIntent(over: Partial<Intent> = {}): Intent {
  return {
    id: 'I1',
    workspaceId: 'ws-id',
    title: 'Add feature',
    shortEnTitle: 'add-feature',
    content: 'do the thing',
    priority: 'P1',
    module: '',
    status: 'in_progress',
    dependsOn: [],
    dependsOnTypes: {},
    lastDevSessionId: 'sess-1',
    automate: false,
    createdAt: 1,
    updatedAt: 1,
    completedAt: null,
    runStatus: 'idle',
    branchName: 'intent/i1-add-feature',
    latestCommitHash: null,
    prId: null,
    prUrl: null,
    prStatus: null,
    specPath: null,
    specApproved: false,
    specApproveUser: null,
    specSessionId: null,
    intentSessionId: null,
    ...over,
  }
}

interface Harness {
  deps: DevCleanupDeps
  intent: Intent
  mocks: {
    hasCommittableChanges: ReturnType<typeof vi.fn>
    commitAndPush: ReturnType<typeof vi.fn>
    createGhPr: ReturnType<typeof vi.fn>
    getCurrentBranch: ReturnType<typeof vi.fn>
    getHeadCommit: ReturnType<typeof vi.fn>
    setBranchName: ReturnType<typeof vi.fn>
    setLatestCommitHash: ReturnType<typeof vi.fn>
    setPrInfo: ReturnType<typeof vi.fn>
    cancelEventsForIntent: ReturnType<typeof vi.fn>
    pushFailureEvent: ReturnType<typeof vi.fn>
    broadcastIntents: ReturnType<typeof vi.fn>
    broadcastWaitUserEvents: ReturnType<typeof vi.fn>
  }
}

function harness(
  opts: {
    mode?: 'worktree' | 'current-branch'
    mainBranch?: string
    currentBranch?: string
    intent?: Intent
  } = {},
): Harness {
  const intent = opts.intent ?? makeIntent()
  const mocks = {
    hasCommittableChanges: vi.fn().mockResolvedValue(true),
    commitAndPush: vi.fn().mockResolvedValue({ ok: true, committed: true }),
    createGhPr: vi.fn().mockResolvedValue({ ok: true, prId: '42', prUrl: 'https://h/pull/42' }),
    getCurrentBranch: vi.fn().mockResolvedValue(opts.currentBranch ?? 'intent/i1-add-feature'),
    getHeadCommit: vi.fn().mockResolvedValue('deadbeef'),
    setBranchName: vi.fn(),
    setLatestCommitHash: vi.fn(),
    setPrInfo: vi.fn(),
    cancelEventsForIntent: vi.fn(),
    pushFailureEvent: vi.fn(),
    broadcastIntents: vi.fn(),
    broadcastWaitUserEvents: vi.fn(),
  }
  const deps: DevCleanupDeps = {
    getGitBranchMode: () => opts.mode ?? 'worktree',
    getDefaultMainBranch: () => opts.mainBranch ?? 'main',
    gitCwd: () => '/abs/cwd',
    hasCommittableChanges: mocks.hasCommittableChanges,
    getCurrentBranch: mocks.getCurrentBranch,
    getHeadCommit: mocks.getHeadCommit,
    commitAndPush: mocks.commitAndPush,
    createGhPr: mocks.createGhPr,
    getIntent: () => intent,
    setBranchName: mocks.setBranchName,
    setLatestCommitHash: mocks.setLatestCommitHash,
    setPrInfo: mocks.setPrInfo,
    cancelEventsForIntent: mocks.cancelEventsForIntent,
    pushFailureEvent: mocks.pushFailureEvent,
    broadcastIntents: mocks.broadcastIntents,
    broadcastWaitUserEvents: mocks.broadcastWaitUserEvents,
  }
  return { deps, intent, mocks }
}

describe('runManualDevCleanup', () => {
  // ── MSC-R2: worktree happy path ──
  it('worktree with changes: commits, pushes, opens PR, writes back all fields', async () => {
    const h = harness({ mode: 'worktree' })
    const out = await runManualDevCleanup('I1', WS, h.deps)

    expect(out).toEqual({ kind: 'success', createdPr: true })
    expect(h.mocks.commitAndPush).toHaveBeenCalledWith('/abs/cwd', 'feat: Add feature')
    expect(h.mocks.setBranchName).toHaveBeenCalledWith('I1', 'intent/i1-add-feature')
    expect(h.mocks.setLatestCommitHash).toHaveBeenCalledWith('I1', 'deadbeef')
    expect(h.mocks.setPrInfo).toHaveBeenCalledWith('I1', '42', 'reviewing', 'https://h/pull/42')
    expect(h.mocks.pushFailureEvent).not.toHaveBeenCalled()
  })

  // ── MSC-R3: current-branch, not on main → same cleanup ──
  it('current-branch off main: runs the same commit/push/PR cleanup', async () => {
    const h = harness({ mode: 'current-branch', mainBranch: 'main', currentBranch: 'feature/x' })
    const out = await runManualDevCleanup('I1', WS, h.deps)

    expect(out).toEqual({ kind: 'success', createdPr: true })
    expect(h.mocks.commitAndPush).toHaveBeenCalled()
    expect(h.mocks.createGhPr).toHaveBeenCalled()
  })

  // ── MSC-R3: current-branch on the main branch → success skip, no actions ──
  it('current-branch on main: skips cleanup with no commit/push/PR and no failure event', async () => {
    const h = harness({ mode: 'current-branch', mainBranch: 'main', currentBranch: 'origin/main' })
    const out = await runManualDevCleanup('I1', WS, h.deps)

    expect(out).toEqual({ kind: 'skipped' })
    expect(h.mocks.commitAndPush).not.toHaveBeenCalled()
    expect(h.mocks.createGhPr).not.toHaveBeenCalled()
    expect(h.mocks.setPrInfo).not.toHaveBeenCalled()
    expect(h.mocks.pushFailureEvent).not.toHaveBeenCalled()
  })

  // ── MSC-R4 ①: no changes → explicit failure, not a silent skip ──
  it('no committable changes: fails with a workbench todo, no PR fields written', async () => {
    const h = harness({ mode: 'worktree' })
    h.mocks.hasCommittableChanges.mockResolvedValue(false)
    const out = await runManualDevCleanup('I1', WS, h.deps)

    expect(out).toEqual({ kind: 'failed', code: 'noChanges', detail: undefined })
    expect(h.mocks.pushFailureEvent).toHaveBeenCalledWith(
      expect.objectContaining({ intentId: 'I1', code: 'intent.gitCleanupNoChanges' }),
    )
    expect(h.mocks.commitAndPush).not.toHaveBeenCalled()
    expect(h.mocks.setPrInfo).not.toHaveBeenCalled()
  })

  // ── MSC-R4 ②: commit/push failure ──
  it('commit/push failure: fails, does not create a PR or set reviewing', async () => {
    const h = harness({ mode: 'worktree' })
    h.mocks.commitAndPush.mockResolvedValue({ ok: false, committed: false, error: 'push rejected' })
    const out = await runManualDevCleanup('I1', WS, h.deps)

    expect(out).toEqual({ kind: 'failed', code: 'commitPushFailed', detail: 'push rejected' })
    expect(h.mocks.pushFailureEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'intent.gitCleanupCommitPushFailed',
        params: { detail: 'push rejected' },
      }),
    )
    expect(h.mocks.createGhPr).not.toHaveBeenCalled()
    expect(h.mocks.setPrInfo).not.toHaveBeenCalled()
    expect(h.mocks.setLatestCommitHash).not.toHaveBeenCalled()
  })

  // ── MSC-R4 ③: gh unavailable / not logged in ──
  it('gh unavailable: fails with ghUnavailable; honest partial keeps the pushed commit hash', async () => {
    const h = harness({ mode: 'worktree' })
    h.mocks.createGhPr.mockResolvedValue({ ok: false, unavailable: true, error: 'gh CLI 未安装' })
    const out = await runManualDevCleanup('I1', WS, h.deps)

    expect(out).toEqual({ kind: 'failed', code: 'ghUnavailable', detail: 'gh CLI 未安装' })
    expect(h.mocks.pushFailureEvent).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'intent.gitCleanupGhUnavailable' }),
    )
    // Commit + push succeeded → honest write-back of hash; PR fields stay empty.
    expect(h.mocks.setLatestCommitHash).toHaveBeenCalledWith('I1', 'deadbeef')
    expect(h.mocks.setPrInfo).not.toHaveBeenCalled()
  })

  // ── MSC-R4 ④: PR create failure (gh present) ──
  it('PR creation failure: fails with prFailed; commit hash recorded, PR fields empty', async () => {
    const h = harness({ mode: 'worktree' })
    h.mocks.createGhPr.mockResolvedValue({ ok: false, error: 'base branch not found' })
    const out = await runManualDevCleanup('I1', WS, h.deps)

    expect(out).toEqual({ kind: 'failed', code: 'prFailed', detail: 'base branch not found' })
    expect(h.mocks.pushFailureEvent).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'intent.gitCleanupPrFailed' }),
    )
    expect(h.mocks.setLatestCommitHash).toHaveBeenCalledWith('I1', 'deadbeef')
    expect(h.mocks.setPrInfo).not.toHaveBeenCalled()
  })

  // ── MSC-R6: idempotent re-cleanup when a PR already exists ──
  it('existing PR with new changes: commits/pushes and refreshes hash, does NOT re-create the PR', async () => {
    const h = harness({
      mode: 'worktree',
      intent: makeIntent({ prId: '7', prUrl: 'https://h/pull/7', prStatus: 'reviewing' }),
    })
    const out = await runManualDevCleanup('I1', WS, h.deps)

    expect(out).toEqual({ kind: 'success', createdPr: false })
    expect(h.mocks.commitAndPush).toHaveBeenCalled()
    expect(h.mocks.setLatestCommitHash).toHaveBeenCalledWith('I1', 'deadbeef')
    expect(h.mocks.createGhPr).not.toHaveBeenCalled()
    expect(h.mocks.setPrInfo).not.toHaveBeenCalled()
  })

  // Clears stale cleanup todos before each real attempt (self-heal on re-run).
  it('cancels prior cleanup todos for the intent before re-attempting', async () => {
    const h = harness({ mode: 'worktree' })
    await runManualDevCleanup('I1', WS, h.deps)
    expect(h.mocks.cancelEventsForIntent).toHaveBeenCalledWith('I1')
  })
})
