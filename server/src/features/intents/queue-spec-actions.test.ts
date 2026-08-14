/**
 * Queue action family — the spec phase.
 *
 * Covers what the queue is allowed to do to a spec: author it, review it
 * read-only, re-author it with the reviewer's findings, and (only under the
 * workspace opt-in) approve it. The two guards asserted here are the ones a
 * refactor could silently drop — a refused launch must cost the intent exactly
 * one attempt, and a machine approval must re-check the live fingerprint at
 * write time and treat a rejection as "not now", never as a failure.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Intent } from '@ccc/shared/protocol'
import { MACHINE_SPEC_APPROVER } from '@ccc/shared/protocol'

// ---- Mocks (must be before imports) ----

vi.mock('./store.js', () => ({
  getIntent: vi.fn(),
  machineApproveSpec: vi.fn(),
}))

vi.mock('./session-launcher.js', () => ({
  launchSpecSession: vi.fn(),
  launchSpecReviewSession: vi.fn(),
}))

vi.mock('./spec-review.js', () => ({ readSpecFingerprint: vi.fn() }))
vi.mock('./spec.js', () => ({ applySpecApproval: vi.fn() }))
vi.mock('./queue-outcome-actions.js', () => ({
  recordFailure: vi.fn(),
  recordSuccess: vi.fn(),
}))

// ---- Imports ----

import { executeMachineApproveSpec, runSpecPhase } from './queue-spec-actions.js'
import type { QueueActionContext, WorkflowHooks } from './queue-action-context.js'
import { getIntent, machineApproveSpec } from './store.js'
import { launchSpecReviewSession, launchSpecSession } from './session-launcher.js'
import { readSpecFingerprint } from './spec-review.js'
import { applySpecApproval } from './spec.js'
import { recordFailure, recordSuccess } from './queue-outcome-actions.js'

const WS = '/test/spec-ws'

const makeIntent = (overrides: Partial<Intent> & { id: string }): Intent =>
  ({
    workspaceName: 'test-proj',
    title: 'Test',
    content: '',
    priority: 'P1',
    status: 'todo',
    dependsOn: [],
    automate: true,
    createdAt: 100,
    specPath: null,
    specApproved: false,
    specSessionId: null,
    specReviewSessionId: null,
    specReviewVerdict: null,
    specReviewReason: null,
    specReviewFingerprint: null,
    specReviewReworkRounds: 0,
    specReviewMachineApprovalBlocked: false,
    lastWorkSessionId: null,
    ...overrides,
  }) as Intent

function makeCtx(): { ctx: QueueActionContext; hooks: WorkflowHooks; requestPass: () => void } {
  const hooks = {
    runDevTurn: vi.fn(),
    launchSpecRun: vi.fn(() => Promise.resolve()),
    broadcastIntents: vi.fn(),
    emitStatus: vi.fn(),
    sessionExists: vi.fn(() => Promise.resolve(false)),
    isRunning: vi.fn(() => false),
    sessionStatus: vi.fn(() => null),
    normalizeEvent: vi.fn(),
    publishEvent: vi.fn(),
    createUserTodo: vi.fn(),
    broadcastQueueDetail: vi.fn(),
  } as unknown as WorkflowHooks
  const requestPass = vi.fn()
  const ctx: QueueActionContext = {
    workspacePath: WS,
    hooks,
    signal: new AbortController().signal,
    isDisposed: () => false,
    tickId: () => 'tick-1',
    requestPass,
    setState: vi.fn(),
    setCheckpointConsensus: vi.fn(),
    setAwaiting: vi.fn(),
    setCurrentSessionId: vi.fn(),
    markCompleted: vi.fn(),
  }
  return { ctx, hooks, requestPass }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('runSpecPhase — authoring and read-only review', () => {
  it('authors a first-pass spec through the shared launcher, as the automation actor', async () => {
    const { ctx, hooks } = makeCtx()
    vi.mocked(launchSpecSession).mockResolvedValue({
      success: true,
      sessionId: 'spec-s',
      mode: 'fresh',
    })
    const req = makeIntent({ id: 'A' })

    await runSpecPhase(
      ctx,
      { kind: 'launch_spec', intentId: 'A', origin: 'queue-kernel', rework: false, reworkRound: 0 },
      req,
    )

    expect(launchSpecSession).toHaveBeenCalledTimes(1)
    const [ws, id, deps, progress, actor, opts] = vi.mocked(launchSpecSession).mock.calls[0]
    expect([ws, id, progress, actor]).toEqual([WS, 'A', undefined, 'automation'])
    expect(deps.launchRun).toBe(hooks.launchSpecRun)
    // A first pass carries no rework payload at all.
    expect(opts).toEqual({})
    expect(recordSuccess).toHaveBeenCalledWith(ctx, 'A')
    expect(recordFailure).not.toHaveBeenCalled()
    expect(hooks.broadcastIntents).toHaveBeenCalledWith(WS)
  })

  it('a rework pass hands the author the reviewer findings and the round number', async () => {
    const { ctx } = makeCtx()
    vi.mocked(launchSpecSession).mockResolvedValue({
      success: true,
      sessionId: 'spec-s',
      mode: 'fresh',
    })
    const req = makeIntent({ id: 'B', specReviewReason: '缺少回滚方案' })

    await runSpecPhase(
      ctx,
      { kind: 'launch_spec', intentId: 'B', origin: 'queue-kernel', rework: true, reworkRound: 2 },
      req,
    )

    expect(vi.mocked(launchSpecSession).mock.calls[0][5]).toEqual({
      reworkReason: '缺少回滚方案',
      reworkRound: 2,
    })
  })

  it('a rework with no recorded reason still says so rather than sending an empty note', async () => {
    const { ctx } = makeCtx()
    vi.mocked(launchSpecSession).mockResolvedValue({
      success: true,
      sessionId: 'spec-s',
      mode: 'fresh',
    })

    await runSpecPhase(
      ctx,
      { kind: 'launch_spec', intentId: 'C', origin: 'queue-kernel', rework: true, reworkRound: 1 },
      makeIntent({ id: 'C', specReviewReason: null }),
    )

    expect(vi.mocked(launchSpecSession).mock.calls[0][5]).toEqual({
      reworkReason: '(审核未给出理由)',
      reworkRound: 1,
    })
  })

  it('a review goes through the review launcher, never the authoring one', async () => {
    const { ctx, hooks } = makeCtx()
    vi.mocked(launchSpecReviewSession).mockResolvedValue({
      success: true,
      sessionId: 'spec-s',
      mode: 'fresh',
    })

    await runSpecPhase(
      ctx,
      {
        kind: 'launch_spec_review',
        intentId: 'D',
        origin: 'queue-kernel',
        fingerprint: 'fp-1',
      },
      makeIntent({ id: 'D', specPath: '/specs/d.md' }),
    )

    expect(launchSpecSession).not.toHaveBeenCalled()
    expect(launchSpecReviewSession).toHaveBeenCalledWith(
      WS,
      'D',
      expect.objectContaining({ launchRun: hooks.launchSpecRun }),
      undefined,
      'automation',
    )
    expect(recordSuccess).toHaveBeenCalledWith(ctx, 'D')
  })

  it('a refused authoring launch is ONE failed attempt for that intent', async () => {
    const { ctx, hooks } = makeCtx()
    vi.mocked(launchSpecSession).mockResolvedValue({ success: false, code: 'intent.notFound' })

    await runSpecPhase(
      ctx,
      { kind: 'launch_spec', intentId: 'E', origin: 'queue-kernel', rework: false, reworkRound: 0 },
      makeIntent({ id: 'E' }),
    )

    expect(recordFailure).toHaveBeenCalledWith(
      ctx,
      'E',
      'launch_failed',
      'spec 撰写会话启动被拒绝(intent.notFound)',
    )
    expect(recordSuccess).not.toHaveBeenCalled()
    expect(hooks.broadcastIntents).not.toHaveBeenCalled()
  })

  it('a refused review launch is ONE failed attempt, labelled as the review it was', async () => {
    const { ctx } = makeCtx()
    vi.mocked(launchSpecReviewSession).mockResolvedValue({
      success: false,
      code: 'intent.specNotWritten',
    })

    await runSpecPhase(
      ctx,
      { kind: 'launch_spec_review', intentId: 'F', origin: 'queue-kernel', fingerprint: 'fp' },
      makeIntent({ id: 'F' }),
    )

    expect(recordFailure).toHaveBeenCalledWith(
      ctx,
      'F',
      'launch_failed',
      'spec 审核会话启动被拒绝(intent.specNotWritten)',
    )
  })

  it('a refused launch carries the failure parameters, not just the code', async () => {
    const { ctx } = makeCtx()
    // The raw text of the Git command that failed — the only thing that tells a
    // path conflict apart from a full disk without reproducing the failure.
    const message =
      "fatal: '/w/intent-f' already exists\nhint: use 'git worktree add --force' to override"
    vi.mocked(launchSpecReviewSession).mockResolvedValue({
      success: false,
      code: 'intent.worktreeCreateFailed',
      params: { message },
    })

    await runSpecPhase(
      ctx,
      { kind: 'launch_spec_review', intentId: 'K', origin: 'queue-kernel', fingerprint: 'fp' },
      makeIntent({ id: 'K' }),
    )

    expect(recordFailure).toHaveBeenCalledWith(
      ctx,
      'K',
      'launch_failed',
      `spec 审核会话启动被拒绝(intent.worktreeCreateFailed) — message=${message}`,
    )
  })

  it('every failure parameter is rendered, and the authoring label is kept', async () => {
    const { ctx } = makeCtx()
    vi.mocked(launchSpecSession).mockResolvedValue({
      success: false,
      code: 'intent.dependencyNotMerged',
      params: { title: '先落地登录', id: 'dep-1' },
    })

    await runSpecPhase(
      ctx,
      { kind: 'launch_spec', intentId: 'L', origin: 'queue-kernel', rework: false, reworkRound: 0 },
      makeIntent({ id: 'L' }),
    )

    expect(recordFailure).toHaveBeenCalledWith(
      ctx,
      'L',
      'launch_failed',
      'spec 撰写会话启动被拒绝(intent.dependencyNotMerged) — title=先落地登录, id=dep-1',
    )
  })
})

describe('executeMachineApproveSpec — a conditional write, not a trusted one', () => {
  it('approves through the transactional guard and lands the audit pass once', () => {
    const { ctx, hooks } = makeCtx()
    const req = makeIntent({ id: 'G', specPath: '/specs/g.md' })
    vi.mocked(getIntent).mockReturnValue(req)
    vi.mocked(machineApproveSpec).mockReturnValue(true)

    executeMachineApproveSpec(ctx, {
      kind: 'machine_approve_spec',
      intentId: 'G',
      fingerprint: 'fp-1',
    })

    expect(machineApproveSpec).toHaveBeenCalledWith(
      'G',
      'fp-1',
      MACHINE_SPEC_APPROVER,
      expect.any(Function),
    )
    expect(applySpecApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        workspacePath: WS,
        intent: req,
        approver: MACHINE_SPEC_APPROVER,
        // The flag was already written by the guard; this pass must not rewrite it.
        alreadyPersisted: true,
        broadcastIntents: hooks.broadcastIntents,
      }),
    )
  })

  it('re-reads the LIVE spec file at write time, not the snapshot fingerprint', () => {
    const { ctx } = makeCtx()
    vi.mocked(getIntent).mockReturnValue(makeIntent({ id: 'H', specPath: '/specs/h.md' }))
    vi.mocked(machineApproveSpec).mockReturnValue(true)
    vi.mocked(readSpecFingerprint).mockReturnValue('fp-live')

    executeMachineApproveSpec(ctx, {
      kind: 'machine_approve_spec',
      intentId: 'H',
      fingerprint: 'fp-1',
    })

    const readLive = vi.mocked(machineApproveSpec).mock.calls[0][3]
    expect(readLive('/specs/h.md')).toBe('fp-live')
    expect(readSpecFingerprint).toHaveBeenCalledWith(WS, '/specs/h.md')
  })

  it('a spec edited since the snapshot approves nothing, costs no failure and re-reconciles', () => {
    const { ctx, requestPass } = makeCtx()
    vi.mocked(getIntent).mockReturnValue(makeIntent({ id: 'I', specPath: '/specs/i.md' }))
    // The guard refuses: the live facts moved between the pass and the write.
    vi.mocked(machineApproveSpec).mockReturnValue(false)

    executeMachineApproveSpec(ctx, {
      kind: 'machine_approve_spec',
      intentId: 'I',
      fingerprint: 'stale',
    })

    expect(applySpecApproval).not.toHaveBeenCalled()
    // A rejected write is the guard doing its job — never an attempt against the intent.
    expect(recordFailure).not.toHaveBeenCalled()
    expect(requestPass).toHaveBeenCalledTimes(1)
  })

  it('an intent that vanished between the pass and the write approves nothing', () => {
    const { ctx } = makeCtx()
    vi.mocked(getIntent).mockReturnValue(null)

    executeMachineApproveSpec(ctx, {
      kind: 'machine_approve_spec',
      intentId: 'J',
      fingerprint: 'fp',
    })

    expect(machineApproveSpec).not.toHaveBeenCalled()
    expect(applySpecApproval).not.toHaveBeenCalled()
  })
})
