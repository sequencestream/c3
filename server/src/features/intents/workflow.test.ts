/**
 * Control-layer tests for the automation queue driver.
 *
 * What stays here after the action families moved out: `pickNext` selection
 * (dependency merge validation under both git branch modes, SDD approval
 * filtering), the `startDevelopment` manual handler, the public lifecycle API
 * (start/stop/pause/force-skip/unpark), in-flight run ownership, and the
 * queue-detail projection. The action families themselves are tested at
 * `queue-spec-actions.test.ts`, `queue-dev-actions.test.ts` and
 * `queue-outcome-actions.test.ts`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeIntentPrs } from './intent-pr-fixture.js'
import type { Intent } from '@ccc/shared/protocol'

// ---- Mocks (must be before imports) ----

vi.mock('./store.js', () => ({
  getIntent: vi.fn(),
  isStoreAvailable: vi.fn(() => true),
  listIntents: vi.fn(),
  safeInsertIntentLog: vi.fn(),
  setBranchName: vi.fn(),
  setLastWorkSession: vi.fn(),
  updateStatus: vi.fn(),
}))

/**
 * In-memory queue persistence. The driver treats the store as durable state, so
 * the fake keeps the same read-your-writes semantics without touching sqlite.
 */
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
    __queueState: { controls, metas, decisions },
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
  tryResolveAgentTarget: vi.fn(),
  tryResolveRoleAgentTarget: vi.fn(),
}))

vi.mock('../../kernel/agent/vendor-runtime.js', () => ({
  availableVendorSet: vi.fn(() => new Set(['claude', 'codex'])),
}))

vi.mock('../sessions/session-metadata-store.js', () => ({
  deleteByVendorId: vi.fn(),
  updateRealRowTitle: vi.fn(),
  upsertBoundRow: vi.fn(),
  upsertPendingRow: vi.fn(),
}))

vi.mock('../../kernel/agent/process/launcher.js', () => ({
  probeAll: vi.fn(() => []),
  isManagedVendor: (vendor: string) => vendor === 'claude' || vendor === 'codex',
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
  pathToName: vi.fn(() => 'test-proj'),
  workspaceNameFor: vi.fn(() => 'test-proj'),
}))

vi.mock('../../git.js', () => ({
  commitAndPush: vi.fn(),
  createForgePr: vi.fn(),
  gitDiffStat: vi.fn(),
  gitRecentLog: vi.fn(),
}))

// The park funnel is a side channel with its own store and its own tests; stub it
// here so these suites keep mocking persistence wholesale instead of reaching the
// real c3.db through the park transitions they exercise.
vi.mock('./funnel-store.js', () => ({
  MANUAL_UNPARK_REASON: 'manual_unpark',
  AUTO_UNPARK_REASON: 'auto_unpark',
  appendFunnelEvent: vi.fn(() => true),
}))

vi.mock('./judge.js', () => ({
  judgeCompletion: vi.fn(),
  JudgeUnavailableError: class JudgeUnavailableError extends Error {
    constructor(readonly detail: string) {
      super(`judge 不可用: ${detail}`)
      this.name = 'JudgeUnavailableError'
    }
  },
}))

vi.mock('./checkpoint-consensus.js', () => ({
  runCheckpointConsensus: vi.fn(),
}))

// ---- Imports ----

import {
  pickNext,
  startWorkflow,
  stopWorkflow,
  pauseWorkflow,
  unparkIntent,
  forceSkipIntent,
  getQueueDetail,
  getWorkflowStatus,
  markQueueDirty,
  isIntentDrivenByWorkflow,
  settleQueueForTests,
  resetWorkflowForTests,
} from './workflow.js'
import type { WorkflowHooks, DevTurnResult, RunDevTurnInput } from './workflow.js'
import { EventNormalizerRegistry } from '../../kernel/events/generic-event.js'
import { PR_LEGACY_EVENT_TYPE, normalizePrGenericEvent } from '../pr-events/tool-defs.js'
import { startDevelopment } from './index.js'

const workflowPrRegistry = new EventNormalizerRegistry()
workflowPrRegistry.register(PR_LEGACY_EVENT_TYPE, normalizePrGenericEvent)
import { listIntents, getIntent, updateStatus } from './store.js'
import {
  getDevSkill,
  getGitBranchMode,
  getDefaultMainBranch,
  getSddEnabled,
} from '../../kernel/config/index.js'
import {
  getDefaultAgentId,
  resolveSessionVendor,
  tryResolveRoleAgentTarget,
} from '../../kernel/agent-config/index.js'
import type { AgentConfig, VendorId } from '@ccc/shared/protocol'
import { createWorktree, fetchRemoteBase, readBranch } from './worktree.js'
import { commitAndPush, gitDiffStat, gitRecentLog } from '../../git.js'
import { judgeCompletion } from './judge.js'
import { runCheckpointConsensus } from './checkpoint-consensus.js'
import { ensureRuntime, getRuntime } from '../../runs.js'
import { hasWorkspace } from '../../state.js'
import { releaseDevLaunch, resetForTests as resetDevLinksForTests } from './dev-link.js'
import { upsertPendingRow } from '../sessions/session-metadata-store.js'
import {
  getQueueIntentMetaById,
  putQueueIntentMeta,
  resetQueueStoreForTests,
} from './queue-store.js'

// ---- Test-only types (mirrors the Handler shape without importing transport) ----

interface StartDevMsg {
  type: 'start_development'
  workspaceName: string
  intentId: string
}

// ---- Factory ----

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
  lastWorkSessionId: null,
  sessionActive: false,
  actionDescriptor: null,
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
    // The dependency sits on its OWN branch: the criterion asks whether its
    // output is on the candidate's base, and an unmerged feature branch is not.
    const dep = makeIntent({
      id: 'A',
      status: 'done',
      prs: fakeIntentPrs('reviewing'),
      branchName: 'intent/A',
    })
    const child = makeIntent({ id: 'B', dependsOn: ['A'] })
    vi.mocked(listIntents).mockReturnValue([dep, child])
    vi.mocked(getGitBranchMode).mockReturnValue('worktree')

    const result = pickNext('/test/proj')
    expect(result).toBeNull()
  })

  it('worktree: allows intents whose dep is done and merged', () => {
    const dep = makeIntent({ id: 'A', status: 'done', prs: fakeIntentPrs('merged') })
    const child = makeIntent({ id: 'B', dependsOn: ['A'] })
    vi.mocked(listIntents).mockReturnValue([dep, child])
    vi.mocked(getGitBranchMode).mockReturnValue('worktree')

    const result = pickNext('/test/proj')
    expect(result?.id).toBe('B')
  })

  it('current-branch: does not check prStatus (unmerged dep still passes)', () => {
    const dep = makeIntent({ id: 'A', status: 'done', prs: fakeIntentPrs('reviewing') })
    const child = makeIntent({ id: 'B', dependsOn: ['A'] })
    vi.mocked(listIntents).mockReturnValue([dep, child])
    vi.mocked(getGitBranchMode).mockReturnValue('current-branch')

    const result = pickNext('/test/proj')
    expect(result?.id).toBe('B')
  })

  it('worktree: all deps must be merged (one unmerged blocks)', () => {
    const depA = makeIntent({ id: 'A', status: 'done', prs: fakeIntentPrs('merged') })
    const depB = makeIntent({
      id: 'B',
      status: 'done',
      prs: fakeIntentPrs('reviewing'),
      branchName: 'intent/B',
    })
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
    const dep = makeIntent({ id: 'A', status: 'in_progress', prs: [], automate: false })
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

/** A concrete (non-group) agent target — what `default` resolves to unless a test
 *  points the role at a group. */
function agentTarget(id: string, vendor: VendorId = 'claude') {
  const agent = {
    id,
    vendor,
    configMode: 'system',
    displayName: id,
    config: { baseUrl: '', apiKey: '', model: '' },
  } as unknown as AgentConfig
  return { ok: true as const, target: { ref: id, agent, candidates: [agent], isGroup: false } }
}

describe('startDevelopment — manual start dep merge validation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetDevLinksForTests()
    vi.mocked(getSddEnabled).mockReturnValue(false)
    vi.mocked(getDefaultAgentId).mockReturnValue('default-agent')
    vi.mocked(resolveSessionVendor).mockReturnValue('claude')
    vi.mocked(tryResolveRoleAgentTarget).mockReturnValue(agentTarget('default-agent'))
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
      prs: fakeIntentPrs('reviewing'),
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
      workspaceName: 'test-proj',
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
    const dep = makeIntent({
      id: 'A',
      status: 'done',
      prs: fakeIntentPrs('reviewing'),
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
    vi.mocked(getGitBranchMode).mockReturnValue('current-branch')

    const { sent, conn } = makeConn()
    const ctx = makeCtx()

    const msg1: StartDevMsg = {
      type: 'start_development',
      workspaceName: 'test-proj',
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
    vi.mocked(tryResolveRoleAgentTarget).mockReturnValue(agentTarget('default-agent', 'codex'))

    const { conn } = makeConn()
    const ctx = makeCtx()

    await startDevelopment(
      ctx as unknown as Parameters<typeof startDevelopment>[0],
      conn as unknown as Parameters<typeof startDevelopment>[1],
      { type: 'start_development', workspaceName: 'test-proj', intentId: 'B' },
    )

    const pendingId = vi.mocked(ensureRuntime).mock.calls[0]?.[0]
    expect(pendingId).toMatch(/^pending:/)
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
      { type: 'start_development', workspaceName: 'test-proj', intentId: 'B' },
    )

    expect(upsertPendingRow).not.toHaveBeenCalled()
  })

  it('worktree: allows manual start when dep is done and merged', async () => {
    const dep = makeIntent({
      id: 'A',
      status: 'done',
      prs: fakeIntentPrs('merged'),
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

    const msg2: StartDevMsg = {
      type: 'start_development',
      workspaceName: 'test-proj',
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
      workspaceName: 'test-proj',
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
      workspaceName: 'test-proj',
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
      workspaceName: 'test-proj',
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
      workspaceName: 'test-proj',
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
        { type: 'start_development', workspaceName: 'test-proj', intentId: 'B' },
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
      'fetching-base-branch',
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
      'fetching-base-branch',
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
      'fetching-base-branch',
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

describe('automation controller — in-flight run ownership', () => {
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
    vi.mocked(getSddEnabled).mockReturnValue(false)
    vi.mocked(gitDiffStat).mockResolvedValue('')
    vi.mocked(gitRecentLog).mockResolvedValue('')
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
      normalizeEvent: (core) => workflowPrRegistry.normalize(core),
      publishEvent: vi.fn(),
      createUserTodo: vi.fn(),
      broadcastQueueDetail: vi.fn(),
    }
    return { hooks, runDevTurn }
  }

  // MSC-R1: the manual-vs-automation discriminator the session-end cleanup uses.
  // It now means "the kernel holds an in-flight run for this intent" — the only
  // window in which the queue, not the manual path, owns the session's cleanup.
  it('isIntentDrivenByWorkflow: true only while the kernel holds the run', async () => {
    const proj = '/test/disc'
    const intent = makeIntent({ id: 'D', status: 'todo', branchName: 'intent/D' })
    vi.mocked(getGitBranchMode).mockReturnValue('worktree')
    vi.mocked(getDefaultMainBranch).mockReturnValue('main')
    vi.mocked(createWorktree).mockReturnValue({ worktreePath: '/tmp/wt-D', branchName: 'intent/D' })
    vi.mocked(listIntents).mockReturnValue([intent])
    vi.mocked(getIntent).mockReturnValue(intent)
    vi.mocked(getRuntime).mockReturnValue(undefined)

    const { hooks, runDevTurn } = makeHooks()
    // Hold the dev turn open so the assertion lands mid-run.
    let releaseTurn: (() => void) | null = null
    runDevTurn.mockImplementation(
      () =>
        new Promise<DevTurnResult>((resolve) => {
          releaseTurn = () => resolve({ outcome: 'complete', sessionId: 'real-D', lastMessage: '' })
        }),
    )

    startWorkflow(proj, hooks, 1)
    // Await only the reconcile PASS — not the run it starts, which is held open.
    await markQueueDirty(proj)

    expect(isIntentDrivenByWorkflow(proj, 'D')).toBe(true)
    // …but any other intent, or a workspace with no controller, is "manual".
    expect(isIntentDrivenByWorkflow(proj, 'other')).toBe(false)
    expect(isIntentDrivenByWorkflow('/no/controller', 'D')).toBe(false)

    releaseTurn!()
    await flush(proj)
    // Once the run is over the queue no longer owns it.
    expect(isIntentDrivenByWorkflow(proj, 'D')).toBe(false)
  })
})

describe('queue driver — manual control', () => {
  const proj = '/test/queue-control'

  function hooksBag(): WorkflowHooks {
    return {
      runDevTurn: vi.fn((_input: RunDevTurnInput): Promise<DevTurnResult> =>
        Promise.resolve({ outcome: 'complete', sessionId: 'real', lastMessage: 'ok' }),
      ),
      launchSpecRun: vi.fn(() => Promise.resolve()),
      broadcastIntents: vi.fn(),
      emitStatus: vi.fn(),
      sessionExists: vi.fn(() => Promise.resolve(false)),
      isRunning: vi.fn(() => false),
      sessionStatus: vi.fn(() => null),
      normalizeEvent: (core) => workflowPrRegistry.normalize(core),
      publishEvent: vi.fn(),
      createUserTodo: vi.fn(),
      broadcastQueueDetail: vi.fn(),
    }
  }

  beforeEach(() => {
    vi.clearAllMocks()
    resetWorkflowForTests()
    resetQueueStoreForTests()
    const rows = [makeIntent({ id: 'A', title: 'A' })]
    vi.mocked(listIntents).mockReturnValue(rows)
    vi.mocked(getIntent).mockImplementation((id: string) => rows.find((r) => r.id === id) ?? null)
    vi.mocked(getGitBranchMode).mockReturnValue('current-branch')
    vi.mocked(getSddEnabled).mockReturnValue(false)
    vi.mocked(getRuntime).mockReturnValue(undefined)
    vi.mocked(gitDiffStat).mockResolvedValue('')
    vi.mocked(gitRecentLog).mockResolvedValue('')
    vi.mocked(judgeCompletion).mockResolvedValue({ verdict: 'stuck', reason: 'x' })
    vi.mocked(runCheckpointConsensus).mockResolvedValue(null)
  })

  it('pause launches nothing and preserves scheduling metadata', async () => {
    const hooks = hooksBag()
    startWorkflow(proj, hooks, 1)
    pauseWorkflow(proj)
    vi.mocked(hooks.runDevTurn).mockClear()
    await settleQueueForTests(proj)

    expect(hooks.runDevTurn).not.toHaveBeenCalled()
    expect(getWorkflowStatus(proj).state).toBe('paused')
  })

  it('force-skip removes an intent from selection without completing it', async () => {
    const hooks = hooksBag()
    startWorkflow(proj, hooks, 1)
    forceSkipIntent(proj, 'A', true)
    vi.mocked(hooks.runDevTurn).mockClear()
    await settleQueueForTests(proj)

    expect(hooks.runDevTurn).not.toHaveBeenCalled()
    // Never marked done — skipping is not completing.
    expect(vi.mocked(updateStatus).mock.calls.some(([, st]) => st === 'done')).toBe(false)
    expect(getQueueDetail(proj).items[0]).toMatchObject({
      forceSkipped: true,
      blockedReason: 'blocked_force_skipped',
    })
  })

  it('unpark clears the park and lets the next pass re-evaluate every gate', async () => {
    const hooks = hooksBag()
    startWorkflow(proj, hooks, 1)
    await settleQueueForTests(proj) // one stuck verdict → one failure

    const store = await import('./queue-store.js')
    store.putQueueIntentMeta(proj, {
      ...getQueueIntentMetaById('A'),
      parked: true,
      parkReason: 'judge_stuck',
      parkDetail: 'stuck',
    })
    expect(unparkIntent(proj, 'A')).toBe(true)
    expect(getQueueIntentMetaById('A')).toMatchObject({
      parked: false,
      parkReason: null,
      failureCount: 0,
    })
    // Unparking something that is not parked is reported, not silently accepted.
    expect(unparkIntent(proj, 'A')).toBe(false)
  })

  it('stop returns the queue to idle and a later start resumes from persisted facts', async () => {
    const hooks = hooksBag()
    startWorkflow(proj, hooks, 1)
    await settleQueueForTests(proj)
    stopWorkflow(proj)
    expect(getWorkflowStatus(proj).state).toBe('idle')

    startWorkflow(proj, hooks, 2)
    expect(getWorkflowStatus(proj).state).not.toBe('idle')
  })

  it('a lost settle event is recovered by the next pass', async () => {
    const hooks = hooksBag()
    vi.mocked(judgeCompletion).mockResolvedValue({ verdict: 'done', reason: 'ok' })
    vi.mocked(commitAndPush).mockResolvedValue({ ok: true, committed: true })
    startWorkflow(proj, hooks, 1)
    // No `notifyTurnSettled` is ever delivered — the pass alone must drive it.
    await settleQueueForTests(proj)
    expect(vi.mocked(updateStatus).mock.calls).toContainEqual(['A', 'done'])
  })
})

describe('queue driver — worktree dependency merge auto-recovery', () => {
  const proj = '/test/queue-worktree-recovery'

  function hooksBag(): WorkflowHooks {
    return {
      runDevTurn: vi.fn((_input: RunDevTurnInput): Promise<DevTurnResult> =>
        Promise.resolve({ outcome: 'complete', sessionId: 'real', lastMessage: 'ok' }),
      ),
      launchSpecRun: vi.fn(() => Promise.resolve()),
      broadcastIntents: vi.fn(),
      emitStatus: vi.fn(),
      sessionExists: vi.fn(() => Promise.resolve(false)),
      isRunning: vi.fn(() => false),
      sessionStatus: vi.fn(() => null),
      normalizeEvent: (core) => workflowPrRegistry.normalize(core),
      publishEvent: vi.fn(),
      createUserTodo: vi.fn(),
      broadcastQueueDetail: vi.fn(),
    }
  }

  beforeEach(() => {
    vi.clearAllMocks()
    resetWorkflowForTests()
    resetQueueStoreForTests()
    vi.mocked(getGitBranchMode).mockReturnValue('worktree')
    vi.mocked(getSddEnabled).mockReturnValue(false)
    vi.mocked(getDefaultMainBranch).mockReturnValue('main')
    vi.mocked(getRuntime).mockReturnValue(undefined)
    vi.mocked(gitDiffStat).mockResolvedValue('')
    vi.mocked(gitRecentLog).mockResolvedValue('')
    vi.mocked(judgeCompletion).mockResolvedValue({ verdict: 'stuck', reason: 'x' })
    vi.mocked(runCheckpointConsensus).mockResolvedValue(null)
  })

  it('auto-recovers the parked dependent once its dep PR merges, then re-runs every gate', async () => {
    const hooks = hooksBag()
    const dep = makeIntent({
      id: 'A',
      status: 'done',
      prs: fakeIntentPrs('reviewing'),
      branchName: 'intent/A',
      automate: false,
    })
    const child = makeIntent({ id: 'B', dependsOn: ['A'], priority: 'P0' })
    vi.mocked(listIntents).mockReturnValue([dep, child])
    vi.mocked(getIntent).mockImplementation((id: string) =>
      id === 'A' ? dep : id === 'B' ? child : null,
    )
    // The dependent was parked by the failure ladder while its dep PR was not yet merged.
    putQueueIntentMeta(proj, {
      ...getQueueIntentMetaById('B'),
      intentId: 'B',
      parked: true,
      parkReason: 'launch_failed',
      parkDetail: '依赖未就绪时连续失败',
      failureCount: 3,
      backoffUntil: Date.now() + 60_000,
    })

    startWorkflow(proj, hooks, 1)
    await settleQueueForTests(proj)

    // Dep PR not merged yet → the dependent stays parked and is never launched.
    expect(getQueueIntentMetaById('B')).toMatchObject({ parked: true })
    expect(hooks.runDevTurn).not.toHaveBeenCalled()
    expect(getQueueDetail(proj).items.find((r) => r.intentId === 'B')?.parked).toBe(true)

    // The dep PR merges; the next reconcile pass sees the refreshed fact.
    vi.mocked(listIntents).mockReturnValue([
      makeIntent({
        id: 'A',
        status: 'done',
        prs: fakeIntentPrs('merged'),
        branchName: 'intent/A',
        automate: false,
      }),
      child,
    ])
    await settleQueueForTests(proj)

    // The kernel auto-recovered the dependent — the same five fields a manual
    // unpark clears — and the queue page projection reflects it.
    expect(getQueueIntentMetaById('B')).toMatchObject({
      parked: false,
      parkReason: null,
      parkDetail: null,
      failureCount: 0,
      backoffUntil: null,
    })
    expect(getQueueDetail(proj).items.find((r) => r.intentId === 'B')?.parked).toBe(false)

    // The next pass re-runs EVERY gate from scratch: nothing blocks B now, so it
    // launches with the reset failure counter (a full retry budget again).
    expect(vi.mocked(hooks.runDevTurn).mock.calls.some(([i]) => i.intentId === 'B')).toBe(true)

    // Drain the run the launch started.
    await settleQueueForTests(proj)
  })
})
