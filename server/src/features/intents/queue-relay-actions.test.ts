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

const recordFailure = vi.fn<(...a: unknown[]) => void>()
const recordSuccess = vi.fn<(...a: unknown[]) => void>()
vi.mock('./queue-outcome-actions.js', () => ({
  recordFailure: (...a: unknown[]) => recordFailure(...a),
  recordSuccess: (...a: unknown[]) => recordSuccess(...a),
}))

const { runRelayPhase } = await import('./queue-relay-actions.js')

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
