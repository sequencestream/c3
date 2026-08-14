import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeIntentPrs } from './intent-pr-fixture.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Intent, SpecLaunchStage } from '@ccc/shared/protocol'
import { resetDbForTests } from '../../kernel/infra/db.js'
import {
  addWorkspace,
  pathToName,
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
import {
  evaluateIntentDependencyGate,
  prepareSpecLaunch,
  toDependencyGateFact,
} from './dependency-gate.js'
import { reconcileQueue } from '../../kernel/queue/reconcile.js'
import { deriveIntentPrAggregate } from '@ccc/shared'
import type { QueueIntentFact } from '../../kernel/queue/types.js'
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
    workspaceName: 'w',
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
    baseBranch: 'main',
    baseBranchFallback: false,
    prs: [],
    linkedDeliveries: [],
    specPath: null,
    specStatus: 'raw',
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
    sessionActive: false,
    actionDescriptor: null,
    ...overrides,
  }
}

/**
 * The adapter's own responsibility: reduce ledger rows into gate facts and hand
 * them to the shared criterion. The criterion's three states are proven in
 * `shared/src/dependency-gate-model.test.ts`; what is checked here is that the
 * REDUCTION is faithful — a wrong `prs` → `prAggregate` mapping would silently
 * change every verdict.
 */
/** `queue-ledger.ts#toFact` 的等价投影,只保留一致性断言需要的字段。 */
function toQueueFact(r: Intent): QueueIntentFact {
  const gate = toDependencyGateFact(r)
  return {
    id: r.id,
    title: r.title,
    status: r.status,
    priority: r.priority,
    automate: r.automate,
    dependsOn: r.dependsOn,
    specStatus: r.specStatus,
    effectiveSpecMode: r.effectiveSpecMode,
    prStatus: deriveIntentPrAggregate(r.prs),
    branchName: gate.branchName,
    deliveryIds: gate.deliveryIds,
    prStatusByDelivery: gate.prStatusByDelivery,
    lastWorkSessionId: null,
    createdAt: r.createdAt,
    specPath: null,
    specSessionId: null,
    specReviewSessionId: null,
    specFingerprint: null,
    specReviewVerdict: null,
    specReviewFingerprint: null,
    specReviewReworkRounds: 0,
    specReviewMachineApprovalBlocked: false,
  }
}

describe('evaluateIntentDependencyGate (适配层归约)', () => {
  const gate = (dependencies: Intent[]): ReturnType<typeof evaluateIntentDependencyGate> =>
    evaluateIntentDependencyGate({
      workspacePath: '/nonexistent',
      dependsOn: ['dep'],
      sessionDeliveryId: null,
      intents: dependencies,
      deliveries: [],
      gitBranchMode: 'worktree',
      defaultMainBranch: 'main',
    })

  it('covers missing, unfinished, merged, branchless, mainline, and unmerged feature dependencies', () => {
    expect(gate([]).blocked).toBe(false)
    expect(gate([dep({ status: 'todo' })])).toMatchObject({ blocked: true, reason: 'not_done' })
    expect(gate([dep({ prs: fakeIntentPrs('merged') })]).blocked).toBe(false)
    expect(gate([dep({ branchName: null })]).blocked).toBe(false)
    expect(gate([dep({ branchName: 'origin/main' })]).blocked).toBe(false)
    expect(gate([dep()])).toMatchObject({
      blocked: true,
      reason: 'not_on_mainline',
      dependency: { id: 'dep' },
    })
  })
})

/**
 * 「两条路径结论一致」不是一句承诺,而是一条可执行的断言:同一组事实分别喂给
 * 手工路径的适配层和队列内核,两边必须给出同一个「放行 / 阻塞」。
 *
 * 这是本次变更的核心验收 —— 改动之前,这两条路径持有**不同的规则**(队列只看聚合
 * PR 是否 merged,手工路径还接受「依赖分支即主线」),对同一批事实可以给出相反结论。
 */
describe('两条路径结论一致', () => {
  /** 覆盖旧判据全部分支的事实集:各自应当放行还是阻塞。 */
  const CASES: { name: string; dep: Intent; blocked: boolean }[] = [
    { name: '依赖未完成', dep: dep({ status: 'todo' }), blocked: true },
    { name: '聚合 PR 已合入', dep: dep({ prs: fakeIntentPrs('merged') }), blocked: false },
    { name: '依赖分支即主线', dep: dep({ branchName: 'main' }), blocked: false },
    { name: '依赖无分支', dep: dep({ branchName: null }), blocked: false },
    {
      name: '分支非主线且 PR 未合入',
      dep: dep({ prs: fakeIntentPrs('reviewing') }),
      blocked: true,
    },
  ]

  it.each(CASES)('$name', ({ dep: dependency, blocked }) => {
    const child: Intent = dep({ id: 'child', status: 'todo', dependsOn: ['dep'], branchName: null })

    // 手工路径:适配层归约 → 共享判据。
    const manual = evaluateIntentDependencyGate({
      workspacePath: '/nonexistent',
      dependsOn: child.dependsOn,
      sessionDeliveryId: null,
      intents: [dependency, child],
      deliveries: [],
      gitBranchMode: 'worktree',
      defaultMainBranch: 'main',
    })

    // 队列路径:同一组事实经内核事实投影 → 同一份共享判据。
    const queue = reconcileQueue({
      now: 1_800_000_000_000,
      tickId: 'consistency',
      workspacePath: '/nonexistent',
      control: { state: 'running', startedAt: 0, forceSkipped: [] },
      snapshotOk: true,
      intents: [
        { ...toQueueFact(dependency), automate: false },
        { ...toQueueFact(child), automate: true },
      ],
      runs: [],
      meta: {},
      inFlight: [],
      gitBranchMode: 'worktree',
      defaultMainBranch: 'main',
      deliveries: [],
      sddEnabled: false,
      machineApprovalEnabled: false,
      automationConcurrency: 1,
      specRuns: [],
      specInFlight: [],
    })
    const queueBlocked = queue.decisions
      .find((d) => d.intentId === 'child')!
      .reason.startsWith('blocked_dependency')

    expect(manual.blocked).toBe(blocked)
    expect(queueBlocked).toBe(blocked)
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
    proj = resolveWorkspaceRoot(pathToName(dir)!)!
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

    expect(result).toMatchObject({
      blocked: true,
      verdict: {
        reason: 'not_on_mainline',
        dependency: { id: dependency.id, title: dependency.title },
      },
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
