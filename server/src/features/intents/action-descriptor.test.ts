/**
 * Tests for the composed next-step action-descriptor projection:
 * vendor > wait-user (Ask / permission) > spec rework exhausted > spec awaiting
 * approval > dependency blocked > silent timeout.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Intent, WaitUserInvolveEvent } from '@ccc/shared/protocol'
import { MAX_SPEC_REVIEW_REWORK_ROUNDS } from '@ccc/shared/protocol'

const vendorDesc = vi.fn<(intent: unknown) => unknown>()
vi.mock('./vendor-block.js', () => ({
  deriveVendorActionDescriptor: (intent: unknown) => vendorDesc(intent),
}))

const silentDesc = vi.fn<(intent: unknown) => unknown>()
vi.mock('./silent-timeout.js', () => ({
  deriveSilentTimeoutActionDescriptor: (intent: unknown) => silentDesc(intent),
}))

const findTodo = vi.fn<(workspacePath: string, sessionIds: readonly string[]) => unknown>()
vi.mock('../user-involve/store.js', () => ({
  findLatestTodoEventForSessionIds: (workspacePath: string, sessionIds: readonly string[]) =>
    findTodo(workspacePath, sessionIds),
}))

const sddOn = vi.fn<(workspacePath: string) => boolean>(() => true)
const branchMode = vi.fn<(workspacePath: string) => 'worktree' | 'current-branch'>()
const mainBranch = vi.fn<(workspacePath: string) => string | undefined>()
vi.mock('../../kernel/config/index.js', () => ({
  getSddEnabled: (workspacePath: string) => sddOn(workspacePath),
  getGitBranchMode: (workspacePath: string) => branchMode(workspacePath),
  getDefaultMainBranch: (workspacePath: string) => mainBranch(workspacePath),
}))

vi.mock('../../state.js', () => ({
  resolveWorkspaceRoot: vi.fn((id: string) => (id === 'ws' ? '/proj' : null)),
}))

const liveFingerprint = vi.fn<(workspacePath: string, specPath: string | null) => string | null>()
vi.mock('./spec-review.js', () => ({
  readSpecFingerprint: (workspacePath: string, specPath: string | null) =>
    liveFingerprint(workspacePath, specPath),
}))

const { deriveActionDescriptor } = await import('./action-descriptor.js')

/**
 * The workspace ledger the dependency projection resolves `dependsOn` against.
 * Tests that do not care about dependencies leave it empty — the projection then
 * has nothing to resolve and stays out of the way.
 */
let ledger: Intent[] = []

/** Call the projection with the test ledger as its workspace-intents loader. */
function derive(intent: Intent) {
  return deriveActionDescriptor(intent, () => ledger)
}

function makeIntent(overrides: Partial<Intent> & { id: string }): Intent {
  return {
    workspaceId: 'ws',
    title: 'T',
    shortEnTitle: null,
    content: '',
    priority: 'P1',
    module: '',
    status: 'todo',
    dependsOn: [],
    dependsOnTypes: {},
    lastWorkSessionId: null,
    automate: false,
    branchName: null,
    latestCommitHash: null,
    prId: null,
    prUrl: null,
    prStatus: null,
    specPath: null,
    // 与迁移回填同口径:已批准→approved;有 spec 路径但未批准→pending;其余→raw。
    specStatus: overrides.specApproved ? 'approved' : overrides.specPath ? 'pending' : 'raw',
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
    createdAt: 1,
    updatedAt: 1,
    completedAt: null,
    runStatus: 'idle',
    sessionActive: false,
    actionDescriptor: null,
    ...overrides,
  }
}

function makeEvent(
  overrides: Partial<WaitUserInvolveEvent> & { id: string },
): WaitUserInvolveEvent {
  return {
    workspaceId: 'ws',
    sessionKind: 'work',
    sessionId: 'sess-1',
    intentId: 'i-1',
    intentTitle: 'T',
    title: 'pending',
    requestId: 'req-1',
    toolName: 'Bash',
    toolInput: {},
    status: 'todo',
    outcome: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

const SILENT = {
  labelCode: 'silent_timeout',
  target: { type: 'intent-work-session', intentId: 'i-1' },
}

beforeEach(() => {
  vendorDesc.mockReset()
  vendorDesc.mockReturnValue(null)
  silentDesc.mockReset()
  silentDesc.mockReturnValue(null)
  findTodo.mockReset()
  findTodo.mockReturnValue(null)
  sddOn.mockReset()
  sddOn.mockReturnValue(true)
  liveFingerprint.mockReset()
  liveFingerprint.mockReturnValue('fp1')
  branchMode.mockReset()
  branchMode.mockReturnValue('worktree')
  mainBranch.mockReset()
  mainBranch.mockReturnValue('main')
  ledger = []
})

/** An intent parked exactly at the rework hand-over point: cap passed, conclusion still valid. */
function exhaustedIntent(overrides: Partial<Intent> = {}): Intent {
  return makeIntent({
    id: 'i-1',
    status: 'todo',
    specPath: '/s.md',
    specApproved: false,
    specReviewVerdict: 'changes_requested',
    specReviewReason: '缺少错误路径的验收项',
    specReviewFingerprint: 'fp1',
    specReviewReworkRounds: MAX_SPEC_REVIEW_REWORK_ROUNDS + 1,
    ...overrides,
  })
}

describe('deriveActionDescriptor — priority', () => {
  it('prefers a vendor block over wait-user and spec', () => {
    vendorDesc.mockReturnValue({
      labelCode: 'vendor_auth_invalid',
      target: { type: 'system-settings-agent', vendor: 'claude', agentId: 'a1' },
    })
    findTodo.mockReturnValue(makeEvent({ id: 'e1', toolName: 'AskUserQuestion' }))
    const intent = makeIntent({
      id: 'i-1',
      specPath: '/s.md',
      specApproved: false,
      lastWorkSessionId: 'sess-1',
    })
    expect(derive(intent)).toEqual({
      labelCode: 'vendor_auth_invalid',
      target: { type: 'system-settings-agent', vendor: 'claude', agentId: 'a1' },
    })
    expect(findTodo).not.toHaveBeenCalled()
  })

  it('prefers a pending Ask over spec awaiting approval', () => {
    findTodo.mockReturnValue(makeEvent({ id: 'e-ask', toolName: 'AskUserQuestion' }))
    const intent = makeIntent({
      id: 'i-1',
      specPath: '/s.md',
      specApproved: false,
      lastWorkSessionId: 'sess-1',
    })
    expect(derive(intent)).toEqual({
      labelCode: 'ask_user_question_pending',
      target: { type: 'workcenter-event', eventId: 'e-ask' },
    })
  })

  it('maps an ordinary gated tool to permission_pending', () => {
    findTodo.mockReturnValue(makeEvent({ id: 'e-perm', toolName: 'Edit' }))
    expect(derive(makeIntent({ id: 'i-1', lastWorkSessionId: 'sess-1' }))).toEqual({
      labelCode: 'permission_pending',
      target: { type: 'workcenter-event', eventId: 'e-perm' },
    })
  })

  it('ignores notification-only todos without a requestId', () => {
    findTodo.mockReturnValue(makeEvent({ id: 'e-note', requestId: null, toolName: null }))
    expect(derive(makeIntent({ id: 'i-1', lastWorkSessionId: 'sess-1' }))).toBeNull()
  })

  it('derives spec_awaiting_approval when SDD is on and the spec is written but unapproved', () => {
    const intent = makeIntent({ id: 'i-1', status: 'todo', specPath: '/s.md', specApproved: false })
    expect(derive(intent)).toEqual({
      labelCode: 'spec_awaiting_approval',
      target: { type: 'intent-spec', intentId: 'i-1' },
    })
  })

  it('returns null when the spec is already approved', () => {
    expect(
      derive(makeIntent({ id: 'i-1', status: 'todo', specPath: '/s.md', specApproved: true })),
    ).toBeNull()
  })

  it('derives NOTHING for a raw spec with a path — seeding is not awaiting approval', () => {
    // write_spec seeds the document and backfills spec_path the same moment, so a
    // path that exists must not by itself send a human to approve an un-written
    // document. The status — not the path — decides.
    expect(
      derive(
        makeIntent({
          id: 'i-1',
          status: 'todo',
          specPath: '/s.md',
          specStatus: 'raw',
          specApproved: false,
        }),
      ),
    ).toBeNull()
  })

  it('does not claim rework exhaustion for a raw spec, even with leftover review facts', () => {
    expect(
      derive(
        makeIntent({
          id: 'i-1',
          status: 'todo',
          specPath: '/s.md',
          specStatus: 'raw',
          specApproved: false,
          specReviewVerdict: 'changes_requested',
          specReviewFingerprint: 'fp1',
          specReviewReworkRounds: MAX_SPEC_REVIEW_REWORK_ROUNDS + 1,
        }),
      ),
    ).toBeNull()
  })

  it('returns null when SDD is off', () => {
    sddOn.mockReturnValue(false)
    expect(
      derive(makeIntent({ id: 'i-1', status: 'todo', specPath: '/s.md', specApproved: false })),
    ).toBeNull()
  })

  it('returns null when the intent is not todo', () => {
    expect(
      derive(
        makeIntent({
          id: 'i-1',
          status: 'in_progress',
          specPath: '/s.md',
          specApproved: false,
        }),
      ),
    ).toBeNull()
  })

  it('lets a concrete vendor cause outrank silent timeout', () => {
    vendorDesc.mockReturnValue({
      labelCode: 'vendor_quota_exhausted',
      target: { type: 'system-settings-agent', vendor: 'claude', agentId: 'a1' },
    })
    silentDesc.mockReturnValue(SILENT)
    expect(derive(makeIntent({ id: 'i-1' }))?.labelCode).toBe('vendor_quota_exhausted')
  })

  it('lets a pending wait-user event and a written spec both outrank silent timeout', () => {
    silentDesc.mockReturnValue(SILENT)
    findTodo.mockReturnValue(makeEvent({ id: 'e-perm', toolName: 'Edit' }))
    expect(derive(makeIntent({ id: 'i-1' }))?.labelCode).toBe('permission_pending')

    findTodo.mockReturnValue(null)
    expect(
      derive(makeIntent({ id: 'i-1', specPath: '/s.md', specApproved: false }))?.labelCode,
    ).toBe('spec_awaiting_approval')
  })

  it('falls through to silent timeout when nothing more specific applies', () => {
    silentDesc.mockReturnValue(SILENT)
    expect(derive(makeIntent({ id: 'i-1' }))).toEqual(SILENT)
  })

  it('does NOT derive spec_awaiting_approval for a raw spec that only has a seed path', () => {
    // write_spec backfilled the path the moment it seeded the placeholder, so a
    // path alone must not read as "written but unapproved" — that is the exact
    // false prompt this status exists to remove.
    expect(
      derive(makeIntent({ id: 'i-1', status: 'todo', specPath: '/s.md', specStatus: 'raw' })),
    ).toBeNull()
  })

  it('does NOT claim rework exhaustion for a raw spec, even with leftover review facts', () => {
    // A raw spec is never reviewed, so a leftover conclusion / rework counter
    // from an earlier life of the document must not surface the hand-over prompt.
    expect(
      derive(
        exhaustedIntent({
          specStatus: 'raw',
          specReviewVerdict: 'changes_requested',
          specReviewFingerprint: 'fp1',
          specReviewReworkRounds: MAX_SPEC_REVIEW_REWORK_ROUNDS + 1,
        }),
      ),
    ).toBeNull()
  })

  it('derives spec_rework_exhausted once the cap is passed and the conclusion still stands', () => {
    expect(derive(exhaustedIntent())).toEqual({
      labelCode: 'spec_rework_exhausted',
      target: { type: 'intent-spec', intentId: 'i-1' },
    })
  })

  it('still shows the plain approval prompt on the LAST allowed rework round', () => {
    // Round CAP is reworked automatically — the hand-over is the round after it.
    expect(
      derive(exhaustedIntent({ specReviewReworkRounds: MAX_SPEC_REVIEW_REWORK_ROUNDS })),
    ).toEqual({
      labelCode: 'spec_awaiting_approval',
      target: { type: 'intent-spec', intentId: 'i-1' },
    })
  })

  it('does not claim exhaustion when the current conclusion passed', () => {
    expect(derive(exhaustedIntent({ specReviewVerdict: 'pass' }))).toEqual({
      labelCode: 'spec_awaiting_approval',
      target: { type: 'intent-spec', intentId: 'i-1' },
    })
  })

  it('drops the prompt once the spec is edited and the old conclusion is stale', () => {
    liveFingerprint.mockReturnValue('fp2')
    expect(derive(exhaustedIntent())).toEqual({
      labelCode: 'spec_awaiting_approval',
      target: { type: 'intent-spec', intentId: 'i-1' },
    })
  })

  it('shows nothing while the spec is unreadable — unreadable is not unchanged', () => {
    liveFingerprint.mockReturnValue(null)
    expect(derive(exhaustedIntent())).toEqual({
      labelCode: 'spec_awaiting_approval',
      target: { type: 'intent-spec', intentId: 'i-1' },
    })
  })

  it('drops the prompt once the intent leaves the blocked state', () => {
    expect(derive(exhaustedIntent({ specApproved: true }))).toBeNull()
    expect(derive(exhaustedIntent({ status: 'in_progress' }))).toBeNull()
    sddOn.mockReturnValue(false)
    expect(derive(exhaustedIntent())).toBeNull()
  })

  it('yields to more urgent blocks (vendor, pending Ask) while exhausted', () => {
    vendorDesc.mockReturnValue({
      labelCode: 'vendor_auth_invalid',
      target: { type: 'system-settings-agent', vendor: 'claude', agentId: 'a1' },
    })
    expect(derive(exhaustedIntent())).toMatchObject({
      labelCode: 'vendor_auth_invalid',
    })
    vendorDesc.mockReturnValue(null)
    findTodo.mockReturnValue(makeEvent({ id: 'e-ask', toolName: 'AskUserQuestion' }))
    expect(derive(exhaustedIntent())).toMatchObject({
      labelCode: 'ask_user_question_pending',
    })
  })

  it('looks up wait-user events by every session id plus the intent id', () => {
    const intent = makeIntent({
      id: 'i-1',
      intentSessionId: 'is',
      specSessionId: 'ss',
      specReviewSessionId: 'rs',
      lastWorkSessionId: 'ws',
    })
    derive(intent)
    expect(findTodo).toHaveBeenCalledWith('/proj', ['i-1', 'is', 'ss', 'rs', 'ws'])
  })
})

/**
 * The dependency guidance: which predecessor the hard gate is actually waiting
 * for. It explains the gate's own verdict — it never invents one, and it never
 * moves the gate.
 */
describe('deriveActionDescriptor — dependency guidance', () => {
  /** A predecessor that is done AND confirmed on the mainline: never blocks. */
  function mergedDep(id: string, title: string): Intent {
    return makeIntent({ id, title, status: 'done', prStatus: 'merged', branchName: `feat/${id}` })
  }

  it('names the first unfinished predecessor in declaration order', () => {
    ledger = [
      makeIntent({ id: 'dep-a', title: '打底能力', status: 'todo' }),
      makeIntent({ id: 'dep-b', title: '后续能力', status: 'todo' }),
    ]
    expect(derive(makeIntent({ id: 'i-1', dependsOn: ['dep-a', 'dep-b'] }))).toEqual({
      labelCode: 'dependency_blocked',
      target: { type: 'intent-detail', intentId: 'dep-a' },
    })
  })

  it('moves to the next blocking predecessor once the first one clears', () => {
    ledger = [mergedDep('dep-a', '打底能力'), makeIntent({ id: 'dep-b', status: 'in_progress' })]
    expect(derive(makeIntent({ id: 'i-1', dependsOn: ['dep-a', 'dep-b'] }))).toEqual({
      labelCode: 'dependency_blocked',
      target: { type: 'intent-detail', intentId: 'dep-b' },
    })
  })

  it('disappears once every predecessor satisfies the gate', () => {
    ledger = [mergedDep('dep-a', '打底能力'), mergedDep('dep-b', '后续能力')]
    expect(derive(makeIntent({ id: 'i-1', dependsOn: ['dep-a', 'dep-b'] }))).toBeNull()
  })

  it('still guides in worktree mode when a done predecessor is not on the mainline yet', () => {
    ledger = [
      makeIntent({ id: 'dep-a', status: 'done', prStatus: 'reviewing', branchName: 'feat/dep-a' }),
    ]
    expect(derive(makeIntent({ id: 'i-1', dependsOn: ['dep-a'] }))).toEqual({
      labelCode: 'dependency_blocked',
      target: { type: 'intent-detail', intentId: 'dep-a' },
    })
  })

  it('does not guide on that same item under current-branch mode — the gate does not block there', () => {
    branchMode.mockReturnValue('current-branch')
    ledger = [
      makeIntent({ id: 'dep-a', status: 'done', prStatus: 'reviewing', branchName: 'feat/dep-a' }),
    ]
    expect(derive(makeIntent({ id: 'i-1', dependsOn: ['dep-a'] }))).toBeNull()
  })

  it('still guides on an unfinished predecessor under current-branch mode', () => {
    branchMode.mockReturnValue('current-branch')
    ledger = [makeIntent({ id: 'dep-a', status: 'todo' })]
    expect(derive(makeIntent({ id: 'i-1', dependsOn: ['dep-a'] }))).toEqual({
      labelCode: 'dependency_blocked',
      target: { type: 'intent-detail', intentId: 'dep-a' },
    })
  })

  it('ignores a missing reference and points at the next resolvable blocker', () => {
    ledger = [makeIntent({ id: 'dep-b', status: 'todo' })]
    expect(derive(makeIntent({ id: 'i-1', dependsOn: ['gone', 'dep-b'] }))).toEqual({
      labelCode: 'dependency_blocked',
      target: { type: 'intent-detail', intentId: 'dep-b' },
    })
  })

  it('shows nothing when the only reference is missing — a dangling id never blocks', () => {
    expect(derive(makeIntent({ id: 'i-1', dependsOn: ['gone'] }))).toBeNull()
  })

  it('only describes intents the gate can still hold back', () => {
    ledger = [makeIntent({ id: 'dep-a', status: 'todo' })]
    for (const status of ['todo', 'in_progress'] as const) {
      expect(derive(makeIntent({ id: 'i-1', status, dependsOn: ['dep-a'] }))).toMatchObject({
        labelCode: 'dependency_blocked',
      })
    }
    for (const status of ['draft', 'done', 'cancelled', 'blocked', 'failed'] as const) {
      expect(derive(makeIntent({ id: 'i-1', status, dependsOn: ['dep-a'] }))).toBeNull()
    }
  })

  it('does not read the ledger for an intent that declares no dependency', () => {
    const load = vi.fn(() => ledger)
    expect(deriveActionDescriptor(makeIntent({ id: 'i-1' }), load)).toBeNull()
    expect(load).not.toHaveBeenCalled()
  })

  it('yields to every higher-priority block, and surfaces once they clear', () => {
    ledger = [makeIntent({ id: 'dep-a', status: 'todo' })]
    const blockedIntent = () =>
      makeIntent({ id: 'i-1', dependsOn: ['dep-a'], specPath: '/s.md', specApproved: false })

    vendorDesc.mockReturnValue({
      labelCode: 'vendor_auth_invalid',
      target: { type: 'system-settings-agent', vendor: 'claude', agentId: 'a1' },
    })
    expect(derive(blockedIntent())).toMatchObject({ labelCode: 'vendor_auth_invalid' })

    vendorDesc.mockReturnValue(null)
    findTodo.mockReturnValue(makeEvent({ id: 'e-ask', toolName: 'AskUserQuestion' }))
    expect(derive(blockedIntent())).toMatchObject({ labelCode: 'ask_user_question_pending' })

    findTodo.mockReturnValue(null)
    expect(
      derive(
        makeIntent({
          ...blockedIntent(),
          specReviewVerdict: 'changes_requested',
          specReviewFingerprint: 'fp1',
          specReviewReworkRounds: MAX_SPEC_REVIEW_REWORK_ROUNDS + 1,
        }),
      ),
    ).toMatchObject({ labelCode: 'spec_rework_exhausted' })

    // Spec still unapproved → the approval checkpoint outranks the dependency.
    expect(derive(blockedIntent())).toMatchObject({ labelCode: 'spec_awaiting_approval' })

    // Approved: the dependency guidance is what is left.
    expect(
      derive(makeIntent({ ...blockedIntent(), specApproved: true, specStatus: 'approved' })),
    ).toMatchObject({
      labelCode: 'dependency_blocked',
    })
  })
})
