/**
 * Unit tests for the automation orchestrator — dependency merge validation.
 *
 * Covers the `pickNext` function's behavior under different git branch modes
 * and dependency merge states. The `startDevelopment` handler's dependency
 * check is tested in the handler test below.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Intent } from '@ccc/shared/protocol'
import { PENDING_SESSION_PREFIX } from '@ccc/shared/protocol'

// ---- Mocks (must be before imports) ----

vi.mock('./store.js', () => ({
  getIntent: vi.fn(),
  isStoreAvailable: vi.fn(() => true),
  listIntents: vi.fn(),
  setBranchName: vi.fn(),
  setLastWorkSession: vi.fn(),
  setPrInfo: vi.fn(),
  updateStatus: vi.fn(),
}))

vi.mock('../../kernel/config/index.js', () => ({
  getDefaultMainBranch: vi.fn(() => 'main'),
  getForgeOverride: vi.fn(),
  getDevSkill: vi.fn(),
  getDefaultMode: vi.fn(),
  getGitBranchMode: vi.fn(),
  getSddEnabled: vi.fn(() => false),
}))

vi.mock('./worktree.js', () => ({
  createWorktree: vi.fn(() => ({ worktreePath: '/tmp/wt', branchName: 'wt-branch' })),
  fetchRemoteBase: vi.fn(),
  getWorktreePath: vi.fn(),
  worktreeExists: vi.fn(),
  readBranch: vi.fn(() => 'main'),
  pullCurrentBranch: vi.fn(() => ({ ok: true, skipped: true })),
}))

vi.mock('../../runs.js', () => ({
  ensureRuntime: vi.fn(() => ({ effectiveCwd: undefined })),
  getRuntime: vi.fn(),
  isRunning: vi.fn(() => false),
  removeRuntime: vi.fn(),
  removeViewer: vi.fn(),
  addViewer: vi.fn(),
}))

vi.mock('../../kernel/agent-config/index.js', () => ({
  getDefaultAgentId: vi.fn(),
  resolveSessionAgentSwitch: vi.fn(),
  resolveSessionVendor: vi.fn(),
  setSessionAgent: vi.fn(),
}))

vi.mock('../sessions/session-metadata-store.js', () => ({
  deleteByVendorId: vi.fn(),
  updateRealRowTitle: vi.fn(),
  upsertBoundRow: vi.fn(),
  upsertPendingRow: vi.fn(),
}))

vi.mock('../../kernel/agent/process/launcher.js', () => ({
  probeAll: vi.fn(),
}))

vi.mock('../../sessions.js', () => ({
  loadHistory: vi.fn(),
  loadLastAssistantMessages: vi.fn(),
  sessionExists: vi.fn(() => Promise.resolve(false)),
}))

vi.mock('../../state.js', () => ({
  hasWorkspace: vi.fn(() => true),
  touchWorkspace: vi.fn(),
  resolveWorkspaceRoot: vi.fn(() => '/test/proj'),
  pathToId: vi.fn(() => 'test-proj'),
}))

vi.mock('../../git.js', () => ({
  commitAndPush: vi.fn(),
  createForgePr: vi.fn(),
  gitDiffStat: vi.fn(),
  gitRecentLog: vi.fn(),
}))

vi.mock('./judge.js', () => ({
  judgeCompletion: vi.fn(),
}))

vi.mock('./checkpoint-consensus.js', () => ({
  runCheckpointConsensus: vi.fn(),
}))

// ---- Imports ----

import { pickNext, startWorkflow, notifyTurnSettled, isIntentDrivenByWorkflow } from './workflow.js'
import type { WorkflowHooks, DevTurnResult, RunDevTurnInput } from './workflow.js'
import { EventNormalizerRegistry } from '../../kernel/events/generic-event.js'
import { PR_EVENT_TYPE, normalizePrGenericEvent } from '../pr-events/tool-defs.js'
import { startDevelopment } from './index.js'

const workflowPrRegistry = new EventNormalizerRegistry()
workflowPrRegistry.register(PR_EVENT_TYPE, normalizePrGenericEvent)
import { listIntents, getIntent, setBranchName, setPrInfo, updateStatus } from './store.js'
import {
  getDevSkill,
  getGitBranchMode,
  getDefaultMainBranch,
  getForgeOverride,
  getSddEnabled,
} from '../../kernel/config/index.js'
import { getDefaultAgentId, resolveSessionVendor } from '../../kernel/agent-config/index.js'
import { createWorktree, fetchRemoteBase, getWorktreePath, readBranch } from './worktree.js'
import { commitAndPush, createForgePr, gitDiffStat, gitRecentLog } from '../../git.js'
import { judgeCompletion } from './judge.js'
import { ensureRuntime, getRuntime } from '../../runs.js'
import { hasWorkspace } from '../../state.js'
import { releaseDevLaunch, resetForTests as resetDevLinksForTests } from './dev-link.js'
import { buildDevSpecNote, SDD_WORK_SESSION_INSTRUCT } from './dev-prompt.js'
import { upsertPendingRow } from '../sessions/session-metadata-store.js'

// ---- Test-only types (mirrors the Handler shape without importing transport) ----

interface StartDevMsg {
  type: 'start_development'
  workspaceId: string
  intentId: string
}

// ---- Factory ----

const makeIntent = (overrides: Partial<Intent> & { id: string }): Intent => ({
  workspaceId: 'test-proj',
  title: 'Test',
  shortEnTitle: null,
  content: '',
  priority: 'P1',
  module: '',
  status: 'todo',
  dependsOn: [],
  dependsOnTypes: {},
  automate: true,
  createdAt: 100,
  updatedAt: 100,
  completedAt: null,
  runStatus: 'idle',
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
  lastWorkSessionId: null,
  ...overrides,
})

// =============================================================================
// pickNext — automated scheduling path
// =============================================================================

describe('pickNext — worktree dep merge validation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetDevLinksForTests()
    vi.mocked(createWorktree).mockImplementation(() => ({
      worktreePath: '/tmp/wt',
      branchName: 'wt-branch',
    }))
    vi.mocked(readBranch).mockReturnValue('main')
    vi.mocked(getSddEnabled).mockReturnValue(false)
  })

  it('worktree: filters out intents whose dep is done but not merged', () => {
    const dep = makeIntent({ id: 'A', status: 'done', prStatus: 'reviewing' })
    const child = makeIntent({ id: 'B', dependsOn: ['A'] })
    vi.mocked(listIntents).mockReturnValue([dep, child])
    vi.mocked(getGitBranchMode).mockReturnValue('worktree')

    const result = pickNext('/test/proj')
    expect(result).toBeNull()
  })

  it('worktree: allows intents whose dep is done and merged', () => {
    const dep = makeIntent({ id: 'A', status: 'done', prStatus: 'merged' })
    const child = makeIntent({ id: 'B', dependsOn: ['A'] })
    vi.mocked(listIntents).mockReturnValue([dep, child])
    vi.mocked(getGitBranchMode).mockReturnValue('worktree')

    const result = pickNext('/test/proj')
    expect(result?.id).toBe('B')
  })

  it('current-branch: does not check prStatus (unmerged dep still passes)', () => {
    const dep = makeIntent({ id: 'A', status: 'done', prStatus: 'reviewing' })
    const child = makeIntent({ id: 'B', dependsOn: ['A'] })
    vi.mocked(listIntents).mockReturnValue([dep, child])
    vi.mocked(getGitBranchMode).mockReturnValue('current-branch')

    const result = pickNext('/test/proj')
    expect(result?.id).toBe('B')
  })

  it('worktree: all deps must be merged (one unmerged blocks)', () => {
    const depA = makeIntent({ id: 'A', status: 'done', prStatus: 'merged' })
    const depB = makeIntent({ id: 'B', status: 'done', prStatus: 'reviewing' })
    const child = makeIntent({ id: 'C', dependsOn: ['A', 'B'] })
    vi.mocked(listIntents).mockReturnValue([depA, depB, child])
    vi.mocked(getGitBranchMode).mockReturnValue('worktree')

    const result = pickNext('/test/proj')
    expect(result).toBeNull()
  })

  it('worktree: non-existent dep is treated as satisfied', () => {
    const child = makeIntent({ id: 'B', dependsOn: ['A'] })
    vi.mocked(listIntents).mockReturnValue([child])
    vi.mocked(getGitBranchMode).mockReturnValue('worktree')

    const result = pickNext('/test/proj')
    expect(result?.id).toBe('B')
  })

  it('worktree: dep not done (in_progress) is filtered regardless of prStatus', () => {
    const dep = makeIntent({ id: 'A', status: 'in_progress', prStatus: null, automate: false })
    const child = makeIntent({ id: 'B', dependsOn: ['A'] })
    vi.mocked(listIntents).mockReturnValue([dep, child])
    vi.mocked(getGitBranchMode).mockReturnValue('worktree')

    const result = pickNext('/test/proj')
    expect(result).toBeNull()
  })

  it('SDD off: does not require a spec or approval', () => {
    const req = makeIntent({ id: 'A', specPath: null, specApproved: false })
    vi.mocked(listIntents).mockReturnValue([req])
    vi.mocked(getGitBranchMode).mockReturnValue('current-branch')
    vi.mocked(getSddEnabled).mockReturnValue(false)

    const result = pickNext('/test/proj')
    expect(result?.id).toBe('A')
  })

  it('SDD on: filters out intents without a spec approval', () => {
    const req = makeIntent({ id: 'A', specPath: null, specApproved: false })
    vi.mocked(listIntents).mockReturnValue([req])
    vi.mocked(getGitBranchMode).mockReturnValue('current-branch')
    vi.mocked(getSddEnabled).mockReturnValue(true)

    const result = pickNext('/test/proj')
    expect(result).toBeNull()
  })

  it('SDD on: filters out authored but unapproved specs', () => {
    const req = makeIntent({ id: 'A', specPath: '/specs/a/spec.md', specApproved: false })
    vi.mocked(listIntents).mockReturnValue([req])
    vi.mocked(getGitBranchMode).mockReturnValue('current-branch')
    vi.mocked(getSddEnabled).mockReturnValue(true)

    const result = pickNext('/test/proj')
    expect(result).toBeNull()
  })

  it('SDD on: allows approved specs', () => {
    const req = makeIntent({ id: 'A', specPath: '/specs/a/spec.md', specApproved: true })
    vi.mocked(listIntents).mockReturnValue([req])
    vi.mocked(getGitBranchMode).mockReturnValue('current-branch')
    vi.mocked(getSddEnabled).mockReturnValue(true)

    const result = pickNext('/test/proj')
    expect(result?.id).toBe('A')
  })

  it('SDD on: skips unapproved intents and preserves priority among approved candidates', () => {
    const highUnapproved = makeIntent({
      id: 'A',
      priority: 'P0',
      specPath: '/specs/a/spec.md',
      specApproved: false,
    })
    const approved = makeIntent({
      id: 'B',
      priority: 'P1',
      specPath: '/specs/b/spec.md',
      specApproved: true,
    })
    const lowerApproved = makeIntent({
      id: 'C',
      priority: 'P2',
      specPath: '/specs/c/spec.md',
      specApproved: true,
    })
    vi.mocked(listIntents).mockReturnValue([highUnapproved, lowerApproved, approved])
    vi.mocked(getGitBranchMode).mockReturnValue('current-branch')
    vi.mocked(getSddEnabled).mockReturnValue(true)

    const result = pickNext('/test/proj')
    expect(result?.id).toBe('B')
  })
})

// =============================================================================
// startDevelopment — manual start path
// =============================================================================

describe('startDevelopment — manual start dep merge validation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetDevLinksForTests()
    vi.mocked(getSddEnabled).mockReturnValue(false)
    vi.mocked(getDefaultAgentId).mockReturnValue('default-agent')
    vi.mocked(resolveSessionVendor).mockReturnValue('claude')
  })

  function makeConn() {
    const sent: Record<string, unknown>[] = []
    const conn = {
      send: (msg: unknown) => sent.push(msg as Record<string, unknown>),
    }
    return { sent, conn }
  }

  function makeCtx() {
    return { launchRun: vi.fn(() => Promise.resolve()) }
  }

  it('worktree: blocks manual start when dep is done but not merged', async () => {
    const dep = makeIntent({
      id: 'A',
      status: 'done',
      prStatus: 'reviewing',
      branchName: 'intent/A',
      title: 'Dep A',
    })
    const req = makeIntent({ id: 'B', title: 'Child B', dependsOn: ['A'] })
    vi.mocked(hasWorkspace).mockReturnValue(true)
    vi.mocked(getIntent).mockImplementation((id: string) => {
      if (id === 'A') return dep
      if (id === 'B') return req
      return null
    })
    vi.mocked(listIntents).mockReturnValue([dep, req])
    vi.mocked(getGitBranchMode).mockReturnValue('worktree')

    const { sent, conn } = makeConn()
    const ctx = makeCtx()

    const msg: StartDevMsg = {
      type: 'start_development',
      workspaceId: 'test-proj',
      intentId: 'B',
    }
    await startDevelopment(
      ctx as unknown as Parameters<typeof startDevelopment>[0],
      conn as unknown as Parameters<typeof startDevelopment>[1],
      msg,
    )

    expect(sent).toHaveLength(1)
    const err = sent[0] as Record<string, unknown>
    expect(err.type).toBe('error')
    const errError = err.error as Record<string, unknown>
    expect(errError.code).toBe('intent.dependencyNotMerged')
    const params = errError.params as Record<string, unknown>
    expect(params.title).toBe('Dep A')
  })

  it('current-branch: does not block manual start when dep is unmerged', async () => {
    const dep = makeIntent({ id: 'A', status: 'done', prStatus: 'reviewing', title: 'Dep A' })
    const req = makeIntent({ id: 'B', title: 'Child B', dependsOn: ['A'] })
    vi.mocked(hasWorkspace).mockReturnValue(true)
    vi.mocked(getIntent).mockImplementation((id: string) => {
      if (id === 'A') return dep
      if (id === 'B') return req
      return null
    })
    vi.mocked(listIntents).mockReturnValue([dep, req])
    vi.mocked(getGitBranchMode).mockReturnValue('current-branch')

    const { sent, conn } = makeConn()
    const ctx = makeCtx()

    const msg1: StartDevMsg = {
      type: 'start_development',
      workspaceId: 'test-proj',
      intentId: 'B',
    }
    await startDevelopment(
      ctx as unknown as Parameters<typeof startDevelopment>[0],
      conn as unknown as Parameters<typeof startDevelopment>[1],
      msg1,
    )

    // current-branch mode: no merge check → should proceed (no error sent)
    const errors = sent.filter((m: Record<string, unknown>) => m.type === 'error')
    expect(errors).toHaveLength(0)
  })

  it('codex: writes a pending projection row with the intent title', async () => {
    const req = makeIntent({ id: 'B', title: 'Set Codex work session title' })
    vi.mocked(hasWorkspace).mockReturnValue(true)
    vi.mocked(getIntent).mockReturnValue(req)
    vi.mocked(listIntents).mockReturnValue([req])
    vi.mocked(getGitBranchMode).mockReturnValue('current-branch')
    vi.mocked(readBranch).mockReturnValue('main')
    vi.mocked(resolveSessionVendor).mockReturnValue('codex')

    const { conn } = makeConn()
    const ctx = makeCtx()

    await startDevelopment(
      ctx as unknown as Parameters<typeof startDevelopment>[0],
      conn as unknown as Parameters<typeof startDevelopment>[1],
      { type: 'start_development', workspaceId: 'test-proj', intentId: 'B' },
    )

    const pendingId = vi.mocked(ensureRuntime).mock.calls[0]?.[0]
    expect(pendingId).toMatch(/^pending:/)
    expect(resolveSessionVendor).toHaveBeenCalledWith(pendingId)
    expect(upsertPendingRow).toHaveBeenCalledWith({
      pendingId,
      workspacePath: '/test/proj',
      vendor: 'codex',
      agentId: 'default-agent',
      title: 'Set Codex work session title',
      ownerKind: 'intent',
      ownerId: 'B',
    })
  })

  it('claude: leaves startDevelopment on the existing no-pending-row path', async () => {
    const req = makeIntent({ id: 'B', title: 'Claude keeps existing behavior' })
    vi.mocked(hasWorkspace).mockReturnValue(true)
    vi.mocked(getIntent).mockReturnValue(req)
    vi.mocked(listIntents).mockReturnValue([req])
    vi.mocked(getGitBranchMode).mockReturnValue('current-branch')
    vi.mocked(readBranch).mockReturnValue('main')
    vi.mocked(resolveSessionVendor).mockReturnValue('claude')

    const { conn } = makeConn()
    const ctx = makeCtx()

    await startDevelopment(
      ctx as unknown as Parameters<typeof startDevelopment>[0],
      conn as unknown as Parameters<typeof startDevelopment>[1],
      { type: 'start_development', workspaceId: 'test-proj', intentId: 'B' },
    )

    expect(upsertPendingRow).not.toHaveBeenCalled()
  })

  it('worktree: allows manual start when dep is done and merged', async () => {
    const dep = makeIntent({ id: 'A', status: 'done', prStatus: 'merged', title: 'Dep A' })
    const req = makeIntent({ id: 'B', title: 'Child B', dependsOn: ['A'] })
    vi.mocked(hasWorkspace).mockReturnValue(true)
    vi.mocked(getIntent).mockImplementation((id: string) => {
      if (id === 'A') return dep
      if (id === 'B') return req
      return null
    })
    vi.mocked(listIntents).mockReturnValue([dep, req])
    vi.mocked(getGitBranchMode).mockReturnValue('worktree')

    const { sent, conn } = makeConn()
    const ctx = makeCtx()

    const msg2: StartDevMsg = {
      type: 'start_development',
      workspaceId: 'test-proj',
      intentId: 'B',
    }
    await startDevelopment(
      ctx as unknown as Parameters<typeof startDevelopment>[0],
      conn as unknown as Parameters<typeof startDevelopment>[1],
      msg2,
    )

    const depErrors = sent.filter((m: Record<string, unknown>) => {
      if (m.type !== 'error') return false
      const err = m.error as Record<string, unknown> | undefined
      return err?.code === 'intent.dependencyNotMerged'
    })
    expect(depErrors).toHaveLength(0)
  })

  it('concurrent manual start claims one launch and rejects the second as in-flight', async () => {
    const req = makeIntent({ id: 'B', title: 'Child B' })
    vi.mocked(hasWorkspace).mockReturnValue(true)
    vi.mocked(getIntent).mockReturnValue(req)
    vi.mocked(listIntents).mockReturnValue([req])
    vi.mocked(getGitBranchMode).mockReturnValue('current-branch')
    vi.mocked(readBranch).mockReturnValue('main')

    const first = makeConn()
    const second = makeConn()
    const ctx = makeCtx()
    const msg: StartDevMsg = {
      type: 'start_development',
      workspaceId: 'test-proj',
      intentId: 'B',
    }

    await Promise.all([
      startDevelopment(
        ctx as unknown as Parameters<typeof startDevelopment>[0],
        first.conn as unknown as Parameters<typeof startDevelopment>[1],
        msg,
      ),
      startDevelopment(
        ctx as unknown as Parameters<typeof startDevelopment>[0],
        second.conn as unknown as Parameters<typeof startDevelopment>[1],
        msg,
      ),
    ])

    expect(ctx.launchRun).toHaveBeenCalledTimes(1)
    expect(createWorktree).not.toHaveBeenCalled()
    expect(second.sent).toEqual([{ type: 'error', error: { code: 'intent.devStartInFlight' } }])
  })

  it('worktree concurrent manual start creates only one worktree', async () => {
    const req = makeIntent({ id: 'B', title: 'Child B' })
    vi.mocked(hasWorkspace).mockReturnValue(true)
    vi.mocked(getIntent).mockReturnValue(req)
    vi.mocked(listIntents).mockReturnValue([req])
    vi.mocked(getGitBranchMode).mockReturnValue('worktree')
    vi.mocked(createWorktree).mockReturnValue({ worktreePath: '/tmp/wt-B', branchName: 'intent/B' })

    const first = makeConn()
    const second = makeConn()
    const ctx = makeCtx()
    const msg: StartDevMsg = {
      type: 'start_development',
      workspaceId: 'test-proj',
      intentId: 'B',
    }

    await Promise.all([
      startDevelopment(
        ctx as unknown as Parameters<typeof startDevelopment>[0],
        first.conn as unknown as Parameters<typeof startDevelopment>[1],
        msg,
      ),
      startDevelopment(
        ctx as unknown as Parameters<typeof startDevelopment>[0],
        second.conn as unknown as Parameters<typeof startDevelopment>[1],
        msg,
      ),
    ])

    expect(createWorktree).toHaveBeenCalledTimes(1)
    expect(ctx.launchRun).toHaveBeenCalledTimes(1)
    expect(second.sent[0]?.error).toEqual({ code: 'intent.devStartInFlight' })
  })

  it('run:bound release lets the same intent start again', async () => {
    const req = makeIntent({ id: 'B', title: 'Child B' })
    vi.mocked(hasWorkspace).mockReturnValue(true)
    vi.mocked(getIntent).mockReturnValue(req)
    vi.mocked(listIntents).mockReturnValue([req])
    vi.mocked(getGitBranchMode).mockReturnValue('current-branch')
    vi.mocked(readBranch).mockReturnValue('main')

    const ctx = makeCtx()
    const msg: StartDevMsg = {
      type: 'start_development',
      workspaceId: 'test-proj',
      intentId: 'B',
    }
    await startDevelopment(
      ctx as unknown as Parameters<typeof startDevelopment>[0],
      makeConn().conn as unknown as Parameters<typeof startDevelopment>[1],
      msg,
    )

    releaseDevLaunch('B')

    await startDevelopment(
      ctx as unknown as Parameters<typeof startDevelopment>[0],
      makeConn().conn as unknown as Parameters<typeof startDevelopment>[1],
      msg,
    )

    expect(ctx.launchRun).toHaveBeenCalledTimes(2)
  })

  it('startup failure releases the claim so the same intent can retry', async () => {
    const req = makeIntent({ id: 'B', title: 'Child B' })
    vi.mocked(hasWorkspace).mockReturnValue(true)
    vi.mocked(getIntent).mockReturnValue(req)
    vi.mocked(listIntents).mockReturnValue([req])
    vi.mocked(getGitBranchMode).mockReturnValue('worktree')
    vi.mocked(createWorktree)
      .mockImplementationOnce(() => {
        throw new Error('boom')
      })
      .mockReturnValueOnce({ worktreePath: '/tmp/wt-B', branchName: 'intent/B' })

    const ctx = makeCtx()
    const msg: StartDevMsg = {
      type: 'start_development',
      workspaceId: 'test-proj',
      intentId: 'B',
    }
    const failed = makeConn()
    await startDevelopment(
      ctx as unknown as Parameters<typeof startDevelopment>[0],
      failed.conn as unknown as Parameters<typeof startDevelopment>[1],
      msg,
    )
    // The worktree-create error follows the worktree preparation progress event
    // (progress is emitted just before the worktree phase), so find it by code.
    const failedErr = failed.sent.find((m: Record<string, unknown>) => m.type === 'error')
    expect(failedErr?.error).toMatchObject({ code: 'intent.worktreeCreateFailed' })

    const retry = makeConn()
    await startDevelopment(
      ctx as unknown as Parameters<typeof startDevelopment>[0],
      retry.conn as unknown as Parameters<typeof startDevelopment>[1],
      msg,
    )

    expect(ctx.launchRun).toHaveBeenCalledTimes(1)
    // The successful retry emits progress, not an error.
    expect(retry.sent.some((m: Record<string, unknown>) => m.type === 'error')).toBe(false)
  })
})

// =============================================================================
// startDevelopment — startup progress events (dev_launch_progress)
// =============================================================================

describe('startDevelopment — startup progress events', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetDevLinksForTests()
    vi.mocked(readBranch).mockReturnValue('main')
    vi.mocked(getSddEnabled).mockReturnValue(false)
  })

  function makeConn() {
    const sent: Record<string, unknown>[] = []
    const conn = { send: (msg: unknown) => sent.push(msg as Record<string, unknown>) }
    return { sent, conn }
  }

  const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

  const progressStages = (sent: Record<string, unknown>[]): string[] =>
    sent.filter((m) => m.type === 'dev_launch_progress').map((m) => m.stage as string)

  const run = (
    ctx: { launchRun: ReturnType<typeof vi.fn> },
    conn: ReturnType<typeof makeConn>['conn'],
  ): Promise<void> =>
    Promise.resolve(
      startDevelopment(
        ctx as unknown as Parameters<typeof startDevelopment>[0],
        conn as unknown as Parameters<typeof startDevelopment>[1],
        { type: 'start_development', workspaceId: 'test-proj', intentId: 'B' },
      ),
    )

  it('worktree: emits fetch, prepare, then launch stages', async () => {
    const req = makeIntent({ id: 'B', title: 'Child B' })
    vi.mocked(hasWorkspace).mockReturnValue(true)
    vi.mocked(getIntent).mockReturnValue(req)
    vi.mocked(listIntents).mockReturnValue([req])
    vi.mocked(getGitBranchMode).mockReturnValue('worktree')
    vi.mocked(getDefaultMainBranch).mockReturnValue('main')
    vi.mocked(createWorktree).mockReturnValue({ worktreePath: '/tmp/wt-B', branchName: 'intent/B' })

    const { sent, conn } = makeConn()
    const ctx = { launchRun: vi.fn(() => Promise.resolve()) }
    await run(ctx, conn)

    expect(progressStages(sent)).toEqual([
      'fetching-remote-main',
      'preparing-worktree',
      'launching',
    ])
    expect(fetchRemoteBase).toHaveBeenCalledWith('/test/proj', 'main')
  })

  it('current-branch: emits fetch, prepare, then launch stages without worktree fetch', async () => {
    const req = makeIntent({ id: 'B', title: 'Child B' })
    vi.mocked(hasWorkspace).mockReturnValue(true)
    vi.mocked(getIntent).mockReturnValue(req)
    vi.mocked(listIntents).mockReturnValue([req])
    vi.mocked(getGitBranchMode).mockReturnValue('current-branch')
    vi.mocked(readBranch).mockReturnValue('main')

    const { sent, conn } = makeConn()
    const ctx = { launchRun: vi.fn(() => Promise.resolve()) }
    await run(ctx, conn)

    expect(progressStages(sent)).toEqual([
      'fetching-remote-main',
      'preparing-worktree',
      'launching',
    ])
    expect(fetchRemoteBase).not.toHaveBeenCalled()
  })

  it('emits failed when the async launch rejects (previously silent)', async () => {
    const req = makeIntent({ id: 'B', title: 'Child B' })
    vi.mocked(hasWorkspace).mockReturnValue(true)
    vi.mocked(getIntent).mockReturnValue(req)
    vi.mocked(listIntents).mockReturnValue([req])
    vi.mocked(getGitBranchMode).mockReturnValue('current-branch')
    vi.mocked(readBranch).mockReturnValue('main')

    const { sent, conn } = makeConn()
    const ctx = { launchRun: vi.fn(() => Promise.reject(new Error('spawn failed'))) }
    await run(ctx, conn)
    await flush()

    expect(progressStages(sent)).toEqual([
      'fetching-remote-main',
      'preparing-worktree',
      'launching',
      'failed',
    ])
  })

  it('synchronous validation failure emits only error, no progress', async () => {
    vi.mocked(hasWorkspace).mockReturnValue(true)
    // Unknown intent → notFound, rejected before any slow phase.
    vi.mocked(getIntent).mockReturnValue(null)
    vi.mocked(listIntents).mockReturnValue([])
    vi.mocked(getGitBranchMode).mockReturnValue('worktree')

    const { sent, conn } = makeConn()
    const ctx = { launchRun: vi.fn(() => Promise.resolve()) }
    await run(ctx, conn)

    expect(progressStages(sent)).toEqual([])
    expect(sent.some((m) => m.type === 'error')).toBe(true)
    expect(ctx.launchRun).not.toHaveBeenCalled()
  })
})

// =============================================================================
// WorkflowController — branch-mode alignment (launch + commit/push/PR cwd)
// =============================================================================

describe('automation controller — branch-mode git alignment', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getDevSkill).mockReturnValue('')
    vi.mocked(getSddEnabled).mockReturnValue(false)
    vi.mocked(createWorktree).mockImplementation(() => ({
      worktreePath: '/tmp/wt',
      branchName: 'wt-branch',
    }))
    vi.mocked(readBranch).mockReturnValue('main')
    vi.mocked(getSddEnabled).mockReturnValue(false)
  })

  /** Flush microtasks + the fire-and-forget launch chain. */
  const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

  /** Build a hooks bag whose runDevTurn records its launch input. */
  function makeHooks(): { hooks: WorkflowHooks; runDevTurn: ReturnType<typeof vi.fn> } {
    const runDevTurn = vi.fn(
      (_input: RunDevTurnInput): Promise<DevTurnResult> =>
        Promise.resolve({ outcome: 'complete', sessionId: 'real', lastMessage: '' }),
    )
    const hooks: WorkflowHooks = {
      runDevTurn,
      broadcastIntents: vi.fn(),
      emitStatus: vi.fn(),
      sessionExists: vi.fn(() => Promise.resolve(false)),
      isRunning: vi.fn(() => false),
      normalizeEvent: (core) => workflowPrRegistry.normalize(core),
      publishPrEvent: vi.fn(),
    }
    return { hooks, runDevTurn }
  }

  it('current-branch: 全新启动不调用 createWorktree,effectiveCwd=workspacePath,写当前分支', async () => {
    const proj = '/test/cb-launch'
    const intent = makeIntent({ id: 'X', status: 'todo' })
    vi.mocked(listIntents).mockReturnValue([intent])
    vi.mocked(getIntent).mockReturnValue(intent)
    vi.mocked(getGitBranchMode).mockReturnValue('current-branch')
    vi.mocked(readBranch).mockReturnValue('feature/x')

    const { hooks, runDevTurn } = makeHooks()
    startWorkflow(proj, hooks, 1)
    await flush()

    expect(createWorktree).not.toHaveBeenCalled()
    expect(setBranchName).toHaveBeenCalledWith('X', 'feature/x')
    expect(runDevTurn).toHaveBeenCalledTimes(1)
    const launchedId = runDevTurn.mock.calls[0][0].sessionId as string
    expect(launchedId.startsWith(PENDING_SESSION_PREFIX)).toBe(true)
    const rt = vi.mocked(ensureRuntime).mock.results.at(-1)?.value as { effectiveCwd?: string }
    expect(rt.effectiveCwd).toBe(proj)
  })

  it('worktree: 全新启动 createWorktree 传 getDefaultMainBranch 作基底,effectiveCwd=worktree', async () => {
    const proj = '/test/wt-launch'
    const intent = makeIntent({ id: 'Y', status: 'todo' })
    vi.mocked(listIntents).mockReturnValue([intent])
    vi.mocked(getIntent).mockReturnValue(intent)
    vi.mocked(getGitBranchMode).mockReturnValue('worktree')
    vi.mocked(getDefaultMainBranch).mockReturnValue('main')
    vi.mocked(createWorktree).mockReturnValue({ worktreePath: '/tmp/wt-Y', branchName: 'intent/Y' })

    const { hooks, runDevTurn } = makeHooks()
    startWorkflow(proj, hooks, 1)
    await flush()

    expect(createWorktree).toHaveBeenCalledWith(proj, 'Y', 'Test', 'main')
    expect(readBranch).not.toHaveBeenCalled()
    expect(setBranchName).toHaveBeenCalledWith('Y', 'intent/Y')
    expect(runDevTurn).toHaveBeenCalledTimes(1)
    const rt = vi.mocked(ensureRuntime).mock.results.at(-1)?.value as { effectiveCwd?: string }
    expect(rt.effectiveCwd).toBe('/tmp/wt-Y')
  })

  it('fresh launch: SDD on without devSkill passes SDD instruct out-of-echo and visible spec note', async () => {
    const proj = '/test/sdd-no-skill'
    const specPath = '/specs/project/2026/06/26/spec.md'
    const intent = makeIntent({
      id: 'SDD',
      status: 'todo',
      content: 'Body',
      dependsOn: ['DEP-1'],
      specPath,
      specApproved: true,
    })
    vi.mocked(listIntents).mockReturnValue([intent])
    vi.mocked(getIntent).mockReturnValue(intent)
    vi.mocked(getGitBranchMode).mockReturnValue('current-branch')
    vi.mocked(getSddEnabled).mockReturnValue(true)

    const { hooks, runDevTurn } = makeHooks()
    startWorkflow(proj, hooks, 1)
    await flush()

    const input = runDevTurn.mock.calls[0][0] as RunDevTurnInput
    expect(input.prompt).toBe(`Test\n\nBody\n\n依赖需求:DEP-1\n\n${buildDevSpecNote(specPath)}`)
    expect(input.systemInstruction).toBe(SDD_WORK_SESSION_INSTRUCT)
    expect(input.userTurnPrefix).toBeUndefined()
    expect(input.prompt).not.toContain(SDD_WORK_SESSION_INSTRUCT)
  })

  it('fresh launch: SDD on with devSkill keeps slash prefix out-of-echo and does not stack instruct', async () => {
    const proj = '/test/sdd-skill'
    const specPath = '/specs/project/2026/06/26/spec.md'
    const intent = makeIntent({
      id: 'SKILL',
      status: 'todo',
      content: 'Body',
      specPath,
      specApproved: true,
    })
    vi.mocked(listIntents).mockReturnValue([intent])
    vi.mocked(getIntent).mockReturnValue(intent)
    vi.mocked(getGitBranchMode).mockReturnValue('current-branch')
    vi.mocked(getDevSkill).mockReturnValue('/dev')
    vi.mocked(getSddEnabled).mockReturnValue(true)

    const { hooks, runDevTurn } = makeHooks()
    startWorkflow(proj, hooks, 1)
    await flush()

    const input = runDevTurn.mock.calls[0][0] as RunDevTurnInput
    expect(input.prompt).toBe(`Test\n\nBody\n\n${buildDevSpecNote(specPath)}`)
    expect(input.userTurnPrefix).toBe('/dev ')
    expect(input.systemInstruction).toBeUndefined()
    expect(input.prompt).not.toContain('/dev')
    expect(input.prompt).not.toContain(SDD_WORK_SESSION_INSTRUCT)
  })

  it('fresh launch: SDD off keeps historic visible prompt and no SDD instruction', async () => {
    const proj = '/test/sdd-off'
    const intent = makeIntent({
      id: 'OFF',
      status: 'todo',
      content: 'Body',
      dependsOn: ['DEP-1'],
      specPath: '/specs/project/2026/06/26/spec.md',
      specApproved: true,
    })
    vi.mocked(listIntents).mockReturnValue([intent])
    vi.mocked(getIntent).mockReturnValue(intent)
    vi.mocked(getGitBranchMode).mockReturnValue('current-branch')
    vi.mocked(getSddEnabled).mockReturnValue(false)

    const { hooks, runDevTurn } = makeHooks()
    startWorkflow(proj, hooks, 1)
    await flush()

    const input = runDevTurn.mock.calls[0][0] as RunDevTurnInput
    expect(input.prompt).toBe('Test\n\nBody\n\n依赖需求:DEP-1')
    expect(input.systemInstruction).toBeUndefined()
    expect(input.userTurnPrefix).toBeUndefined()
    expect(input.prompt).not.toContain('Approved spec for this intent')
  })

  it('worktree: 端到端 develop→commit→PR 全针对 worktree 工作目录,setPrInfo reviewing', async () => {
    const proj = '/test/wt-e2e'
    const intent = makeIntent({ id: 'Z', status: 'todo', branchName: 'intent/Z' })
    vi.mocked(getGitBranchMode).mockReturnValue('worktree')
    vi.mocked(getDefaultMainBranch).mockReturnValue('main')
    vi.mocked(createWorktree).mockReturnValue({ worktreePath: '/tmp/wt-Z', branchName: 'intent/Z' })
    vi.mocked(getWorktreePath).mockReturnValue('/tmp/wt-Z')
    // Mutate status so the post-done _startNext stops re-picking the same intent.
    vi.mocked(updateStatus).mockImplementation((_id, status) => {
      intent.status = status
    })
    vi.mocked(listIntents).mockReturnValue([intent])
    vi.mocked(getIntent).mockReturnValue(intent)
    vi.mocked(judgeCompletion).mockResolvedValue({ verdict: 'done', reason: 'ok' })
    vi.mocked(commitAndPush).mockResolvedValue({ ok: true, committed: true })
    vi.mocked(createForgePr).mockResolvedValue({ ok: true, prId: '77', prUrl: 'http://x/pull/77' })
    vi.mocked(gitDiffStat).mockResolvedValue('')
    vi.mocked(gitRecentLog).mockResolvedValue('')
    vi.mocked(getRuntime).mockReturnValue(undefined)

    const { hooks, runDevTurn } = makeHooks()
    startWorkflow(proj, hooks, 1)
    await flush()
    const launchedId = runDevTurn.mock.calls[0][0].sessionId as string

    await notifyTurnSettled(proj, launchedId, 'complete', 'Z')

    // Judge evidence + commit/push + PR all scoped to the worktree, not proj.
    expect(gitDiffStat).toHaveBeenCalledWith('/tmp/wt-Z')
    expect(gitRecentLog).toHaveBeenCalledWith('/tmp/wt-Z')
    expect(commitAndPush).toHaveBeenCalledWith('/tmp/wt-Z', expect.stringContaining('feat:'))
    expect(createForgePr).toHaveBeenCalledWith(
      '/tmp/wt-Z',
      expect.any(String),
      expect.any(String),
      'intent/Z',
      undefined,
      undefined,
    )
    expect(setPrInfo).toHaveBeenCalledWith('Z', '77', 'reviewing')
    expect(updateStatus).toHaveBeenCalledWith('Z', 'done')
  })

  it('worktree: explicit GitLab override uses the forge dispatcher and writes MR fields', async () => {
    const proj = '/test/wt-gitlab'
    const intent = makeIntent({ id: 'GL', status: 'todo', branchName: 'intent/GL' })
    vi.mocked(getGitBranchMode).mockReturnValue('worktree')
    vi.mocked(getDefaultMainBranch).mockReturnValue('main')
    vi.mocked(getForgeOverride).mockReturnValue('gitlab')
    vi.mocked(createWorktree).mockReturnValue({
      worktreePath: '/tmp/wt-GL',
      branchName: 'intent/GL',
    })
    vi.mocked(getWorktreePath).mockReturnValue('/tmp/wt-GL')
    vi.mocked(updateStatus).mockImplementation((_id, status) => {
      intent.status = status
    })
    vi.mocked(listIntents).mockReturnValue([intent])
    vi.mocked(getIntent).mockReturnValue(intent)
    vi.mocked(judgeCompletion).mockResolvedValue({ verdict: 'done', reason: 'ok' })
    vi.mocked(commitAndPush).mockResolvedValue({ ok: true, committed: true })
    vi.mocked(createForgePr).mockResolvedValue({
      ok: true,
      prId: '19',
      prUrl: 'https://gitlab.example/group/project/-/merge_requests/19',
    })
    vi.mocked(gitDiffStat).mockResolvedValue('')
    vi.mocked(gitRecentLog).mockResolvedValue('')
    vi.mocked(getRuntime).mockReturnValue(undefined)

    const { hooks, runDevTurn } = makeHooks()
    startWorkflow(proj, hooks, 1)
    await flush()
    const launchedId = runDevTurn.mock.calls[0][0].sessionId as string

    await notifyTurnSettled(proj, launchedId, 'complete', 'GL')

    expect(createForgePr).toHaveBeenCalledWith(
      '/tmp/wt-GL',
      expect.any(String),
      expect.any(String),
      'intent/GL',
      undefined,
      'gitlab',
    )
    expect(setPrInfo).toHaveBeenCalledWith('GL', '19', 'reviewing')
  })

  it('current-branch: 端到端 commit 用 workspacePath 且不建 worktree、不建 PR', async () => {
    const proj = '/test/cb-e2e'
    const intent = makeIntent({ id: 'W', status: 'todo' })
    vi.mocked(getGitBranchMode).mockReturnValue('current-branch')
    vi.mocked(readBranch).mockReturnValue('main')
    vi.mocked(updateStatus).mockImplementation((_id, status) => {
      intent.status = status
    })
    vi.mocked(listIntents).mockReturnValue([intent])
    vi.mocked(getIntent).mockReturnValue(intent)
    vi.mocked(judgeCompletion).mockResolvedValue({ verdict: 'done', reason: 'ok' })
    vi.mocked(commitAndPush).mockResolvedValue({ ok: true, committed: true })
    vi.mocked(gitDiffStat).mockResolvedValue('')
    vi.mocked(gitRecentLog).mockResolvedValue('')
    vi.mocked(getRuntime).mockReturnValue(undefined)

    const { hooks, runDevTurn } = makeHooks()
    startWorkflow(proj, hooks, 1)
    await flush()
    const launchedId = runDevTurn.mock.calls[0][0].sessionId as string

    await notifyTurnSettled(proj, launchedId, 'complete', 'W')

    expect(createWorktree).not.toHaveBeenCalled()
    expect(gitDiffStat).toHaveBeenCalledWith(proj)
    expect(commitAndPush).toHaveBeenCalledWith(proj, expect.stringContaining('feat:'))
    expect(createForgePr).not.toHaveBeenCalled()
    expect(setPrInfo).not.toHaveBeenCalled()
    expect(updateStatus).toHaveBeenCalledWith('W', 'done')
  })

  // MSC-R1: the manual-vs-automation discriminator the session-end cleanup uses.
  it('isIntentDrivenByWorkflow: true only for the controller’s current intent', async () => {
    const proj = '/test/disc'
    const intent = makeIntent({ id: 'D', status: 'todo', branchName: 'intent/D' })
    vi.mocked(getGitBranchMode).mockReturnValue('worktree')
    vi.mocked(getDefaultMainBranch).mockReturnValue('main')
    vi.mocked(createWorktree).mockReturnValue({ worktreePath: '/tmp/wt-D', branchName: 'intent/D' })
    vi.mocked(listIntents).mockReturnValue([intent])
    vi.mocked(getIntent).mockReturnValue(intent)
    vi.mocked(getRuntime).mockReturnValue(undefined)

    const { hooks } = makeHooks()
    startWorkflow(proj, hooks, 1)
    await flush()

    // While automation drives 'D', the settled 'D' session is automation-owned…
    expect(isIntentDrivenByWorkflow(proj, 'D')).toBe(true)
    // …but any other intent, or a workspace with no controller, is "manual".
    expect(isIntentDrivenByWorkflow(proj, 'other')).toBe(false)
    expect(isIntentDrivenByWorkflow('/no/controller', 'D')).toBe(false)
  })
})
