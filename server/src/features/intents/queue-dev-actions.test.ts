/**
 * Queue action family — development and delivery.
 *
 * Drives the family the way production does: a real reconcile pass hands the
 * kernel's `launch` action to this module. Asserts the git working directory
 * each branch mode uses, the launch prompt channels, the develop → commit → PR
 * chain, the single lint self-heal, and that a real human question is parked
 * rather than answered.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Intent } from '@ccc/shared/protocol'
import { PENDING_SESSION_PREFIX } from '@ccc/shared/protocol'

// ---- Mocks (must be before imports) ----

vi.mock('./store.js', () => ({
  getIntent: vi.fn(),
  isStoreAvailable: vi.fn(() => true),
  listIntents: vi.fn(),
  machineApproveSpec: vi.fn(),
  safeInsertIntentLog: vi.fn(),
  setBranchName: vi.fn(),
  setLastWorkSession: vi.fn(),
  upsertIntentPr: vi.fn(),
  updateStatus: vi.fn(),
}))

vi.mock('./queue-store.js', () => {
  const controls = new Map<
    string,
    { state: string; startedAt: number | null; forceSkipped: string[] }
  >()
  const metas = new Map<string, Record<string, unknown>>()
  const decisions: Record<string, unknown>[] = []
  const empty = (intentId: string): Record<string, unknown> => ({
    intentId,
    failureCount: 0,
    backoffCount: 0,
    backoffUntil: null,
    parked: false,
    parkReason: null,
    parkDetail: null,
    cooldownUntil: null,
    updatedAt: 0,
  })
  return {
    isQueueStoreAvailable: () => true,
    resetQueueStoreForTests: () => {
      controls.clear()
      metas.clear()
      decisions.length = 0
    },
    getQueueControl: (w: string) =>
      controls.get(w) ?? { state: 'idle', startedAt: null, forceSkipped: [] },
    setQueueControl: (
      w: string,
      next: { state: string; startedAt: number | null; forceSkipped: string[] },
    ) => {
      controls.set(w, { ...next, forceSkipped: [...next.forceSkipped] })
      return true
    },
    listActiveQueueWorkspaces: () =>
      [...controls.entries()].filter(([, c]) => c.state !== 'idle').map(([w]) => w),
    getQueueIntentMeta: (w: string) => {
      const out: Record<string, unknown> = {}
      for (const [id, m] of metas) if ((m as { _w?: string })._w === w) out[id] = m
      return out
    },
    getQueueIntentMetaById: (id: string) => metas.get(id) ?? empty(id),
    putQueueIntentMeta: (w: string, m: Record<string, unknown>) => {
      metas.set(m.intentId as string, { ...m, _w: w })
      return true
    },
    deleteQueueIntentMeta: (id: string) => {
      metas.delete(id)
    },
    appendQueueDecisions: (rows: Record<string, unknown>[]) => {
      decisions.push(...rows)
      return true
    },
    listQueueDecisions: () => [...decisions].reverse(),
    latestQueueDecisionByIntent: () => ({}),
    listQueueDecisionsForIntent: (id: string) =>
      decisions.filter((d) => d.intentId === id).reverse(),
  }
})

vi.mock('../../kernel/config/index.js', () => ({
  getDefaultMainBranch: vi.fn(() => 'main'),
  getForgeOverride: vi.fn(),
  getDevSkill: vi.fn(),
  getDefaultMode: vi.fn(),
  getGitBranchMode: vi.fn(),
  getSddEnabled: vi.fn(() => false),
  getSpecMachineApprovalEnabled: vi.fn(() => false),
  getAutomationConcurrency: vi.fn(() => 2),
}))

vi.mock('./worktree.js', () => ({
  createWorktree: vi.fn(() => ({ worktreePath: '/tmp/wt', branchName: 'wt-branch' })),
  fetchRemoteBase: vi.fn(),
  getWorktreePath: vi.fn(),
  worktreeExists: vi.fn(),
  readBranch: vi.fn(() => 'main'),
  readWorktreeHead: vi.fn(() => ({ branch: null, head: null })),
  isWorktreeClean: vi.fn(() => true),
  worktreeContainsRef: vi.fn(() => null),
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

vi.mock('../../sessions.js', () => ({
  loadHistory: vi.fn(),
  loadLastAssistantMessages: vi.fn(),
  sessionExists: vi.fn(() => Promise.resolve(false)),
}))

vi.mock('../../state.js', () => ({
  hasWorkspace: vi.fn(() => true),
  touchWorkspace: vi.fn(),
  resolveWorkspaceRoot: vi.fn((ref: string) => (ref.startsWith('/') ? null : '/test/proj')),
  pathToName: vi.fn(() => 'test-proj'),
  workspaceNameFor: vi.fn(() => 'test-proj'),
}))

vi.mock('../../git.js', () => ({
  commitAndPush: vi.fn(),
  createForgePr: vi.fn(),
  gitDiffStat: vi.fn(),
  gitRecentLog: vi.fn(),
}))

// The PR target resolution runs for real (it is the whole point of these
// assertions); only the delivery it reads is stubbed.
vi.mock('../deliveries/store.js', () => ({
  getDelivery: vi.fn(),
  // Read by the delivery gate on every pass; no delivery-gate case here.
  listDeliveries: vi.fn(() => []),
}))

// The park funnel is a side channel with its own store and its own tests; stub it
// here so these suites keep mocking persistence wholesale instead of reaching the
// real c3.db through the park transitions they exercise.
vi.mock('./funnel-store.js', () => ({
  MANUAL_UNPARK_REASON: 'manual_unpark',
  appendFunnelEvent: vi.fn(() => true),
}))

// The judge is stubbed, but its "no verdict at all" error type is part of the
// contract the dev loop branches on — so the stub carries a real class, not just
// the function.
vi.mock('./judge.js', () => ({
  judgeCompletion: vi.fn(),
  JudgeUnavailableError: class JudgeUnavailableError extends Error {
    constructor(readonly detail: string) {
      super(`judge 不可用: ${detail}`)
      this.name = 'JudgeUnavailableError'
    }
  },
}))
vi.mock('./checkpoint-consensus.js', () => ({ runCheckpointConsensus: vi.fn() }))

// ---- Imports ----

import { startWorkflow, notifyTurnSettled, settleQueueForTests } from './workflow.js'
import type { WorkflowHooks, DevTurnResult, RunDevTurnInput } from './workflow.js'
import { resetWorkflowForTests } from './workflow.js'
import { EventNormalizerRegistry } from '../../kernel/events/generic-event.js'
import { PR_LEGACY_EVENT_TYPE, normalizePrGenericEvent } from '../pr-events/tool-defs.js'
import {
  listIntents,
  getIntent,
  safeInsertIntentLog,
  setBranchName,
  upsertIntentPr,
  updateStatus,
} from './store.js'
import {
  getDevSkill,
  getGitBranchMode,
  getDefaultMainBranch,
  getForgeOverride,
  getSddEnabled,
} from '../../kernel/config/index.js'
import {
  createWorktree,
  fetchRemoteBase,
  getWorktreePath,
  isWorktreeClean,
  readBranch,
  readWorktreeHead,
  worktreeContainsRef,
  worktreeExists,
} from './worktree.js'
import { getDelivery } from '../deliveries/store.js'
import type { Delivery } from '@ccc/shared/protocol'
import { commitAndPush, createForgePr, gitDiffStat, gitRecentLog } from '../../git.js'
import { JudgeUnavailableError, judgeCompletion } from './judge.js'
import { runCheckpointConsensus } from './checkpoint-consensus.js'
import { ensureRuntime, getRuntime } from '../../runs.js'
import { buildDevSpecNote, SDD_WORK_SESSION_INSTRUCT } from './dev-prompt.js'
import {
  getQueueIntentMetaById,
  listQueueDecisions,
  resetQueueStoreForTests,
} from './queue-store.js'

const prRegistry = new EventNormalizerRegistry()
prRegistry.register(PR_LEGACY_EVENT_TYPE, normalizePrGenericEvent)

const makeIntent = (overrides: Partial<Intent> & { id: string }): Intent => ({
  workspaceName: 'test-proj',
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
  baseBranch: 'main',
  baseBranchFallback: false,
  prs: [],
  linkedDeliveries: [],
  specPath: null,
  // 与迁移回填同口径:已批准→approved;有 spec 路径但未批准→pending;其余→raw。
  specStatus: overrides.specApproved ? 'approved' : overrides.specPath ? 'pending' : 'raw',
  specMode: null,
  effectiveSpecMode: 'sdd',
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
  responsibleSubject: null,
  lastWorkSessionId: null,
  sessionActive: false,
  actionDescriptor: null,
  ...overrides,
})

/** A delivery whose branch is ready — the target an automatic PR may reach. */
const makeDelivery = (over: Partial<Delivery> & { id: string }): Delivery => ({
  workspaceName: 'test-proj',
  title: 'Delivery α',
  description: '',
  status: 'integrating',
  startDate: null,
  endDate: null,
  branchName: 'delivery/alpha',
  baseBranch: 'main',
  branchReady: true,
  integration: { merged: 0, total: 1 },
  createdAt: 1,
  updatedAt: 1,
  ...over,
})

describe('queue dev actions — branch-mode git alignment', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetWorkflowForTests()
    resetQueueStoreForTests()
    vi.mocked(getDevSkill).mockReturnValue('')
    vi.mocked(getSddEnabled).mockReturnValue(false)
    vi.mocked(createWorktree).mockImplementation(() => ({
      worktreePath: '/tmp/wt',
      branchName: 'wt-branch',
    }))
    vi.mocked(readBranch).mockReturnValue('main')
    // `clearAllMocks` 只清调用记录、不清实现,所以基线探针的默认值必须每条用例重设,
    // 否则一条「已存在且失配」的用例会把守卫泄漏给后面的全新启动用例。
    vi.mocked(fetchRemoteBase).mockReturnValue(null)
    vi.mocked(worktreeExists).mockReturnValue(false)
    vi.mocked(worktreeContainsRef).mockReturnValue(null)
    vi.mocked(isWorktreeClean).mockReturnValue(true)
    vi.mocked(readWorktreeHead).mockReturnValue({ branch: null, head: null })
    vi.mocked(gitDiffStat).mockResolvedValue('')
    vi.mocked(gitRecentLog).mockResolvedValue('')
    // Forge override is sticky across tests (clearAllMocks does not clear impl).
    vi.mocked(getForgeOverride).mockReturnValue(undefined)
    // Default verdict ends the develop loop after exactly one turn, so a test
    // that only asserts on the LAUNCH is not dragged through continuations.
    vi.mocked(judgeCompletion).mockResolvedValue({ verdict: 'stuck', reason: 'test-default' })
    vi.mocked(runCheckpointConsensus).mockResolvedValue(null)
  })

  /** Run one reconcile pass and let every run it starts settle. */
  const flush = (proj: string): Promise<void> => settleQueueForTests(proj)

  /** Build a hooks bag whose runDevTurn records its launch input. */
  function makeHooks(): { hooks: WorkflowHooks; runDevTurn: ReturnType<typeof vi.fn> } {
    const runDevTurn = vi.fn((_input: RunDevTurnInput): Promise<DevTurnResult> =>
      Promise.resolve({ outcome: 'complete', sessionId: 'real', lastMessage: '' }),
    )
    const hooks: WorkflowHooks = {
      runDevTurn,
      launchSpecRun: vi.fn(() => Promise.resolve()),
      broadcastIntents: vi.fn(),
      emitStatus: vi.fn(),
      sessionExists: vi.fn(() => Promise.resolve(false)),
      isRunning: vi.fn(() => false),
      sessionStatus: vi.fn(() => null),
      normalizeEvent: (core) => prRegistry.normalize(core),
      publishEvent: vi.fn(),
      createUserTodo: vi.fn(),
      broadcastQueueDetail: vi.fn(),
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
    await flush(proj)

    expect(createWorktree).not.toHaveBeenCalled()
    expect(setBranchName).toHaveBeenCalledWith('X', 'feature/x')
    expect(runDevTurn).toHaveBeenCalledTimes(1)
    const launchedId = runDevTurn.mock.calls[0][0].sessionId as string
    expect(launchedId.startsWith(PENDING_SESSION_PREFIX)).toBe(true)
    const rt = vi.mocked(ensureRuntime).mock.results.at(-1)?.value as { effectiveCwd?: string }
    expect(rt.effectiveCwd).toBe(proj)
  })

  it('worktree: 全新启动 createWorktree 以意图基准分支作基底,effectiveCwd=worktree', async () => {
    const proj = '/test/wt-launch'
    const intent = makeIntent({ id: 'Y', status: 'todo' })
    vi.mocked(listIntents).mockReturnValue([intent])
    vi.mocked(getIntent).mockReturnValue(intent)
    vi.mocked(getGitBranchMode).mockReturnValue('worktree')
    vi.mocked(createWorktree).mockReturnValue({ worktreePath: '/tmp/wt-Y', branchName: 'intent/Y' })

    const { hooks, runDevTurn } = makeHooks()
    startWorkflow(proj, hooks, 1)
    await flush(proj)

    expect(createWorktree).toHaveBeenCalledWith(proj, 'Y', 'Test', 'main')
    expect(readBranch).not.toHaveBeenCalled()
    expect(setBranchName).toHaveBeenCalledWith('Y', 'intent/Y')
    expect(runDevTurn).toHaveBeenCalledTimes(1)
    const rt = vi.mocked(ensureRuntime).mock.results.at(-1)?.value as { effectiveCwd?: string }
    expect(rt.effectiveCwd).toBe('/tmp/wt-Y')
  })

  // 这条是本次修复钉住的东西:队列曾用工作区主分支建 worktree,于是「创建时选了
  // 交付」的意图先被自动开发建在 main 上,之后规范 / 评审 / 工作 / 意图会话统统
  // 撞基线守卫。基线只有一个来源 —— 意图落库的 baseBranch。
  it('worktree: 关联交付的意图以 baseBranch 建 worktree,绝不退回工作区主分支', async () => {
    const proj = '/test/wt-delivery-base'
    const intent = makeIntent({
      id: 'DB',
      status: 'todo',
      baseBranch: 'delivery/v0-14-0',
      linkedDeliveries: [{ id: 'D1', title: 'v0.14.0' }],
    })
    vi.mocked(listIntents).mockReturnValue([intent])
    vi.mocked(getIntent).mockReturnValue(intent)
    vi.mocked(getGitBranchMode).mockReturnValue('worktree')
    vi.mocked(getDefaultMainBranch).mockReturnValue('main')
    vi.mocked(getDelivery).mockReturnValue(makeDelivery({ id: 'D1', title: 'v0.14.0' }))
    vi.mocked(createWorktree).mockReturnValue({
      worktreePath: '/tmp/wt-DB',
      branchName: 'intent/DB',
    })

    const { hooks } = makeHooks()
    startWorkflow(proj, hooks, 1)
    await flush(proj)

    expect(createWorktree).toHaveBeenCalledWith(proj, 'DB', 'Test', 'delivery/v0-14-0')
    // 工作区主分支绝不作为创建基底出现 —— 它只是无交付时 baseBranch 的取值来源,
    // 不是 worktree 创建的第二个基线源。
    for (const call of vi.mocked(createWorktree).mock.calls) expect(call[3]).not.toBe('main')
    // 基线也是从同一个分支 fetch 的:新建位置与后续校验位置必须是同一个。
    expect(fetchRemoteBase).toHaveBeenCalledWith(proj, 'delivery/v0-14-0')
    const rt = vi.mocked(ensureRuntime).mock.results.at(-1)?.value as { effectiveCwd?: string }
    expect(rt.effectiveCwd).toBe('/tmp/wt-DB')
  })

  // 交付分支被推进后,已存在的 worktree 确凿落后 —— 无人值守路径同样不重建、不
  // merge,但也不再因此停工:落后的目录照样跑,分歧留到 PR 合并时处理。
  it('worktree: 已存在目录基线不符时照常启动,不重建也不合并', async () => {
    const proj = '/test/wt-stale-base'
    const intent = makeIntent({ id: 'ST', status: 'todo', baseBranch: 'delivery/v0-14-0' })
    vi.mocked(listIntents).mockReturnValue([intent])
    vi.mocked(getIntent).mockReturnValue(intent)
    vi.mocked(getGitBranchMode).mockReturnValue('worktree')
    vi.mocked(fetchRemoteBase).mockReturnValue('origin/delivery/v0-14-0')
    vi.mocked(worktreeExists).mockReturnValue(true)
    vi.mocked(worktreeContainsRef).mockReturnValue(false)
    vi.mocked(isWorktreeClean).mockReturnValue(true)
    vi.mocked(readWorktreeHead).mockReturnValue({ branch: 'intent/ST', head: 'abc1234' })

    const { hooks, runDevTurn } = makeHooks()
    startWorkflow(proj, hooks, 1)
    await flush(proj)

    // 目录被复用、回合照常发出:基线不符不再是这条路径上的拒绝理由。
    expect(runDevTurn).toHaveBeenCalled()
    const reasons = (listQueueDecisions(proj) as { intentId: string; rejectReason?: string }[])
      .filter((d) => d.intentId === 'ST')
      .map((d) => d.rejectReason ?? '')
      .join('\n')
    expect(reasons).not.toContain('worktree')
    // 目录仍以意图持久化的基准分支为根 —— 自动路径没有第二个基线源,也没借机改写它。
    for (const call of vi.mocked(createWorktree).mock.calls)
      expect(call[3]).toBe('delivery/v0-14-0')
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
    await flush(proj)

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
    await flush(proj)

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
    await flush(proj)

    const input = runDevTurn.mock.calls[0][0] as RunDevTurnInput
    expect(input.prompt).toBe('Test\n\nBody\n\n依赖需求:DEP-1')
    expect(input.systemInstruction).toBeUndefined()
    expect(input.userTurnPrefix).toBeUndefined()
    expect(input.prompt).not.toContain('Approved spec for this intent')
  })

  it('worktree: 端到端 develop→commit→PR 全针对 worktree 工作目录,base 为关联交付分支', async () => {
    const proj = '/test/wt-e2e'
    const intent = makeIntent({
      id: 'Z',
      status: 'todo',
      branchName: 'intent/Z',
      linkedDeliveries: [{ id: 'D1', title: 'Delivery α' }],
      // 关联就绪交付后,基准分支快照已在关联那一刻落成该交付分支。
      baseBranch: 'delivery/alpha',
    })
    vi.mocked(getGitBranchMode).mockReturnValue('worktree')
    vi.mocked(getDefaultMainBranch).mockReturnValue('main')
    vi.mocked(getDelivery).mockReturnValue(makeDelivery({ id: 'D1' }))
    vi.mocked(createWorktree).mockReturnValue({ worktreePath: '/tmp/wt-Z', branchName: 'intent/Z' })
    vi.mocked(getWorktreePath).mockReturnValue('/tmp/wt-Z')
    // Mutate status so the post-done pass stops re-picking the same intent.
    vi.mocked(updateStatus).mockImplementation((_id, status) => {
      intent.status = status
    })
    vi.mocked(listIntents).mockReturnValue([intent])
    vi.mocked(getIntent).mockReturnValue(intent)
    vi.mocked(judgeCompletion).mockResolvedValue({ verdict: 'done', reason: 'ok' })
    vi.mocked(commitAndPush).mockResolvedValue({ ok: true, committed: true })
    vi.mocked(createForgePr).mockResolvedValue({ ok: true, prId: '77', prUrl: 'http://x/pull/77' })
    vi.mocked(getRuntime).mockReturnValue(undefined)

    const { hooks, runDevTurn } = makeHooks()
    startWorkflow(proj, hooks, 1)
    await flush(proj)
    const launchedId = runDevTurn.mock.calls[0][0].sessionId as string

    await notifyTurnSettled(proj, launchedId, 'complete', 'Z')

    // Judge evidence + commit/push + PR all scoped to the worktree, not proj.
    expect(gitDiffStat).toHaveBeenCalledWith('/tmp/wt-Z')
    expect(gitRecentLog).toHaveBeenCalledWith('/tmp/wt-Z')
    expect(commitAndPush).toHaveBeenCalledWith('/tmp/wt-Z', expect.stringContaining('feat:'))
    // The base is the intent's persisted snapshot — the linked delivery's
    // branch — not the workspace mainline the worktree happens to know about.
    expect(createForgePr).toHaveBeenCalledWith(
      '/tmp/wt-Z',
      expect.any(String),
      expect.any(String),
      'intent/Z',
      'delivery/alpha',
      undefined,
    )
    expect(upsertIntentPr).toHaveBeenCalledWith({
      intentId: 'Z',
      deliveryId: 'D1',
      number: '77',
      status: 'reviewing',
      // `http://x/pull/77` names no known host ⇒ GitLab by the same fallback
      // `detectForge` uses. Its path holds no repo segment before `/pull/`, so
      // the repo stays unknown — the next upsert fills it in.
      forge: 'gitlab',
      repo: null,
      url: 'http://x/pull/77',
      headBranch: 'intent/Z',
      baseBranch: 'delivery/alpha',
    })
    expect(updateStatus).toHaveBeenCalledWith('Z', 'done')
    // `done` is written BEFORE the PR is created: no automatic path may produce
    // a PR for an intent that is still in progress.
    const doneCall = vi.mocked(updateStatus).mock.calls.findIndex(([, status]) => status === 'done')
    expect(vi.mocked(updateStatus).mock.invocationCallOrder[doneCall]).toBeLessThan(
      vi.mocked(createForgePr).mock.invocationCallOrder[0],
    )
    // The changelog records the automated PR creation exactly once, actor `automation`.
    const prLogs = vi.mocked(safeInsertIntentLog).mock.calls.filter(([, op]) => op === 'pr_created')
    expect(prLogs).toEqual([['Z', 'pr_created', '创建 PR #77', 'automation']])
  })

  it('worktree: explicit GitLab override uses the forge dispatcher and writes MR fields', async () => {
    const proj = '/test/wt-gitlab'
    const intent = makeIntent({
      id: 'GL',
      status: 'todo',
      branchName: 'intent/GL',
      linkedDeliveries: [{ id: 'D1', title: 'Delivery α' }],
      // 关联就绪交付后,基准分支快照已在关联那一刻落成该交付分支。
      baseBranch: 'delivery/alpha',
    })
    vi.mocked(getGitBranchMode).mockReturnValue('worktree')
    vi.mocked(getDefaultMainBranch).mockReturnValue('main')
    vi.mocked(getDelivery).mockReturnValue(makeDelivery({ id: 'D1' }))
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
    vi.mocked(getRuntime).mockReturnValue(undefined)

    const { hooks, runDevTurn } = makeHooks()
    startWorkflow(proj, hooks, 1)
    await flush(proj)
    const launchedId = runDevTurn.mock.calls[0][0].sessionId as string

    await notifyTurnSettled(proj, launchedId, 'complete', 'GL')

    expect(createForgePr).toHaveBeenCalledWith(
      '/tmp/wt-GL',
      expect.any(String),
      expect.any(String),
      'intent/GL',
      'delivery/alpha',
      'gitlab',
    )
    expect(upsertIntentPr).toHaveBeenCalledWith({
      intentId: 'GL',
      deliveryId: 'D1',
      number: '19',
      status: 'reviewing',
      forge: 'gitlab',
      repo: 'group/project',
      url: 'https://gitlab.example/group/project/-/merge_requests/19',
      headBranch: 'intent/GL',
      baseBranch: 'delivery/alpha',
    })
  })

  // ── The automatic PR target: resolvePrTarget decides base, including unlinked ─

  it('worktree: 未关联交付时置 done、向 intent.baseBranch 建 PR,并记 pr_created', async () => {
    const proj = '/test/wt-no-delivery'
    const intent = makeIntent({
      id: 'ND',
      status: 'todo',
      branchName: 'intent/ND',
      baseBranch: 'main',
    })
    vi.mocked(getGitBranchMode).mockReturnValue('worktree')
    vi.mocked(getDefaultMainBranch).mockReturnValue('main')
    vi.mocked(createWorktree).mockReturnValue({
      worktreePath: '/tmp/wt-ND',
      branchName: 'intent/ND',
    })
    vi.mocked(getWorktreePath).mockReturnValue('/tmp/wt-ND')
    vi.mocked(updateStatus).mockImplementation((_id, status) => {
      intent.status = status
    })
    vi.mocked(listIntents).mockReturnValue([intent])
    vi.mocked(getIntent).mockReturnValue(intent)
    vi.mocked(judgeCompletion).mockResolvedValue({ verdict: 'done', reason: 'ok' })
    vi.mocked(commitAndPush).mockResolvedValue({ ok: true, committed: true })
    vi.mocked(createForgePr).mockResolvedValue({ ok: true, prId: '88', prUrl: 'http://x/pull/88' })
    vi.mocked(getRuntime).mockReturnValue(undefined)

    const { hooks, runDevTurn } = makeHooks()
    startWorkflow(proj, hooks, 1)
    await flush(proj)
    const launchedId = runDevTurn.mock.calls[0][0].sessionId as string

    await notifyTurnSettled(proj, launchedId, 'complete', 'ND')

    // Unlinked + resolved baseBranch ⇒ mainline PR with null delivery_id.
    expect(commitAndPush).toHaveBeenCalledWith('/tmp/wt-ND', expect.stringContaining('feat:'))
    expect(updateStatus).toHaveBeenCalledWith('ND', 'done')
    expect(createForgePr).toHaveBeenCalledWith(
      '/tmp/wt-ND',
      expect.any(String),
      expect.any(String),
      'intent/ND',
      'main',
      undefined,
    )
    expect(upsertIntentPr).toHaveBeenCalledWith({
      intentId: 'ND',
      deliveryId: null,
      number: '88',
      status: 'reviewing',
      forge: 'gitlab',
      repo: null,
      url: 'http://x/pull/88',
      headBranch: 'intent/ND',
      baseBranch: 'main',
    })
    expect(hooks.createUserTodo).not.toHaveBeenCalled()
    expect(vi.mocked(safeInsertIntentLog).mock.calls).toEqual([
      ['ND', 'pr_created', '创建 PR #88', 'automation'],
    ])
    expect(
      vi
        .mocked(safeInsertIntentLog)
        .mock.calls.some(
          ([, op, summary]) => op === 'pr_skipped' && String(summary).includes('未关联交付'),
        ),
    ).toBe(false)
  })

  it('worktree: 关联交付分支未就绪时不建 PR,推一条说明原因的待办', async () => {
    const proj = '/test/wt-branch-not-ready'
    const intent = makeIntent({
      id: 'NR',
      status: 'todo',
      branchName: 'intent/NR',
      linkedDeliveries: [{ id: 'D1', title: 'Delivery α' }],
    })
    vi.mocked(getGitBranchMode).mockReturnValue('worktree')
    vi.mocked(getDefaultMainBranch).mockReturnValue('main')
    vi.mocked(getDelivery).mockReturnValue(makeDelivery({ id: 'D1', branchReady: false }))
    vi.mocked(createWorktree).mockReturnValue({
      worktreePath: '/tmp/wt-NR',
      branchName: 'intent/NR',
    })
    vi.mocked(getWorktreePath).mockReturnValue('/tmp/wt-NR')
    vi.mocked(updateStatus).mockImplementation((_id, status) => {
      intent.status = status
    })
    vi.mocked(listIntents).mockReturnValue([intent])
    vi.mocked(getIntent).mockReturnValue(intent)
    vi.mocked(judgeCompletion).mockResolvedValue({ verdict: 'done', reason: 'ok' })
    vi.mocked(commitAndPush).mockResolvedValue({ ok: true, committed: true })
    vi.mocked(getRuntime).mockReturnValue(undefined)

    const { hooks, runDevTurn } = makeHooks()
    startWorkflow(proj, hooks, 1)
    await flush(proj)
    const launchedId = runDevTurn.mock.calls[0][0].sessionId as string

    await notifyTurnSettled(proj, launchedId, 'complete', 'NR')

    expect(createForgePr).not.toHaveBeenCalled()
    expect(upsertIntentPr).not.toHaveBeenCalled()
    expect(hooks.createUserTodo).toHaveBeenCalledWith(
      expect.objectContaining({
        intentId: 'NR',
        reasonCode: 'pr_target_unavailable',
        title: expect.stringContaining('delivery.guard.branchNotReady'),
      }),
    )
    expect(vi.mocked(safeInsertIntentLog).mock.calls.some(([, op]) => op === 'pr_created')).toBe(
      false,
    )
  })

  it('worktree: 状态未真正写入 done 时(重读仍为 in_progress)不产生任何 PR', async () => {
    const proj = '/test/wt-not-done'
    const intent = makeIntent({
      id: 'IP',
      status: 'todo',
      branchName: 'intent/IP',
      linkedDeliveries: [{ id: 'D1', title: 'Delivery α' }],
      // 关联就绪交付后,基准分支快照已在关联那一刻落成该交付分支。
      baseBranch: 'delivery/alpha',
    })
    vi.mocked(getGitBranchMode).mockReturnValue('worktree')
    vi.mocked(getDefaultMainBranch).mockReturnValue('main')
    vi.mocked(getDelivery).mockReturnValue(makeDelivery({ id: 'D1' }))
    vi.mocked(createWorktree).mockReturnValue({
      worktreePath: '/tmp/wt-IP',
      branchName: 'intent/IP',
    })
    vi.mocked(getWorktreePath).mockReturnValue('/tmp/wt-IP')
    // The `done` write does not land (a concurrent write, a store rejection): the
    // re-read still says `in_progress`, so the PR step must not run at all.
    vi.mocked(updateStatus).mockImplementation((_id, status) => {
      intent.status = status === 'done' ? 'in_progress' : status
    })
    vi.mocked(listIntents).mockReturnValue([intent])
    vi.mocked(getIntent).mockReturnValue(intent)
    vi.mocked(judgeCompletion).mockResolvedValue({ verdict: 'done', reason: 'ok' })
    vi.mocked(commitAndPush).mockResolvedValue({ ok: true, committed: true })
    vi.mocked(getRuntime).mockReturnValue(undefined)

    const { hooks, runDevTurn } = makeHooks()
    startWorkflow(proj, hooks, 1)
    await flush(proj)
    const launchedId = runDevTurn.mock.calls[0][0].sessionId as string

    await notifyTurnSettled(proj, launchedId, 'complete', 'IP')

    expect(createForgePr).not.toHaveBeenCalled()
    expect(upsertIntentPr).not.toHaveBeenCalled()
    expect(hooks.createUserTodo).not.toHaveBeenCalled()
    expect(vi.mocked(safeInsertIntentLog).mock.calls.some(([, op]) => op.startsWith('pr_'))).toBe(
      false,
    )
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
    vi.mocked(getRuntime).mockReturnValue(undefined)

    const { hooks, runDevTurn } = makeHooks()
    startWorkflow(proj, hooks, 1)
    await flush(proj)
    const launchedId = runDevTurn.mock.calls[0][0].sessionId as string

    await notifyTurnSettled(proj, launchedId, 'complete', 'W')

    expect(createWorktree).not.toHaveBeenCalled()
    expect(gitDiffStat).toHaveBeenCalledWith(proj)
    expect(commitAndPush).toHaveBeenCalledWith(proj, expect.stringContaining('feat:'))
    expect(createForgePr).not.toHaveBeenCalled()
    expect(upsertIntentPr).not.toHaveBeenCalled()
    expect(updateStatus).toHaveBeenCalledWith('W', 'done')
    expect(vi.mocked(safeInsertIntentLog).mock.calls.some(([, op]) => op === 'pr_created')).toBe(
      false,
    )
  })

  it('worktree: PR 创建失败不写 PR 字段也不记 pr_created 日志', async () => {
    const proj = '/test/wt-pr-fail'
    const intent = makeIntent({
      id: 'F',
      status: 'todo',
      branchName: 'intent/F',
      linkedDeliveries: [{ id: 'D1', title: 'Delivery α' }],
      // 关联就绪交付后,基准分支快照已在关联那一刻落成该交付分支。
      baseBranch: 'delivery/alpha',
    })
    vi.mocked(getGitBranchMode).mockReturnValue('worktree')
    vi.mocked(getDefaultMainBranch).mockReturnValue('main')
    vi.mocked(getDelivery).mockReturnValue(makeDelivery({ id: 'D1' }))
    vi.mocked(createWorktree).mockReturnValue({ worktreePath: '/tmp/wt-F', branchName: 'intent/F' })
    vi.mocked(getWorktreePath).mockReturnValue('/tmp/wt-F')
    vi.mocked(updateStatus).mockImplementation((_id, status) => {
      intent.status = status
    })
    vi.mocked(listIntents).mockReturnValue([intent])
    vi.mocked(getIntent).mockReturnValue(intent)
    vi.mocked(judgeCompletion).mockResolvedValue({ verdict: 'done', reason: 'ok' })
    vi.mocked(commitAndPush).mockResolvedValue({ ok: true, committed: true })
    vi.mocked(createForgePr).mockResolvedValue({ ok: false, error: 'gh 未登录' })
    vi.mocked(getRuntime).mockReturnValue(undefined)

    const { hooks, runDevTurn } = makeHooks()
    startWorkflow(proj, hooks, 1)
    await flush(proj)
    const launchedId = runDevTurn.mock.calls[0][0].sessionId as string

    await notifyTurnSettled(proj, launchedId, 'complete', 'F')

    expect(upsertIntentPr).not.toHaveBeenCalled()
    expect(vi.mocked(safeInsertIntentLog).mock.calls.some(([, op]) => op === 'pr_created')).toBe(
      false,
    )
  })

  // ── Lint self-heal: exactly one repair turn, then the intent's own verdict ──

  it('a pre-commit lint block triggers ONE fix turn, then commits and completes', async () => {
    const proj = '/test/lint-heal'
    const intent = makeIntent({ id: 'L', status: 'todo' })
    vi.mocked(getGitBranchMode).mockReturnValue('current-branch')
    vi.mocked(updateStatus).mockImplementation((_id, status) => {
      intent.status = status
    })
    vi.mocked(listIntents).mockReturnValue([intent])
    vi.mocked(getIntent).mockReturnValue(intent)
    vi.mocked(judgeCompletion).mockResolvedValue({ verdict: 'done', reason: 'ok' })
    vi.mocked(getRuntime).mockReturnValue(undefined)
    vi.mocked(commitAndPush)
      .mockResolvedValueOnce({
        ok: false,
        committed: false,
        failure: 'commit-hook',
        error: 'eslint: 3 problems',
      })
      .mockResolvedValueOnce({ ok: true, committed: true })

    const { hooks, runDevTurn } = makeHooks()
    startWorkflow(proj, hooks, 1)
    await flush(proj)

    // One develop turn + exactly one repair turn, and the repair turn carries the
    // hook's own error text rather than a fresh instruction to commit.
    expect(runDevTurn).toHaveBeenCalledTimes(2)
    const fix = runDevTurn.mock.calls[1][0] as RunDevTurnInput
    expect(fix.prompt).toContain('eslint: 3 problems')
    expect(fix.prompt).toContain('无需自行 git commit')
    expect(commitAndPush).toHaveBeenCalledTimes(2)
    expect(updateStatus).toHaveBeenCalledWith('L', 'done')
  })

  it('a lint failure that survives the fix turn is ONE failed attempt, not a done intent', async () => {
    const proj = '/test/lint-heal-fail'
    const intent = makeIntent({ id: 'LF', status: 'todo' })
    vi.mocked(getGitBranchMode).mockReturnValue('current-branch')
    vi.mocked(listIntents).mockReturnValue([intent])
    vi.mocked(getIntent).mockReturnValue(intent)
    vi.mocked(judgeCompletion).mockResolvedValue({ verdict: 'done', reason: 'ok' })
    vi.mocked(getRuntime).mockReturnValue(undefined)
    vi.mocked(commitAndPush).mockResolvedValue({
      ok: false,
      committed: false,
      failure: 'commit-hook',
      error: 'still broken',
    })

    const { hooks, runDevTurn } = makeHooks()
    startWorkflow(proj, hooks, 1)
    await flush(proj)

    // Two commit attempts around a single repair turn — never a third.
    expect(commitAndPush).toHaveBeenCalledTimes(2)
    expect(runDevTurn).toHaveBeenCalledTimes(2)
    expect(updateStatus).not.toHaveBeenCalledWith('LF', 'done')
    const meta = getQueueIntentMetaById('LF')
    expect(meta.failureCount).toBe(1)
    expect(meta.parkReason).toBeNull()
  })

  // ── A human question is parked, never answered ──────────────────────────────

  it('an unanswered question parks the intent, raises one todo and never answers it', async () => {
    const proj = '/test/pending-question'
    const intent = makeIntent({ id: 'Q', status: 'todo' })
    vi.mocked(getGitBranchMode).mockReturnValue('current-branch')
    vi.mocked(listIntents).mockReturnValue([intent])
    vi.mocked(getIntent).mockReturnValue(intent)
    vi.mocked(getRuntime).mockReturnValue(undefined)

    const { hooks, runDevTurn } = makeHooks()
    runDevTurn.mockResolvedValue({
      outcome: 'complete',
      sessionId: 'real',
      lastMessage: 'need a decision',
      pendingQuestion: true,
    })

    startWorkflow(proj, hooks, 1)
    await flush(proj)

    expect(getQueueIntentMetaById('Q')).toMatchObject({
      parked: true,
      parkReason: 'needs_human_decision',
    })
    expect(hooks.createUserTodo).toHaveBeenCalledTimes(1)
    // The queue never continues over the question, and never marks it done.
    expect(judgeCompletion).not.toHaveBeenCalled()
    expect(updateStatus).not.toHaveBeenCalledWith('Q', 'done')
  })

  it('a checkpoint consensus may overrule the question and continue the same session', async () => {
    const proj = '/test/pending-question-overruled'
    const intent = makeIntent({ id: 'QC', status: 'todo' })
    vi.mocked(getGitBranchMode).mockReturnValue('current-branch')
    vi.mocked(listIntents).mockReturnValue([intent])
    vi.mocked(getIntent).mockReturnValue(intent)
    vi.mocked(getRuntime).mockReturnValue(undefined)
    vi.mocked(runCheckpointConsensus).mockResolvedValueOnce({
      votes: [],
      decision: 'continue',
      unanimous: true,
    } as never)

    const { hooks, runDevTurn } = makeHooks()
    runDevTurn
      .mockResolvedValueOnce({
        outcome: 'complete',
        sessionId: 'real',
        lastMessage: 'need a decision',
        pendingQuestion: true,
      })
      .mockResolvedValue({ outcome: 'complete', sessionId: 'real', lastMessage: 'ok' })

    startWorkflow(proj, hooks, 1)
    await flush(proj)

    // The overrule produced a plain `continue` turn on the SAME session; the
    // question itself was still never answered by the queue.
    expect(runDevTurn.mock.calls[1][0]).toMatchObject({ prompt: 'continue', sessionId: 'real' })
    expect(hooks.createUserTodo).not.toHaveBeenCalled()
  })

  // ── An unavailable judge is a tool fault, not a verdict ─────────────────────

  it('a judge that cannot run fails as judge_unavailable and never enters the stuck path', async () => {
    const proj = '/test/judge-unavailable'
    const intent = makeIntent({ id: 'JU', status: 'todo' })
    vi.mocked(getGitBranchMode).mockReturnValue('current-branch')
    vi.mocked(listIntents).mockReturnValue([intent])
    vi.mocked(getIntent).mockReturnValue(intent)
    vi.mocked(getRuntime).mockReturnValue(undefined)
    vi.mocked(judgeCompletion).mockRejectedValue(
      new JudgeUnavailableError("There's an issue with the selected model (deepseek-v4-flash)."),
    )

    const { hooks } = makeHooks()
    startWorkflow(proj, hooks, 1)
    await flush(proj)

    // Backed off under its OWN reason code — the provider misconfiguration never
    // reaches the human-decision machinery meant for a genuinely stuck intent.
    const meta = getQueueIntentMetaById('JU')
    expect(meta.failureCount).toBe(1)
    expect(runCheckpointConsensus).not.toHaveBeenCalled()
    expect(hooks.createUserTodo).not.toHaveBeenCalled()
    expect(updateStatus).not.toHaveBeenCalledWith('JU', 'done')
  })
})
