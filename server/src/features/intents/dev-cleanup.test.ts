/**
 * Manual Start-Work session-end Git/PR cleanup tests (MSC-R2…R6).
 *
 * The cleanup is fully dependency-injected, so every branch-mode / success /
 * skip / failure path is exercised with mocks — no real git tree, db, or wire.
 */
import { describe, expect, it, vi } from 'vitest'
import { fakeIntentPrs } from './intent-pr-fixture.js'
import type { Intent } from '@ccc/shared/protocol'
import { runManualDevCleanup, type DevCleanupDeps } from './dev-cleanup.js'
import type { PrTargetResolution } from './pr-target.js'
import { EventNormalizerRegistry } from '../../kernel/events/generic-event.js'
import {
  PR_EVENT_TYPES,
  PR_LEGACY_EVENT_TYPE,
  normalizePrGenericEvent,
  projectPrOperationEvent,
} from '../pr-events/tool-defs.js'

const prRegistry = new EventNormalizerRegistry()
for (const t of PR_EVENT_TYPES) prRegistry.register(t, normalizePrGenericEvent)
prRegistry.register(PR_LEGACY_EVENT_TYPE, normalizePrGenericEvent)

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
    // The PR half of the cleanup only runs for a `done` intent, so the default
    // fixture is the state that exercises it; the not-done skip has its own test.
    status: 'done',
    dependsOn: [],
    dependsOnTypes: {},
    lastWorkSessionId: 'sess-1',
    automate: false,
    createdAt: 1,
    updatedAt: 1,
    completedAt: null,
    runStatus: 'idle',
    branchName: 'intent/i1-add-feature',
    latestCommitHash: null,
    baseBranch: 'main',
    baseBranchFallback: false,
    prs: [],
    linkedDeliveries: [],
    specPath: null,
    // 与迁移回填同口径:已批准→approved;有 spec 路径但未批准→pending;其余→raw。
    specStatus: over.specApproved ? 'approved' : over.specPath ? 'pending' : 'raw',
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
    ...over,
  }
}

interface Harness {
  deps: DevCleanupDeps
  intent: Intent
  mocks: {
    hasCommittableChanges: ReturnType<typeof vi.fn>
    commitAndPush: ReturnType<typeof vi.fn>
    createForgePr: ReturnType<typeof vi.fn>
    getCurrentBranch: ReturnType<typeof vi.fn>
    getHeadCommit: ReturnType<typeof vi.fn>
    setBranchName: ReturnType<typeof vi.fn>
    setLatestCommitHash: ReturnType<typeof vi.fn>
    upsertIntentPr: ReturnType<typeof vi.fn>
    safeInsertIntentLog: ReturnType<typeof vi.fn>
    cancelEventsForIntent: ReturnType<typeof vi.fn>
    pushFailureEvent: ReturnType<typeof vi.fn>
    broadcastIntents: ReturnType<typeof vi.fn>
    broadcastWaitUserEvents: ReturnType<typeof vi.fn>
    publishEvent: ReturnType<typeof vi.fn>
    resolvePrTarget: ReturnType<typeof vi.fn>
  }
}

/** The default target: one linked delivery whose branch is ready. */
const DELIVERY_TARGET: PrTargetResolution = {
  ok: true,
  deliveryId: 'D1',
  baseBranch: 'delivery/alpha',
}

function harness(
  opts: {
    mode?: 'worktree' | 'current-branch'
    mainBranch?: string
    currentBranch?: string
    forgeOverride?: 'github' | 'gitlab'
    intent?: Intent
    prTarget?: PrTargetResolution
  } = {},
): Harness {
  const intent = opts.intent ?? makeIntent()
  const mocks = {
    hasCommittableChanges: vi.fn().mockResolvedValue(true),
    commitAndPush: vi.fn().mockResolvedValue({ ok: true, committed: true }),
    createForgePr: vi.fn().mockResolvedValue({ ok: true, prId: '42', prUrl: 'https://h/pull/42' }),
    getCurrentBranch: vi.fn().mockResolvedValue(opts.currentBranch ?? 'intent/i1-add-feature'),
    getHeadCommit: vi.fn().mockResolvedValue('deadbeef'),
    setBranchName: vi.fn(),
    setLatestCommitHash: vi.fn(),
    upsertIntentPr: vi.fn(),
    safeInsertIntentLog: vi.fn(),
    cancelEventsForIntent: vi.fn(),
    pushFailureEvent: vi.fn(),
    broadcastIntents: vi.fn(),
    broadcastWaitUserEvents: vi.fn(),
    publishEvent: vi.fn(),
    resolvePrTarget: vi.fn(() => opts.prTarget ?? DELIVERY_TARGET),
  }
  const deps: DevCleanupDeps = {
    getGitBranchMode: () => opts.mode ?? 'worktree',
    getDefaultMainBranch: () => opts.mainBranch ?? 'main',
    getForgeOverride: () => opts.forgeOverride,
    gitCwd: () => '/abs/cwd',
    hasCommittableChanges: mocks.hasCommittableChanges,
    getCurrentBranch: mocks.getCurrentBranch,
    getHeadCommit: mocks.getHeadCommit,
    commitAndPush: mocks.commitAndPush,
    createForgePr: mocks.createForgePr,
    getIntent: () => intent,
    resolvePrTarget: mocks.resolvePrTarget as unknown as DevCleanupDeps['resolvePrTarget'],
    setBranchName: mocks.setBranchName,
    setLatestCommitHash: mocks.setLatestCommitHash,
    upsertIntentPr: mocks.upsertIntentPr,
    safeInsertIntentLog: mocks.safeInsertIntentLog,
    cancelEventsForIntent: mocks.cancelEventsForIntent,
    pushFailureEvent: mocks.pushFailureEvent,
    broadcastIntents: mocks.broadcastIntents,
    broadcastWaitUserEvents: mocks.broadcastWaitUserEvents,
    normalizeEvent: (core) => prRegistry.normalize(core),
    publishEvent: mocks.publishEvent,
  }
  return { deps, intent, mocks }
}

describe('runManualDevCleanup', () => {
  // ── MSC-R2: worktree happy path — PR toward the linked delivery's branch ──
  it('worktree with changes: commits, pushes, opens a PR toward the delivery branch, writes back all fields', async () => {
    const h = harness({ mode: 'worktree' })
    const out = await runManualDevCleanup('I1', WS, h.deps)

    expect(out).toEqual({ kind: 'success', createdPr: true })
    expect(h.mocks.commitAndPush).toHaveBeenCalledWith('/abs/cwd', 'feat: Add feature')
    expect(h.mocks.setBranchName).toHaveBeenCalledWith('I1', 'intent/i1-add-feature')
    expect(h.mocks.setLatestCommitHash).toHaveBeenCalledWith('I1', 'deadbeef')
    // The base is the RESOLVED delivery branch — the workspace mainline is never
    // consulted for a PR base on this path.
    expect(h.mocks.createForgePr).toHaveBeenCalledWith(
      '/abs/cwd',
      expect.any(String),
      expect.any(String),
      'intent/i1-add-feature',
      'delivery/alpha',
      undefined,
    )
    expect(h.mocks.upsertIntentPr).toHaveBeenCalledWith({
      intentId: 'I1',
      deliveryId: 'D1',
      number: '42',
      status: 'reviewing',
      // `https://h/pull/42` names no known host ⇒ GitLab by the same fallback
      // `detectForge` uses. Its path holds no repo segment before `/pull/`, so
      // the repo stays unknown — the next upsert fills it in.
      forge: 'gitlab',
      repo: null,
      url: 'https://h/pull/42',
      headBranch: 'intent/i1-add-feature',
      baseBranch: 'delivery/alpha',
    })
    expect(h.mocks.pushFailureEvent).not.toHaveBeenCalled()
    // The changelog records the first PR association exactly once, actor `automation`.
    expect(h.mocks.safeInsertIntentLog.mock.calls).toEqual([
      ['I1', 'pr_created', '创建 PR #42', 'automation'],
    ])
  })

  // ── done gate: a session that ends mid-development is a NORMAL skip ──
  it('intent not done: commits, pushes and writes back fields, but creates no PR and does not fail', async () => {
    const h = harness({ mode: 'worktree', intent: makeIntent({ status: 'in_progress' }) })
    const out = await runManualDevCleanup('I1', WS, h.deps)

    expect(out).toEqual({ kind: 'success', createdPr: false })
    expect(h.mocks.commitAndPush).toHaveBeenCalledWith('/abs/cwd', 'feat: Add feature')
    expect(h.mocks.setBranchName).toHaveBeenCalledWith('I1', 'intent/i1-add-feature')
    expect(h.mocks.setLatestCommitHash).toHaveBeenCalledWith('I1', 'deadbeef')
    // No target is even resolved, let alone a PR created — and nothing failed.
    expect(h.mocks.resolvePrTarget).not.toHaveBeenCalled()
    expect(h.mocks.createForgePr).not.toHaveBeenCalled()
    expect(h.mocks.upsertIntentPr).not.toHaveBeenCalled()
    expect(h.mocks.pushFailureEvent).not.toHaveBeenCalled()
    expect(h.mocks.publishEvent).not.toHaveBeenCalled()
    expect(h.mocks.safeInsertIntentLog).not.toHaveBeenCalled()
  })

  // ── no delivery linked: no PR at all, and never one against the mainline ──
  it('done without a linked delivery: skips the PR with a visible log, never files against main', async () => {
    const h = harness({
      mode: 'worktree',
      prTarget: { ok: true, deliveryId: null, baseBranch: 'main' },
    })
    const out = await runManualDevCleanup('I1', WS, h.deps)

    expect(out).toEqual({ kind: 'success', createdPr: false })
    expect(h.mocks.commitAndPush).toHaveBeenCalled()
    expect(h.mocks.setLatestCommitHash).toHaveBeenCalledWith('I1', 'deadbeef')
    expect(h.mocks.createForgePr).not.toHaveBeenCalled()
    expect(h.mocks.upsertIntentPr).not.toHaveBeenCalled()
    expect(h.mocks.pushFailureEvent).not.toHaveBeenCalled()
    expect(h.mocks.publishEvent).not.toHaveBeenCalled()
    expect(h.mocks.safeInsertIntentLog.mock.calls).toEqual([
      ['I1', 'pr_skipped', '未关联交付,未创建 PR', 'automation'],
    ])
  })

  // ── target unresolvable: no PR, no mainline fallback, one workbench todo ──
  it('done with an unready delivery branch: no PR and a todo naming the reason', async () => {
    const h = harness({
      mode: 'worktree',
      prTarget: { ok: false, code: 'delivery.guard.branchNotReady' },
    })
    const out = await runManualDevCleanup('I1', WS, h.deps)

    expect(out).toMatchObject({ kind: 'failed', code: 'prTargetUnavailable' })
    expect(h.mocks.createForgePr).not.toHaveBeenCalled()
    expect(h.mocks.upsertIntentPr).not.toHaveBeenCalled()
    expect(h.mocks.publishEvent).not.toHaveBeenCalled()
    expect(h.mocks.pushFailureEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        intentId: 'I1',
        code: 'intent.gitCleanupPrTargetUnavailable',
        params: { detail: expect.stringContaining('delivery.guard.branchNotReady') },
      }),
    )
  })

  it('explicit GitLab override creates an MR through the forge dispatcher and writes its fields', async () => {
    const h = harness({ mode: 'worktree', forgeOverride: 'gitlab' })
    h.mocks.createForgePr.mockResolvedValue({
      ok: true,
      prId: '19',
      prUrl: 'https://gitlab.example/group/project/-/merge_requests/19',
    })

    const out = await runManualDevCleanup('I1', WS, h.deps)

    expect(out).toEqual({ kind: 'success', createdPr: true })
    expect(h.mocks.createForgePr).toHaveBeenCalledWith(
      '/abs/cwd',
      expect.any(String),
      expect.any(String),
      'intent/i1-add-feature',
      'delivery/alpha',
      'gitlab',
    )
    expect(h.mocks.upsertIntentPr).toHaveBeenCalledWith({
      intentId: 'I1',
      deliveryId: 'D1',
      number: '19',
      status: 'reviewing',
      forge: 'gitlab',
      repo: 'group/project',
      url: 'https://gitlab.example/group/project/-/merge_requests/19',
      headBranch: 'intent/i1-add-feature',
      baseBranch: 'delivery/alpha',
    })
  })

  // ── MSC-R3: current-branch, not on main → same cleanup ──
  it('current-branch off main: runs the same commit/push/PR cleanup', async () => {
    const h = harness({ mode: 'current-branch', mainBranch: 'main', currentBranch: 'feature/x' })
    const out = await runManualDevCleanup('I1', WS, h.deps)

    expect(out).toEqual({ kind: 'success', createdPr: true })
    expect(h.mocks.commitAndPush).toHaveBeenCalled()
    expect(h.mocks.createForgePr).toHaveBeenCalled()
  })

  // ── MSC-R3: current-branch on the main branch → success skip, no actions ──
  it('current-branch on main: skips cleanup with no commit/push/PR and no failure event', async () => {
    const h = harness({ mode: 'current-branch', mainBranch: 'main', currentBranch: 'origin/main' })
    const out = await runManualDevCleanup('I1', WS, h.deps)

    expect(out).toEqual({ kind: 'skipped' })
    expect(h.mocks.commitAndPush).not.toHaveBeenCalled()
    expect(h.mocks.createForgePr).not.toHaveBeenCalled()
    expect(h.mocks.upsertIntentPr).not.toHaveBeenCalled()
    expect(h.mocks.pushFailureEvent).not.toHaveBeenCalled()
    expect(h.mocks.safeInsertIntentLog).not.toHaveBeenCalled()
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
    expect(h.mocks.upsertIntentPr).not.toHaveBeenCalled()
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
    expect(h.mocks.createForgePr).not.toHaveBeenCalled()
    expect(h.mocks.upsertIntentPr).not.toHaveBeenCalled()
    expect(h.mocks.setLatestCommitHash).not.toHaveBeenCalled()
  })

  // ── MSC-R4 ③: gh unavailable / not logged in ──
  it('gh unavailable: fails with ghUnavailable; honest partial keeps the pushed commit hash', async () => {
    const h = harness({ mode: 'worktree' })
    h.mocks.createForgePr.mockResolvedValue({
      ok: false,
      unavailable: true,
      error: 'gh CLI 未安装',
    })
    const out = await runManualDevCleanup('I1', WS, h.deps)

    expect(out).toEqual({ kind: 'failed', code: 'ghUnavailable', detail: 'gh CLI 未安装' })
    expect(h.mocks.pushFailureEvent).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'intent.gitCleanupGhUnavailable' }),
    )
    // Commit + push succeeded → honest write-back of hash; PR fields stay empty.
    expect(h.mocks.setLatestCommitHash).toHaveBeenCalledWith('I1', 'deadbeef')
    expect(h.mocks.upsertIntentPr).not.toHaveBeenCalled()
  })

  // ── MSC-R4 ④: PR create failure (gh present) ──
  it('PR creation failure: fails with prFailed; commit hash recorded, PR fields empty', async () => {
    const h = harness({ mode: 'worktree' })
    h.mocks.createForgePr.mockResolvedValue({ ok: false, error: 'base branch not found' })
    const out = await runManualDevCleanup('I1', WS, h.deps)

    expect(out).toEqual({ kind: 'failed', code: 'prFailed', detail: 'base branch not found' })
    expect(h.mocks.pushFailureEvent).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'intent.gitCleanupPrFailed' }),
    )
    expect(h.mocks.setLatestCommitHash).toHaveBeenCalledWith('I1', 'deadbeef')
    expect(h.mocks.upsertIntentPr).not.toHaveBeenCalled()
    expect(h.mocks.safeInsertIntentLog).not.toHaveBeenCalled()
  })

  // ── MSC-R6: idempotent re-cleanup when a PR already exists ──
  it('existing PR with new changes: commits/pushes and refreshes hash, does NOT re-create the PR', async () => {
    const h = harness({
      mode: 'worktree',
      intent: makeIntent({ prs: fakeIntentPrs('reviewing') }),
    })
    const out = await runManualDevCleanup('I1', WS, h.deps)

    expect(out).toEqual({ kind: 'success', createdPr: false })
    expect(h.mocks.commitAndPush).toHaveBeenCalled()
    expect(h.mocks.setLatestCommitHash).toHaveBeenCalledWith('I1', 'deadbeef')
    expect(h.mocks.createForgePr).not.toHaveBeenCalled()
    expect(h.mocks.upsertIntentPr).not.toHaveBeenCalled()
    expect(h.mocks.safeInsertIntentLog).not.toHaveBeenCalled()
  })

  // Clears stale cleanup todos before each real attempt (self-heal on re-run).
  it('cancels prior cleanup todos for the intent before re-attempting', async () => {
    const h = harness({ mode: 'worktree' })
    await runManualDevCleanup('I1', WS, h.deps)
    expect(h.mocks.cancelEventsForIntent).toHaveBeenCalledWith('I1')
  })

  // ── publishEvent: success path publishes create event ──
  it('publishes pr:operation create event after successful PR creation', async () => {
    const h = harness({ mode: 'worktree' })
    const out = await runManualDevCleanup('I1', WS, h.deps, 'sess-1')

    expect(out).toEqual({ kind: 'success', createdPr: true })
    expect(h.mocks.publishEvent).toHaveBeenCalledTimes(1)
    const envelope = h.mocks.publishEvent.mock.calls[0][0]
    expect(envelope).toMatchObject({
      workspacePath: WS,
      sessionId: 'sess-1',
      event: { type: 'pr:create' },
    })
    expect(projectPrOperationEvent(envelope.event)).toEqual({
      operation: 'create',
      result: 'success',
      pr: { url: 'https://h/pull/42' },
      // The cleanup resolved a delivery → the merge target is that delivery's
      // branch, and the event says so explicitly rather than leaving the
      // subscriber to infer it.
      ref: {
        head: 'intent/i1-add-feature',
        base: 'delivery/alpha',
        baseBranch: 'delivery/alpha',
        baseTarget: 'delivery-branch',
      },
      association: { intentId: 'I1', deliveryId: 'D1' },
    })
  })

  // ── publishEvent: idempotent re-cleanup does NOT publish ──
  it('does NOT publish pr:operation create event on idempotent re-cleanup (PR already exists)', async () => {
    const h = harness({
      mode: 'worktree',
      intent: makeIntent({ prs: fakeIntentPrs('reviewing') }),
    })
    const out = await runManualDevCleanup('I1', WS, h.deps)

    expect(out).toEqual({ kind: 'success', createdPr: false })
    expect(h.mocks.publishEvent).not.toHaveBeenCalled()
  })

  // ── publishEvent: PR creation failure does NOT publish ──
  it('does NOT publish pr:operation create event when PR creation fails', async () => {
    const h = harness({ mode: 'worktree' })
    h.mocks.createForgePr.mockResolvedValue({ ok: false, error: 'base branch not found' })
    const out = await runManualDevCleanup('I1', WS, h.deps)

    expect(out).toEqual({ kind: 'failed', code: 'prFailed', detail: 'base branch not found' })
    expect(h.mocks.publishEvent).not.toHaveBeenCalled()
  })
})
