/**
 * Queue action family — the PR review / fix relay executor.
 *
 * The kernel decides WHICH phase; this module is everything that happens when one
 * actually runs. The cases below are the four ways it can be wrong: launching
 * without an agent, launching outside the intent's worktree, launching a phase
 * something else already moved, and — the one that matters most — treating a turn
 * that merely ENDED as a conclusion.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Intent } from '@ccc/shared/protocol'
import type { QueueAction } from '../../kernel/queue/index.js'
import type { ClaimedRelayPhase } from './queue-relay-actions.js'

const getIntent = vi.fn<(id: string) => unknown>()
vi.mock('./store.js', () => ({ getIntent: (id: string) => getIntent(id) }))

const gitBranchMode = vi.fn(() => 'worktree')
vi.mock('../../kernel/config/index.js', () => ({
  getGitBranchMode: () => gitBranchMode(),
  getForgeOverride: () => 'github',
}))

const getForgePrLinkFacts = vi.fn<() => Promise<{ ok: boolean; headSha: string | null }>>(() =>
  Promise.resolve({ ok: false, headSha: null }),
)
vi.mock('../../git.js', () => ({
  getForgePrLinkFacts: () => getForgePrLinkFacts(),
}))

const worktreeExists = vi.fn(() => true)
vi.mock('./worktree.js', () => ({
  getWorktreePath: (w: string, id: string) => `${w}/wt/${id}`,
  worktreeExists: () => worktreeExists(),
}))

const agentTarget = vi.fn<(role: string, w: string) => unknown>()
vi.mock('../sessions/agent-target.js', () => ({
  sessionAgentTargetForRole: (role: string, w: string) => agentTarget(role, w),
}))

interface RelaySpecProbe {
  cwd: string
  vendor: string
  agentId: string
  onSessionBound?: (sessionId: string) => void
}
const runRelaySession =
  vi.fn<
    (
      spec: RelaySpecProbe,
    ) => Promise<{ ok: boolean; error: string | null; sessionId: string | null }>
  >()
vi.mock('../automations/relay-session.js', () => ({
  runRelaySession: (spec: RelaySpecProbe) => runRelaySession(spec),
}))

type ClaimResult = { ok: true } | { ok: false; reason: 'stale' | 'projection-write-failed' }
const claimRelayOccupancy = vi.fn<(...a: unknown[]) => ClaimResult>(() => ({ ok: true }))
const releaseRelayOccupancy = vi.fn<(...a: unknown[]) => void>()
const bindRelayOccupancy = vi.fn<(...a: unknown[]) => void>()
vi.mock('./relay-occupancy.js', () => ({
  newRelayPendingId: () => 'pending:new',
  claimRelayOccupancy: (...a: unknown[]) => claimRelayOccupancy(...a),
  releaseRelayOccupancy: (...a: unknown[]) => releaseRelayOccupancy(...a),
  bindRelayOccupancy: (...a: unknown[]) => bindRelayOccupancy(...a),
}))

const orderedActivePrs = vi.fn((req: Intent) => req.prs)
const prIdentityOf = vi.fn((pr: { number: string }, headSha: string | null) => ({
  pr: { forge: 'github', repo: 'acme/w', number: pr.number },
  headSha,
}))
const recordQueueReviewClaim = vi.fn<(...a: unknown[]) => boolean>(() => true)
const bindQueueReviewClaimSession = vi.fn<(...a: unknown[]) => void>()
vi.mock('./merge-authority.js', () => ({
  orderedActivePrs: (req: Intent) => orderedActivePrs(req),
  prIdentityOf: (pr: { number: string }, headSha: string | null) => prIdentityOf(pr, headSha),
  recordQueueReviewClaim: (...a: unknown[]) => recordQueueReviewClaim(...a),
  bindQueueReviewClaimSession: (...a: unknown[]) => bindQueueReviewClaimSession(...a),
}))

const registerRelayRun = vi.fn<(...a: unknown[]) => void>()
const bindRelayRunSession = vi.fn<(...a: unknown[]) => void>()
const unregisterRelayRun = vi.fn<(...a: unknown[]) => void>()
vi.mock('./relay-run-registry.js', () => ({
  registerRelayRun: (...a: unknown[]) => registerRelayRun(...a),
  bindRelayRunSession: (...a: unknown[]) => bindRelayRunSession(...a),
  unregisterRelayRun: (...a: unknown[]) => unregisterRelayRun(...a),
}))

const recordFailure = vi.fn<(...a: unknown[]) => void>()
const recordSuccess = vi.fn<(...a: unknown[]) => void>()
vi.mock('./queue-outcome-actions.js', () => ({
  recordFailure: (...a: unknown[]) => recordFailure(...a),
  recordSuccess: (...a: unknown[]) => recordSuccess(...a),
}))

const { admitRelayPhase, runManualRelayPhase, runRelayPhase } =
  await import('./queue-relay-actions.js')

// ---- Fixtures ----

function intent(over: Partial<Intent> = {}): Intent {
  return {
    id: 'i-1',
    title: '接力目标',
    content: '正文',
    prs: [
      {
        id: 'row',
        intentId: 'i-1',
        deliveryId: null,
        forge: 'github',
        repo: 'acme/w',
        number: '7',
        url: 'u',
        status: 'reviewing',
        headBranch: 'intent/1',
        baseBranch: 'main',
        createdAt: 1,
        updatedAt: 1,
      },
    ],
    reviewSessionId: null,
    reviewStatus: null,
    reviewFixRounds: 0,
    fixSessionId: null,
    fixStatus: null,
    ...over,
  } as unknown as Intent
}

const requestPass = vi.fn()
const ctxObject = {
  workspacePath: '/w',
  hooks: { broadcastIntents: vi.fn() },
  isDisposed: () => false,
  requestPass,
}
const ctx = ctxObject as never

const reviewAction: Extract<QueueAction, { kind: 'launch_review' }> = {
  kind: 'launch_review',
  intentId: 'i-1',
  origin: 'queue-kernel',
  round: 0,
}
const fixAction: Extract<QueueAction, { kind: 'launch_fix' }> = {
  kind: 'launch_fix',
  intentId: 'i-1',
  origin: 'queue-kernel',
  round: 2,
}

beforeEach(() => {
  vi.clearAllMocks()
  gitBranchMode.mockReturnValue('worktree')
  worktreeExists.mockReturnValue(true)
  claimRelayOccupancy.mockReturnValue({ ok: true })
  agentTarget.mockReturnValue({
    ok: true,
    target: { ref: 'agent-x', agent: { vendor: 'claude' }, candidates: [], isGroup: false },
  })
  runRelaySession.mockResolvedValue({ ok: true, error: null, sessionId: 'real-1' })
  getIntent.mockReturnValue(intent({ reviewStatus: 'approved' }))
})

// ---- Cases ----

describe('agent identity', () => {
  it('binds the review role for a review and the fix role for a fix', async () => {
    await runRelayPhase(ctx, reviewAction, intent())
    expect(agentTarget).toHaveBeenCalledWith('review', '/w')
    vi.clearAllMocks()
    agentTarget.mockReturnValue({
      ok: true,
      target: { ref: 'agent-y', agent: { vendor: 'codex' }, candidates: [], isGroup: false },
    })
    getIntent.mockReturnValue(intent({ fixStatus: 'fixed' }))
    await runRelayPhase(ctx, fixAction, intent({ reviewStatus: 'rejected' }))
    expect(agentTarget).toHaveBeenCalledWith('fix', '/w')
    expect(runRelaySession.mock.calls[0][0]).toMatchObject({ vendor: 'codex', agentId: 'agent-y' })
  })

  it('fails loudly when the role resolves to an unusable group — never a silent skip', async () => {
    agentTarget.mockReturnValue({ ok: false, groupRef: '_c3_claude_team' })
    await runRelayPhase(ctx, reviewAction, intent())
    expect(runRelaySession).not.toHaveBeenCalled()
    expect(claimRelayOccupancy).not.toHaveBeenCalled()
    expect(recordFailure.mock.calls[0][3]).toContain('_c3_claude_team')
  })
})

describe('execution directory', () => {
  it('runs in the intent worktree', async () => {
    await runRelayPhase(ctx, reviewAction, intent())
    expect(runRelaySession.mock.calls[0][0]).toMatchObject({ cwd: '/w/wt/i-1' })
  })

  it('refuses rather than falling back to the project checkout', async () => {
    worktreeExists.mockReturnValue(false)
    await runRelayPhase(ctx, reviewAction, intent())
    expect(runRelaySession).not.toHaveBeenCalled()
    expect(recordFailure.mock.calls[0][3]).toContain('worktree')
  })

  it('refuses outside worktree mode', async () => {
    gitBranchMode.mockReturnValue('current-branch')
    await runRelayPhase(ctx, reviewAction, intent())
    expect(runRelaySession).not.toHaveBeenCalled()
  })
})

describe('claiming the phase', () => {
  it('claims a review at the same round and a fix at the round the kernel named', async () => {
    await runRelayPhase(ctx, reviewAction, intent({ reviewFixRounds: 1 }))
    expect(claimRelayOccupancy.mock.calls[0][3]).toMatchObject({
      expectRounds: 1,
      nextRounds: 1,
      expectReviewStatus: null,
    })
    vi.clearAllMocks()
    claimRelayOccupancy.mockReturnValue({ ok: true })
    agentTarget.mockReturnValue({
      ok: true,
      target: { ref: 'a', agent: { vendor: 'claude' }, candidates: [], isGroup: false },
    })
    runRelaySession.mockResolvedValue({ ok: true, error: null, sessionId: 's' })
    getIntent.mockReturnValue(intent({ fixStatus: 'fixed' }))
    await runRelayPhase(ctx, fixAction, intent({ reviewStatus: 'rejected', reviewFixRounds: 1 }))
    expect(claimRelayOccupancy.mock.calls[0][3]).toMatchObject({
      expectReviewStatus: 'rejected',
      expectRounds: 1,
      nextRounds: 2,
    })
  })

  it('a lost race is not a failure — it just re-reconciles', async () => {
    claimRelayOccupancy.mockReturnValue({ ok: false, reason: 'stale' })
    await runRelayPhase(ctx, reviewAction, intent())
    expect(runRelaySession).not.toHaveBeenCalled()
    expect(recordFailure).not.toHaveBeenCalled()
    expect(requestPass).toHaveBeenCalled()
  })

  it('an unwritable placeholder IS a failure', async () => {
    claimRelayOccupancy.mockReturnValue({ ok: false, reason: 'projection-write-failed' })
    await runRelayPhase(ctx, reviewAction, intent())
    expect(recordFailure).toHaveBeenCalled()
  })

  it('does nothing when every PR reached a terminal between snapshot and launch', async () => {
    await runRelayPhase(ctx, reviewAction, intent({ prs: [] }))
    expect(claimRelayOccupancy).not.toHaveBeenCalled()
    expect(recordFailure).not.toHaveBeenCalled()
  })
})

describe('settlement — only a backfilled terminal concludes a phase', () => {
  it('an approved review counts as progress', async () => {
    getIntent.mockReturnValue(intent({ reviewStatus: 'approved' }))
    await runRelayPhase(ctx, reviewAction, intent())
    expect(recordSuccess).toHaveBeenCalled()
    expect(releaseRelayOccupancy).not.toHaveBeenCalled()
  })

  it('a rejected review counts as progress too — a conclusion is a conclusion', async () => {
    getIntent.mockReturnValue(intent({ reviewStatus: 'rejected' }))
    await runRelayPhase(ctx, reviewAction, intent())
    expect(recordSuccess).toHaveBeenCalled()
  })

  it('a clean exit with NO conclusion releases the phase and books a failed attempt', async () => {
    getIntent.mockReturnValue(intent({ reviewStatus: 'pending' }))
    await runRelayPhase(ctx, reviewAction, intent())
    expect(releaseRelayOccupancy).toHaveBeenCalled()
    expect(recordFailure.mock.calls[0][2]).toBe('turn_error')
    expect(recordFailure.mock.calls[0][3]).toContain('未回填结论')
  })

  it('a failed turn books the launch failure with the dispatcher’s reason', async () => {
    runRelaySession.mockResolvedValue({
      ok: false,
      error: 'automation_agent_disabled',
      sessionId: null,
    })
    getIntent.mockReturnValue(intent({ reviewStatus: 'pending' }))
    await runRelayPhase(ctx, reviewAction, intent())
    expect(recordFailure.mock.calls[0][2]).toBe('launch_failed')
    expect(recordFailure.mock.calls[0][3]).toContain('automation_agent_disabled')
  })

  it('a fix is only concluded by `fixed`, never by the review status', async () => {
    getIntent.mockReturnValue(intent({ reviewStatus: 'rejected', fixStatus: null }))
    await runRelayPhase(ctx, fixAction, intent({ reviewStatus: 'rejected' }))
    expect(recordSuccess).not.toHaveBeenCalled()
    expect(releaseRelayOccupancy).toHaveBeenCalled()
  })

  it('binds the real session id onto the placeholder as soon as the vendor reports it', async () => {
    runRelaySession.mockImplementation(async (spec) => {
      spec.onSessionBound?.('vendor-session-9')
      return { ok: true, error: null, sessionId: 'vendor-session-9' }
    })
    getIntent.mockReturnValue(intent({ reviewStatus: 'approved' }))
    await runRelayPhase(ctx, reviewAction, intent())
    expect(bindRelayOccupancy).toHaveBeenCalledWith(
      'i-1',
      'review',
      'pending:new',
      'vendor-session-9',
    )
  })
})

/**
 * The HUMAN entry point's share of this module.
 *
 * Same execution, different accountability — and the tests below are the two
 * halves of that difference: a manual round must record NO queue provenance (so
 * its approval can never become merge authority) and must book NOTHING on the
 * failure ladder (so a human retrying by hand is the only backoff there is).
 * Everything else — the claim, the broadcast, the placeholder release — must
 * behave exactly like the queue's.
 */
describe('the manual entry point', () => {
  const env = {
    workspacePath: '/w',
    hooks: { broadcastIntents: vi.fn() },
    isDisposed: () => false,
  }

  /** The claim a manual round runs under — the executor's whole input. */
  const claimed = (over: Partial<ClaimedRelayPhase> = {}): ClaimedRelayPhase => ({
    phase: 'review',
    round: 0,
    cwd: '/w/wt/i-1',
    pendingId: 'pending:new',
    prs: intent().prs,
    vendor: 'claude',
    agentId: 'agent-x',
    ...over,
  })

  it('claims, broadcasts, and hands back everything the executor needs to run', () => {
    const admission = admitRelayPhase(env, 'review', 0, intent())
    expect(admission).toMatchObject({ ok: true })
    expect(claimRelayOccupancy).toHaveBeenCalledWith(
      'i-1',
      'review',
      'pending:new',
      { expectReviewStatus: null, expectFixStatus: null, expectRounds: 0, nextRounds: 0 },
      expect.objectContaining({ workspacePath: '/w', agentId: 'agent-x', vendor: 'claude' }),
    )
    // The claim is what the intent list must show: a human who clicked needs to
    // see the phase become occupied without waiting for anything else.
    expect(env.hooks.broadcastIntents).toHaveBeenCalledWith('/w')
  })

  it("writes none of the queue's provenance — an approval here is not merge authority", async () => {
    // Authority to let c3 land a PR by itself is a fact about the QUEUE having
    // chosen to review. A human clicking a button never said that, so the round
    // records nothing for a later `approved` to be promoted from — and stays out
    // of the trust registry, which keeps that true even if a future reader of
    // the registry forgets why it exists.
    await runManualRelayPhase(env, intent(), claimed())
    expect(recordQueueReviewClaim).not.toHaveBeenCalled()
    expect(bindQueueReviewClaimSession).not.toHaveBeenCalled()
    expect(registerRelayRun).not.toHaveBeenCalled()
    expect(unregisterRelayRun).not.toHaveBeenCalled()
  })

  it("records the provenance for the QUEUE's own review of the same intent", async () => {
    // The control: the difference asserted above is a real branch, not a test
    // that would pass because the wiring never happens at all.
    getIntent.mockReturnValue(intent({ reviewStatus: 'approved' }))
    await runRelayPhase(ctx, reviewAction, intent())
    expect(recordQueueReviewClaim).toHaveBeenCalled()
    expect(registerRelayRun).toHaveBeenCalled()
  })

  it('runs the SAME execution as the queue: agent, worktree cwd, tool surface, wall clock', async () => {
    getIntent.mockReturnValue(intent({ reviewStatus: 'approved' }))
    await runManualRelayPhase(env, intent(), claimed())
    expect(runRelaySession.mock.calls[0][0]).toMatchObject({
      cwd: '/w/wt/i-1',
      vendor: 'claude',
      agentId: 'agent-x',
      maxWallClockMs: 30 * 60_000,
    })
  })

  it('books NOTHING on the failure ladder when the turn ends without a conclusion', async () => {
    // Automated mode off, or the queue idle: this attempt was never one of the
    // queue's unattended tries, so it must not push the intent toward a backoff
    // or a park it did not earn. The placeholder is still released, or the phase
    // would read as running forever and the button would never come back.
    getIntent.mockReturnValue(intent({ reviewStatus: 'pending' }))
    await runManualRelayPhase(env, intent(), claimed())
    expect(releaseRelayOccupancy).toHaveBeenCalled()
    expect(recordFailure).not.toHaveBeenCalled()
    expect(recordSuccess).not.toHaveBeenCalled()
  })

  it('books nothing on an approved review either — it only backfills the status', async () => {
    getIntent.mockReturnValue(intent({ reviewStatus: 'approved' }))
    await runManualRelayPhase(env, intent(), claimed())
    expect(recordSuccess).not.toHaveBeenCalled()
    // A conclusion needs nothing from us: the sync tool that wrote it broadcasts.
    expect(releaseRelayOccupancy).not.toHaveBeenCalled()
  })
})
