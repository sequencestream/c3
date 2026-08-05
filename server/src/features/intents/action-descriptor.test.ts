/**
 * Tests for the composed next-step action-descriptor projection:
 * vendor > wait-user (Ask / permission) > spec rework exhausted > spec awaiting
 * approval.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Intent, WaitUserInvolveEvent } from '@ccc/shared/protocol'
import { MAX_SPEC_REVIEW_REWORK_ROUNDS } from '@ccc/shared/protocol'

const vendorDesc = vi.fn<(intent: unknown) => unknown>()
vi.mock('./vendor-block.js', () => ({
  deriveVendorActionDescriptor: (intent: unknown) => vendorDesc(intent),
}))

const findTodo = vi.fn<(workspacePath: string, sessionIds: readonly string[]) => unknown>()
vi.mock('../user-involve/store.js', () => ({
  findLatestTodoEventForSessionIds: (workspacePath: string, sessionIds: readonly string[]) =>
    findTodo(workspacePath, sessionIds),
}))

const sddOn = vi.fn<(workspacePath: string) => boolean>(() => true)
vi.mock('../../kernel/config/index.js', () => ({
  getSddEnabled: (workspacePath: string) => sddOn(workspacePath),
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

beforeEach(() => {
  vendorDesc.mockReset()
  vendorDesc.mockReturnValue(null)
  findTodo.mockReset()
  findTodo.mockReturnValue(null)
  sddOn.mockReset()
  sddOn.mockReturnValue(true)
  liveFingerprint.mockReset()
  liveFingerprint.mockReturnValue('fp1')
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
    expect(deriveActionDescriptor(intent)).toEqual({
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
    expect(deriveActionDescriptor(intent)).toEqual({
      labelCode: 'ask_user_question_pending',
      target: { type: 'workcenter-event', eventId: 'e-ask' },
    })
  })

  it('maps an ordinary gated tool to permission_pending', () => {
    findTodo.mockReturnValue(makeEvent({ id: 'e-perm', toolName: 'Edit' }))
    expect(deriveActionDescriptor(makeIntent({ id: 'i-1', lastWorkSessionId: 'sess-1' }))).toEqual({
      labelCode: 'permission_pending',
      target: { type: 'workcenter-event', eventId: 'e-perm' },
    })
  })

  it('ignores notification-only todos without a requestId', () => {
    findTodo.mockReturnValue(makeEvent({ id: 'e-note', requestId: null, toolName: null }))
    expect(
      deriveActionDescriptor(makeIntent({ id: 'i-1', lastWorkSessionId: 'sess-1' })),
    ).toBeNull()
  })

  it('derives spec_awaiting_approval when SDD is on and the spec is written but unapproved', () => {
    const intent = makeIntent({ id: 'i-1', status: 'todo', specPath: '/s.md', specApproved: false })
    expect(deriveActionDescriptor(intent)).toEqual({
      labelCode: 'spec_awaiting_approval',
      target: { type: 'intent-spec', intentId: 'i-1' },
    })
  })

  it('returns null when the spec is already approved', () => {
    expect(
      deriveActionDescriptor(
        makeIntent({ id: 'i-1', status: 'todo', specPath: '/s.md', specApproved: true }),
      ),
    ).toBeNull()
  })

  it('derives NOTHING for a raw spec with a path — seeding is not awaiting approval', () => {
    // write_spec seeds the document and backfills spec_path the same moment, so a
    // path that exists must not by itself send a human to approve an un-written
    // document. The status — not the path — decides.
    expect(
      deriveActionDescriptor(
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
      deriveActionDescriptor(
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
      deriveActionDescriptor(
        makeIntent({ id: 'i-1', status: 'todo', specPath: '/s.md', specApproved: false }),
      ),
    ).toBeNull()
  })

  it('returns null when the intent is not todo', () => {
    expect(
      deriveActionDescriptor(
        makeIntent({
          id: 'i-1',
          status: 'in_progress',
          specPath: '/s.md',
          specApproved: false,
        }),
      ),
    ).toBeNull()
  })

  it('does NOT derive spec_awaiting_approval for a raw spec that only has a seed path', () => {
    // write_spec backfilled the path the moment it seeded the placeholder, so a
    // path alone must not read as "written but unapproved" — that is the exact
    // false prompt this status exists to remove.
    expect(
      deriveActionDescriptor(
        makeIntent({ id: 'i-1', status: 'todo', specPath: '/s.md', specStatus: 'raw' }),
      ),
    ).toBeNull()
  })

  it('does NOT claim rework exhaustion for a raw spec, even with leftover review facts', () => {
    // A raw spec is never reviewed, so a leftover conclusion / rework counter
    // from an earlier life of the document must not surface the hand-over prompt.
    expect(
      deriveActionDescriptor(
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
    expect(deriveActionDescriptor(exhaustedIntent())).toEqual({
      labelCode: 'spec_rework_exhausted',
      target: { type: 'intent-spec', intentId: 'i-1' },
    })
  })

  it('still shows the plain approval prompt on the LAST allowed rework round', () => {
    // Round CAP is reworked automatically — the hand-over is the round after it.
    expect(
      deriveActionDescriptor(
        exhaustedIntent({ specReviewReworkRounds: MAX_SPEC_REVIEW_REWORK_ROUNDS }),
      ),
    ).toEqual({
      labelCode: 'spec_awaiting_approval',
      target: { type: 'intent-spec', intentId: 'i-1' },
    })
  })

  it('does not claim exhaustion when the current conclusion passed', () => {
    expect(deriveActionDescriptor(exhaustedIntent({ specReviewVerdict: 'pass' }))).toEqual({
      labelCode: 'spec_awaiting_approval',
      target: { type: 'intent-spec', intentId: 'i-1' },
    })
  })

  it('drops the prompt once the spec is edited and the old conclusion is stale', () => {
    liveFingerprint.mockReturnValue('fp2')
    expect(deriveActionDescriptor(exhaustedIntent())).toEqual({
      labelCode: 'spec_awaiting_approval',
      target: { type: 'intent-spec', intentId: 'i-1' },
    })
  })

  it('shows nothing while the spec is unreadable — unreadable is not unchanged', () => {
    liveFingerprint.mockReturnValue(null)
    expect(deriveActionDescriptor(exhaustedIntent())).toEqual({
      labelCode: 'spec_awaiting_approval',
      target: { type: 'intent-spec', intentId: 'i-1' },
    })
  })

  it('drops the prompt once the intent leaves the blocked state', () => {
    expect(deriveActionDescriptor(exhaustedIntent({ specApproved: true }))).toBeNull()
    expect(deriveActionDescriptor(exhaustedIntent({ status: 'in_progress' }))).toBeNull()
    sddOn.mockReturnValue(false)
    expect(deriveActionDescriptor(exhaustedIntent())).toBeNull()
  })

  it('yields to more urgent blocks (vendor, pending Ask) while exhausted', () => {
    vendorDesc.mockReturnValue({
      labelCode: 'vendor_auth_invalid',
      target: { type: 'system-settings-agent', vendor: 'claude', agentId: 'a1' },
    })
    expect(deriveActionDescriptor(exhaustedIntent())).toMatchObject({
      labelCode: 'vendor_auth_invalid',
    })
    vendorDesc.mockReturnValue(null)
    findTodo.mockReturnValue(makeEvent({ id: 'e-ask', toolName: 'AskUserQuestion' }))
    expect(deriveActionDescriptor(exhaustedIntent())).toMatchObject({
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
    deriveActionDescriptor(intent)
    expect(findTodo).toHaveBeenCalledWith('/proj', ['i-1', 'is', 'ss', 'rs', 'ws'])
  })
})
