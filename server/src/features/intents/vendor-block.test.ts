/**
 * Tests for the vendor-blocked next-step projection.
 *
 * Two things are pinned here: WHICH of the run layer's failure shapes deserve a
 * human action (only the two that never clear themselves), and that the derived
 * descriptor carries the failing agent's identity — and nothing else, in
 * particular no raw vendor error text and no credential.
 *
 * The store and the agent registry are mocked so the classification and the
 * session→intent attribution can be driven directly, without a database or a
 * settings file.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Intent, VendorId } from '@ccc/shared/protocol'

const intents: Intent[] = []
const agentVendors = new Map<string, VendorId>()

vi.mock('./store.js', () => ({
  listIntents: vi.fn(() => intents),
}))
vi.mock('../../kernel/config/index.js', () => ({
  getTimezone: vi.fn(() => 'UTC'),
}))
vi.mock('../../kernel/agent-config/index.js', async () => {
  // The reset-time parser is real: "is an automatic recovery already scheduled"
  // is exactly the behaviour under test, so mocking it would test nothing.
  const real = await vi.importActual<typeof import('../../kernel/agent-config/quota-reset.js')>(
    '../../kernel/agent-config/quota-reset.js',
  )
  return {
    parseQuotaResetAt: real.parseQuotaResetAt,
    resolveAgent: vi.fn((agentId: string) => ({
      id: agentId,
      vendor: agentVendors.get(agentId) ?? 'claude',
    })),
  }
})

const { registerPendingDevLink, resetForTests: resetDevLink } = await import('./dev-link.js')
const {
  classifyVendorBlock,
  clearVendorBlockForSession,
  deriveVendorActionDescriptor,
  noteVendorBlock,
  resetForTests,
} = await import('./vendor-block.js')

// 2026-01-01T00:00:00Z — a fixed "now" so the reset-time parser is deterministic.
const NOW = Date.UTC(2026, 0, 1, 0, 0, 0)

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
    createdAt: 0,
    updatedAt: 0,
    completedAt: null,
    runStatus: 'idle',
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
    sessionActive: false,
    actionDescriptor: null,
    ...overrides,
  }
}

beforeEach(() => {
  intents.length = 0
  agentVendors.clear()
  resetForTests()
  resetDevLink()
})

describe('classifyVendorBlock', () => {
  const classify = (error: string) => classifyVendorBlock(error, { timezone: 'UTC', now: NOW })

  it('classifies rejected credentials as vendor_auth_invalid', () => {
    expect(classify('API error 401: unauthorized')).toBe('vendor_auth_invalid')
    expect(classify('authentication_error: invalid api key')).toBe('vendor_auth_invalid')
    expect(classify('Invalid token provided')).toBe('vendor_auth_invalid')
  })

  it('classifies unrecoverable exhaustion as vendor_quota_exhausted', () => {
    expect(classify('insufficient_quota: you exceeded your current quota')).toBe(
      'vendor_quota_exhausted',
    )
    expect(classify('RESOURCE_EXHAUSTED')).toBe('vendor_quota_exhausted')
    expect(classify('Your credit balance is too low to access the API')).toBe(
      'vendor_quota_exhausted',
    )
  })

  it('produces nothing for a plain rate limit', () => {
    expect(classify('429 Too Many Requests: rate limit exceeded')).toBeNull()
  })

  it('produces nothing for a session limit that names its reset time', () => {
    // agent-quota-recovery already disables the agent and schedules the re-enable.
    expect(classify('5-hour session limit reached, resets at 3pm')).toBeNull()
    expect(classify('quota exceeded — resets at 11:30 pm')).toBeNull()
  })

  it('produces nothing for connection failures', () => {
    expect(classify('ECONNREFUSED: connection refused')).toBeNull()
    expect(classify('fetch failed: network error')).toBeNull()
  })

  it('produces nothing for server-side 5xx', () => {
    expect(classify('503 Service Unavailable')).toBeNull()
    expect(classify('500 internal server error')).toBeNull()
  })

  it('produces nothing for an empty error', () => {
    expect(classify('')).toBeNull()
  })
})

describe('noteVendorBlock — attribution and projection', () => {
  it('attributes a pre-bind failure through the pending launch link', () => {
    // Credentials are usually rejected before the session ever binds, so the
    // intent's stored session ids cannot name this run yet.
    intents.push(makeIntent({ id: 'i-1' }))
    agentVendors.set('agent-x', 'codex')
    registerPendingDevLink('pending:abc', 'i-1')

    expect(
      noteVendorBlock({
        sessionId: 'pending:abc',
        workspacePath: 'ws',
        agentId: 'agent-x',
        error: '401 unauthorized',
        now: NOW,
      }),
    ).toBe('i-1')
    expect(deriveVendorActionDescriptor({ id: 'i-1' })).toEqual({
      labelCode: 'vendor_auth_invalid',
      target: { type: 'system-settings-agent', vendor: 'codex', agentId: 'agent-x' },
    })
  })

  it('attributes a bound failure through the intent’s stored session ids', () => {
    intents.push(makeIntent({ id: 'i-2', specSessionId: 's-spec' }))
    agentVendors.set('agent-y', 'cursor')

    expect(
      noteVendorBlock({
        sessionId: 's-spec',
        workspacePath: 'ws',
        agentId: 'agent-y',
        error: 'insufficient_quota',
        now: NOW,
      }),
    ).toBe('i-2')
    expect(deriveVendorActionDescriptor({ id: 'i-2' })?.target).toEqual({
      type: 'system-settings-agent',
      vendor: 'cursor',
      agentId: 'agent-y',
    })
  })

  it('records nothing for a self-resolving failure', () => {
    intents.push(makeIntent({ id: 'i-3', lastWorkSessionId: 's-work' }))
    expect(
      noteVendorBlock({
        sessionId: 's-work',
        workspacePath: 'ws',
        agentId: 'agent-z',
        error: '429 rate limit exceeded',
        now: NOW,
      }),
    ).toBeNull()
    expect(deriveVendorActionDescriptor({ id: 'i-3' })).toBeNull()
  })

  it('records nothing when the run belongs to no intent', () => {
    expect(
      noteVendorBlock({
        sessionId: 's-console',
        workspacePath: 'ws',
        agentId: 'agent-z',
        error: '401 unauthorized',
        now: NOW,
      }),
    ).toBeNull()
  })

  it('never leaks the raw error or a credential into the descriptor', () => {
    intents.push(makeIntent({ id: 'i-4', lastWorkSessionId: 's-work' }))
    noteVendorBlock({
      sessionId: 's-work',
      workspacePath: 'ws',
      agentId: 'agent-z',
      error: '401 unauthorized: invalid api key sk-secret-123',
      now: NOW,
    })
    const serialized = JSON.stringify(deriveVendorActionDescriptor({ id: 'i-4' }))
    expect(serialized).not.toContain('sk-secret-123')
    expect(serialized).not.toContain('unauthorized')
    expect(Object.keys(JSON.parse(serialized))).toEqual(['labelCode', 'target'])
  })

  it('keeps the latest failure when a second one lands on the same intent', () => {
    intents.push(makeIntent({ id: 'i-5', lastWorkSessionId: 's-work' }))
    agentVendors.set('agent-a', 'claude')
    agentVendors.set('agent-b', 'codex')
    noteVendorBlock({
      sessionId: 's-work',
      workspacePath: 'ws',
      agentId: 'agent-a',
      error: '401 unauthorized',
      now: NOW,
    })
    noteVendorBlock({
      sessionId: 's-work',
      workspacePath: 'ws',
      agentId: 'agent-b',
      error: 'insufficient_quota',
      now: NOW + 1,
    })
    expect(deriveVendorActionDescriptor({ id: 'i-5' })).toEqual({
      labelCode: 'vendor_quota_exhausted',
      target: { type: 'system-settings-agent', vendor: 'codex', agentId: 'agent-b' },
    })
  })
})

describe('clearVendorBlockForSession', () => {
  it('drops the fact once a run for the same intent settles cleanly', () => {
    intents.push(makeIntent({ id: 'i-6', lastWorkSessionId: 's-work' }))
    noteVendorBlock({
      sessionId: 's-work',
      workspacePath: 'ws',
      agentId: 'agent-z',
      error: '401 unauthorized',
      now: NOW,
    })
    expect(clearVendorBlockForSession('s-work', 'ws')).toBe('i-6')
    expect(deriveVendorActionDescriptor({ id: 'i-6' })).toBeNull()
  })

  it('is a no-op when the intent has no recorded block', () => {
    intents.push(makeIntent({ id: 'i-7', lastWorkSessionId: 's-work' }))
    expect(clearVendorBlockForSession('s-work', 'ws')).toBeNull()
  })
})
