/**
 * Queue action family — waiting, parking and the failure ladder.
 *
 * Asserts what a failure costs ONE intent and what it must never cost the rest
 * of the queue: one attempt per exception, exponential backoff, park on the
 * third consecutive failure, a decision row explaining every park, downstream of
 * a parked intent still blocked (park is not `done`), and unrelated intents
 * still flowing.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Intent } from '@ccc/shared/protocol'

// ---- Mocks (must be before imports) ----

vi.mock('./store.js', () => ({
  getIntent: vi.fn(),
  isStoreAvailable: vi.fn(() => true),
  listIntents: vi.fn(),
  machineApproveSpec: vi.fn(),
  safeInsertIntentLog: vi.fn(),
  setBranchName: vi.fn(),
  setLastWorkSession: vi.fn(),
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
  resolveWorkspaceRoot: vi.fn(() => '/test/proj'),
  pathToId: vi.fn(() => 'test-proj'),
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
vi.mock('./checkpoint-consensus.js', () => ({ runCheckpointConsensus: vi.fn() }))

// ---- Imports ----

import {
  getQueueDetail,
  resetWorkflowForTests,
  settleQueueForTests,
  startWorkflow,
} from './workflow.js'
import type { WorkflowHooks, DevTurnResult, RunDevTurnInput } from './workflow.js'
import { EventNormalizerRegistry } from '../../kernel/events/generic-event.js'
import { PR_LEGACY_EVENT_TYPE, normalizePrGenericEvent } from '../pr-events/tool-defs.js'
import { listIntents, getIntent, updateStatus } from './store.js'
import { getDevSkill, getGitBranchMode, getSddEnabled } from '../../kernel/config/index.js'
import { readBranch } from './worktree.js'
import { commitAndPush, gitDiffStat, gitRecentLog } from '../../git.js'
import { judgeCompletion } from './judge.js'
import { runCheckpointConsensus } from './checkpoint-consensus.js'
import { getRuntime } from '../../runs.js'
import {
  getQueueIntentMetaById,
  listQueueDecisionsForIntent,
  putQueueIntentMeta,
  resetQueueStoreForTests,
} from './queue-store.js'

const prRegistry = new EventNormalizerRegistry()
prRegistry.register(PR_LEGACY_EVENT_TYPE, normalizePrGenericEvent)

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

describe('queue outcome actions — failure isolation', () => {
  const proj = '/test/queue-driver'

  /** Two independent intents plus one that depends on the first. */
  function ledger(): Intent[] {
    return [
      makeIntent({ id: 'broken', title: 'Broken', priority: 'P0', createdAt: 1 }),
      makeIntent({ id: 'healthy', title: 'Healthy', priority: 'P1', createdAt: 2 }),
      makeIntent({
        id: 'downstream',
        title: 'Downstream',
        priority: 'P1',
        createdAt: 3,
        dependsOn: ['broken'],
      }),
    ]
  }

  function hooksBag(): { hooks: WorkflowHooks; runDevTurn: ReturnType<typeof vi.fn> } {
    const runDevTurn = vi.fn((_input: RunDevTurnInput): Promise<DevTurnResult> =>
      Promise.resolve({ outcome: 'complete', sessionId: 'real', lastMessage: 'ok' }),
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

  beforeEach(() => {
    vi.clearAllMocks()
    resetWorkflowForTests()
    resetQueueStoreForTests()
    const rows = ledger()
    vi.mocked(listIntents).mockReturnValue(rows)
    vi.mocked(getIntent).mockImplementation((id: string) => rows.find((r) => r.id === id) ?? null)
    vi.mocked(getGitBranchMode).mockReturnValue('current-branch')
    vi.mocked(getSddEnabled).mockReturnValue(false)
    vi.mocked(getDevSkill).mockReturnValue('')
    vi.mocked(readBranch).mockReturnValue('main')
    vi.mocked(getRuntime).mockReturnValue(undefined)
    vi.mocked(gitDiffStat).mockResolvedValue('')
    vi.mocked(gitRecentLog).mockResolvedValue('')
    vi.mocked(judgeCompletion).mockResolvedValue({ verdict: 'done', reason: 'ok' })
    vi.mocked(runCheckpointConsensus).mockResolvedValue(null)
    vi.mocked(commitAndPush).mockResolvedValue({ ok: true, committed: true })
  })

  it('a launch that throws costs ONE attempt and never stalls the queue', async () => {
    const { hooks, runDevTurn } = hooksBag()
    runDevTurn.mockImplementation((input: RunDevTurnInput) => {
      if (input.intentId === 'broken') return Promise.reject(new Error('spawn failed'))
      return Promise.resolve({ outcome: 'complete', sessionId: 'real', lastMessage: 'ok' })
    })

    startWorkflow(proj, hooks, 1)
    await settleQueueForTests(proj)

    const meta = getQueueIntentMetaById('broken')
    expect(meta.failureCount).toBe(1)
    expect(meta.parked).toBe(false)
    expect(meta.backoffUntil).not.toBeNull()
    // The queue kept going: the unrelated intent was developed to completion.
    expect(vi.mocked(updateStatus).mock.calls).toContainEqual(['healthy', 'done'])
    // The dependent intent was NOT started — a failed upstream is not a done one.
    expect(runDevTurn.mock.calls.some(([i]) => i.intentId === 'downstream')).toBe(false)
  })

  it('parks on the third consecutive failure, then auto-recovers once nothing blocks it', async () => {
    const { hooks, runDevTurn } = hooksBag()
    runDevTurn.mockImplementation((input: RunDevTurnInput) => {
      if (input.intentId === 'broken') return Promise.reject(new Error('spawn failed'))
      return Promise.resolve({ outcome: 'complete', sessionId: 'real', lastMessage: 'ok' })
    })
    startWorkflow(proj, hooks, 1)

    // Three attempts, each after its backoff window has lapsed.
    for (let i = 0; i < 3; i++) {
      const meta = getQueueIntentMetaById('broken')
      if (meta.backoffUntil) {
        // Expire the backoff deterministically instead of waiting on wall time.
        putQueueIntentMeta(proj, { ...meta, backoffUntil: Date.now() - 1, cooldownUntil: null })
      }
      await settleQueueForTests(proj)
    }

    // The third consecutive failure DID park the intent — the decision log proves
    // the ladder ran — but because `broken` is a failure-ladder park (`launch_failed`)
    // with no unsatisfied dependency, the very next pass auto-recovers it with the
    // same full retry budget a manual unpark grants.
    const parkRows = listQueueDecisionsForIntent('broken').filter((d) => d.action === 'park')
    expect(parkRows.length).toBeGreaterThanOrEqual(1)
    const unparkRows = listQueueDecisionsForIntent('broken').filter((d) => d.action === 'unpark')
    expect(unparkRows.length).toBeGreaterThanOrEqual(1)
    const recovered = getQueueIntentMetaById('broken')
    expect(recovered).toMatchObject({ parked: false, parkReason: null, failureCount: 0 })

    // Downstream of the still-not-done intent stays blocked; it must never launch.
    expect(runDevTurn.mock.calls.some(([i]) => i.intentId === 'downstream')).toBe(false)
    const detail = getQueueDetail(proj)
    expect(detail.items.find((r) => r.intentId === 'downstream')?.blockedReason).toBe(
      'blocked_dependency',
    )
    expect(detail.state).not.toBe('done')
  })

  it('backs off before it parks: the second failure is a backoff, not a park', async () => {
    const { hooks, runDevTurn } = hooksBag()
    runDevTurn.mockImplementation((input: RunDevTurnInput) =>
      input.intentId === 'broken'
        ? Promise.reject(new Error('spawn failed'))
        : Promise.resolve({ outcome: 'complete', sessionId: 'real', lastMessage: 'ok' }),
    )
    startWorkflow(proj, hooks, 1)

    for (let i = 0; i < 2; i++) {
      const meta = getQueueIntentMetaById('broken')
      if (meta.backoffUntil) {
        putQueueIntentMeta(proj, { ...meta, backoffUntil: Date.now() - 1, cooldownUntil: null })
      }
      await settleQueueForTests(proj)
    }

    const meta = getQueueIntentMetaById('broken')
    expect(meta.failureCount).toBe(2)
    expect(meta.parked).toBe(false)
    expect(meta.backoffUntil).not.toBeNull()
  })

  it('records a decision row explaining every park', async () => {
    const { hooks, runDevTurn } = hooksBag()
    runDevTurn.mockImplementation((input: RunDevTurnInput) =>
      input.intentId === 'broken'
        ? Promise.reject(new Error('spawn failed'))
        : Promise.resolve({ outcome: 'complete', sessionId: 'real', lastMessage: 'ok' }),
    )
    startWorkflow(proj, hooks, 1)
    await settleQueueForTests(proj)

    const rows = listQueueDecisionsForIntent('broken')
    expect(rows.length).toBeGreaterThan(0)
    expect(rows[0]).toMatchObject({ intentId: 'broken', rejectReason: expect.any(String) })
  })

  it('a run that settles without progress does not clear an intent that never failed', async () => {
    const { hooks } = hooksBag()
    startWorkflow(proj, hooks, 1)
    await settleQueueForTests(proj)

    // A successful run leaves the zero-value metadata untouched rather than
    // writing a redundant row for every completion.
    expect(getQueueIntentMetaById('healthy')).toMatchObject({
      failureCount: 0,
      backoffUntil: null,
      parked: false,
    })
  })
})
