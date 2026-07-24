/**
 * Tests for the intent reconcile logic. The reconcile is dependency-injected,
 * so every branch is tested with direct mock deps — no real judge, git, store, or
 * disk access.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Intent } from '@ccc/shared/protocol'
import type { ReconcileDeps } from './reconcile.js'

const { reconcileInProgress } = await import('./reconcile.js')

const PROJECT = '/abs/test-proj'
const SIGNAL = new AbortController().signal

// Shared base intent (in_progress) reused across tests; tests extend it.
function makeReq(overrides: Partial<Intent> = {}): Intent {
  return {
    id: 'r-default',
    workspaceId: 'abs-test-proj',
    title: '测试需求',
    shortEnTitle: null,
    content: '实现某个功能',
    priority: 'P0',
    module: '',
    status: 'in_progress',
    dependsOn: [],
    lastWorkSessionId: 'sess-abc',
    automate: false,
    branchName: null,
    latestCommitHash: null,
    prId: null,
    prUrl: null,
    prStatus: null,
    specPath: null,
    specApproved: false,
    specApproveUser: null,
    specSessionId: null,
    intentSessionId: null,
    createdAt: 1000,
    updatedAt: 2000,
    completedAt: null,
    runStatus: 'idle',
    sessionActive: false,
    ...overrides,
  }
}

// Default mock deps — each test overrides the ones it needs.
function mockDeps(overrides: Partial<ReconcileDeps> = {}): ReconcileDeps {
  return {
    isRunning: () => false,
    getGitBranchMode: () => 'current-branch',
    getWorktreePath: (_workspacePath, intentId) => `/abs/worktrees/intent-${intentId}`,
    loadTranscriptMessages: async () => [],
    judgeCompletion: async () => ({ verdict: 'in_progress', reason: '默认' }),
    commitAndPush: async () => ({ ok: true, committed: false }),
    updateStatus: () => {},
    ...overrides,
  }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('reconcileInProgress', () => {
  describe('branch 1 — process still running', () => {
    it('returns running for a intent whose work session is in-flight', async () => {
      const req = makeReq({ lastWorkSessionId: 'sess-live' })
      const deps = mockDeps({ isRunning: (id) => id === 'sess-live' })

      const results = await reconcileInProgress([req], PROJECT, deps, SIGNAL)

      expect(results).toHaveLength(1)
      expect(results[0]).toEqual({
        intentId: req.id,
        runStatus: 'running',
        autoCompleted: false,
      })
    })

    it('returns running when lastWorkSessionId is set and isRunning returns true, ignoring transcript/judge', async () => {
      const req = makeReq({ lastWorkSessionId: 'sess-live' })
      const judgeSpy = vi.fn()
      const loadSpy = vi.fn()
      const deps = mockDeps({
        isRunning: () => true, // all sessions "running" → all skip
        loadTranscriptMessages: loadSpy,
        judgeCompletion: judgeSpy,
      })

      const results = await reconcileInProgress([req], PROJECT, deps, SIGNAL)

      expect(results).toHaveLength(1)
      expect(results[0].runStatus).toBe('running')
      expect(loadSpy).not.toHaveBeenCalled()
      expect(judgeSpy).not.toHaveBeenCalled()
    })
  })

  describe('branch 2 — process dead, judge says done (auto-complete)', () => {
    it('commits, pushes, and marks done when judge returns done', async () => {
      const req = makeReq({ lastWorkSessionId: 'sess-dead', title: '自动完成测试' })
      const commitSpy = vi.fn().mockResolvedValue({ ok: true, committed: true })
      const updateSpy = vi.fn()

      const deps = mockDeps({
        isRunning: () => false,
        loadTranscriptMessages: async () => ['已完成所有任务', '验证通过'],
        judgeCompletion: async () => ({ verdict: 'done', reason: '实现完整' }),
        commitAndPush: commitSpy,
        updateStatus: updateSpy,
      })

      const results = await reconcileInProgress([req], PROJECT, deps, SIGNAL)

      expect(results).toHaveLength(1)
      expect(results[0]).toEqual({
        intentId: req.id,
        runStatus: 'idle',
        autoCompleted: true,
      })
      // commitAndPush was called
      expect(commitSpy).toHaveBeenCalledTimes(1)
      expect(commitSpy).toHaveBeenCalledWith(PROJECT, 'feat: 自动完成测试')
      // updateStatus was called with done
      expect(updateSpy).toHaveBeenCalledTimes(1)
      expect(updateSpy).toHaveBeenCalledWith(req.id, 'done')
    })

    it('uses the intent worktree for transcript, judge, and commit when the process is dead', async () => {
      const req = makeReq({ id: 'worktree-intent', lastWorkSessionId: 'sess-dead' })
      const worktreePath = '/abs/worktrees/intent-worktree-intent'
      const loadSpy = vi.fn().mockResolvedValue(['已完成所有任务'])
      const judgeSpy = vi.fn().mockResolvedValue({ verdict: 'done', reason: '实现完整' })
      const commitSpy = vi.fn().mockResolvedValue({ ok: true, committed: true })
      const updateSpy = vi.fn()

      const results = await reconcileInProgress(
        [req],
        PROJECT,
        mockDeps({
          getGitBranchMode: vi.fn(() => 'worktree' as const),
          getWorktreePath: vi.fn(() => worktreePath),
          loadTranscriptMessages: loadSpy,
          judgeCompletion: judgeSpy,
          commitAndPush: commitSpy,
          updateStatus: updateSpy,
        }),
        SIGNAL,
      )

      expect(results).toEqual([{ intentId: req.id, runStatus: 'idle', autoCompleted: true }])
      expect(loadSpy).toHaveBeenCalledWith(worktreePath, 'sess-dead', 3)
      expect(judgeSpy).toHaveBeenCalledWith({
        req,
        lastMessages: ['已完成所有任务'],
        evidence: { diffStat: '', recentLog: '' },
        cwd: worktreePath,
        signal: SIGNAL,
      })
      expect(commitSpy).toHaveBeenCalledWith(worktreePath, `feat: ${req.title}`)
      expect(updateSpy).toHaveBeenCalledWith(req.id, 'done')
    })

    it('keeps the workspace root for transcript, judge, and commit in current-branch mode', async () => {
      const req = makeReq({ id: 'current-branch-intent', lastWorkSessionId: 'sess-dead' })
      const loadSpy = vi.fn().mockResolvedValue(['已完成所有任务'])
      const judgeSpy = vi.fn().mockResolvedValue({ verdict: 'done', reason: '实现完整' })
      const commitSpy = vi.fn().mockResolvedValue({ ok: true, committed: true })
      const getWorktreePath = vi.fn()

      await reconcileInProgress(
        [req],
        PROJECT,
        mockDeps({
          getGitBranchMode: vi.fn(() => 'current-branch' as const),
          getWorktreePath,
          loadTranscriptMessages: loadSpy,
          judgeCompletion: judgeSpy,
          commitAndPush: commitSpy,
        }),
        SIGNAL,
      )

      expect(getWorktreePath).not.toHaveBeenCalled()
      expect(loadSpy).toHaveBeenCalledWith(PROJECT, 'sess-dead', 3)
      expect(judgeSpy).toHaveBeenCalledWith(
        expect.objectContaining({ cwd: PROJECT, evidence: { diffStat: '', recentLog: '' } }),
      )
      expect(commitSpy).toHaveBeenCalledWith(PROJECT, `feat: ${req.title}`)
    })

    it('does NOT auto-complete when commit/push fails (keeps dangling)', async () => {
      const req = makeReq({ lastWorkSessionId: 'sess-dead' })
      const commitSpy = vi
        .fn()
        .mockResolvedValue({ ok: false, committed: false, error: 'git push 失败' })
      const updateSpy = vi.fn()

      const deps = mockDeps({
        isRunning: () => false,
        loadTranscriptMessages: async () => ['done'],
        judgeCompletion: async () => ({ verdict: 'done', reason: 'ok' }),
        commitAndPush: commitSpy,
        updateStatus: updateSpy,
      })

      const results = await reconcileInProgress([req], PROJECT, deps, SIGNAL)

      expect(results).toHaveLength(1)
      expect(results[0].runStatus).toBe('dangling')
      expect(results[0].autoCompleted).toBe(false)
      expect(updateSpy).not.toHaveBeenCalled()
    })
  })

  describe('branch 3 — process dead, judge says in_progress (dangling)', () => {
    it('marks dangling when judge returns in_progress', async () => {
      const req = makeReq({ lastWorkSessionId: 'sess-dead' })
      const commitSpy = vi.fn()
      const updateSpy = vi.fn()

      const deps = mockDeps({
        isRunning: () => false,
        loadTranscriptMessages: async () => ['正在进行中'],
        judgeCompletion: async () => ({ verdict: 'in_progress', reason: '还在开发' }),
        commitAndPush: commitSpy,
        updateStatus: updateSpy,
      })

      const results = await reconcileInProgress([req], PROJECT, deps, SIGNAL)

      expect(results).toHaveLength(1)
      expect(results[0]).toEqual({
        intentId: req.id,
        runStatus: 'dangling',
        autoCompleted: false,
      })
      expect(commitSpy).not.toHaveBeenCalled()
      expect(updateSpy).not.toHaveBeenCalled()
    })
  })

  describe('branch 4 — process dead, judge says stuck (dangling)', () => {
    it('marks dangling when judge returns stuck', async () => {
      const req = makeReq({ lastWorkSessionId: 'sess-dead' })
      const commitSpy = vi.fn()
      const updateSpy = vi.fn()

      const deps = mockDeps({
        isRunning: () => false,
        loadTranscriptMessages: async () => ['不知道该怎么做'],
        judgeCompletion: async () => ({ verdict: 'stuck', reason: '需要人类决策' }),
        commitAndPush: commitSpy,
        updateStatus: updateSpy,
      })

      const results = await reconcileInProgress([req], PROJECT, deps, SIGNAL)

      expect(results).toHaveLength(1)
      expect(results[0]).toEqual({
        intentId: req.id,
        runStatus: 'dangling',
        autoCompleted: false,
      })
      expect(commitSpy).not.toHaveBeenCalled()
      expect(updateSpy).not.toHaveBeenCalled()
    })
  })

  describe('edge cases', () => {
    it('returns empty for an empty input list', async () => {
      const results = await reconcileInProgress([], PROJECT, mockDeps(), SIGNAL)
      expect(results).toEqual([])
    })

    it('marks dangling when lastWorkSessionId is null (no work session ever)', async () => {
      const req = makeReq({ lastWorkSessionId: null })
      const deps = mockDeps({
        isRunning: () => false,
        loadTranscriptMessages: async () => {
          throw new Error('should not be called')
        },
        judgeCompletion: async () => {
          throw new Error('should not be called')
        },
      })

      const results = await reconcileInProgress([req], PROJECT, deps, SIGNAL)

      expect(results).toHaveLength(1)
      expect(results[0].runStatus).toBe('dangling')
      expect(results[0].autoCompleted).toBe(false)
    })

    it('marks dangling when transcript loading throws', async () => {
      const req = makeReq({ lastWorkSessionId: 'sess-gone' })
      const judgeSpy = vi.fn()

      const deps = mockDeps({
        isRunning: () => false,
        loadTranscriptMessages: async () => {
          throw new Error('session deleted')
        },
        judgeCompletion: judgeSpy,
      })

      const results = await reconcileInProgress([req], PROJECT, deps, SIGNAL)

      expect(results).toHaveLength(1)
      expect(results[0].runStatus).toBe('dangling')
      expect(judgeSpy).not.toHaveBeenCalled() // skipped
    })

    it('processes multiple intents independently', async () => {
      // Three intents: one running, one done, one dangling
      const r1 = makeReq({ id: 'r1', lastWorkSessionId: 'sess-running', title: '运行中' })
      const r2 = makeReq({ id: 'r2', lastWorkSessionId: 'sess-done', title: '完成' })
      const r3 = makeReq({ id: 'r3', lastWorkSessionId: 'sess-stuck', title: '卡住' })

      const commitSpy = vi.fn().mockResolvedValue({ ok: true, committed: true })
      const updateSpy = vi.fn()

      const deps = mockDeps({
        isRunning: (id) => id === 'sess-running',
        loadTranscriptMessages: async (_p, id) => {
          if (id === 'sess-done') return ['全部完成']
          if (id === 'sess-stuck') return ['不知道']
          return []
        },
        judgeCompletion: async (input) => {
          if (input.req.id === 'r2') return { verdict: 'done', reason: 'ok' }
          return { verdict: 'stuck', reason: 'blocked' }
        },
        commitAndPush: commitSpy,
        updateStatus: updateSpy,
      })

      const results = await reconcileInProgress([r1, r2, r3], PROJECT, deps, SIGNAL)

      expect(results).toHaveLength(3)
      expect(results[0]).toEqual({
        intentId: 'r1',
        runStatus: 'running',
        autoCompleted: false,
      })
      expect(results[1]).toEqual({ intentId: 'r2', runStatus: 'idle', autoCompleted: true })
      expect(results[2]).toEqual({
        intentId: 'r3',
        runStatus: 'dangling',
        autoCompleted: false,
      })

      // Only r2 triggered commit + status update
      expect(commitSpy).toHaveBeenCalledTimes(1)
      expect(updateSpy).toHaveBeenCalledTimes(1)
      expect(updateSpy).toHaveBeenCalledWith('r2', 'done')
    })
  })
})
