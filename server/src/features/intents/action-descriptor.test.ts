/**
 * Tests for the composed next-step action-descriptor projection:
 * vendor > wait-user (Ask / permission) > spec awaiting approval.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Intent, WaitUserInvolveEvent } from '@ccc/shared/protocol'

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
})

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
