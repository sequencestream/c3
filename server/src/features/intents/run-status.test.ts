/**
 * Tests for `enrichRunStatus` — the single send-time enrich boundary shared by
 * the list / refresh / broadcast paths. Focuses on the derived `sessionActive`
 * signal (any of intent / spec / work session running), the derived
 * `actionDescriptor` projection, and their independence from the existing
 * `runStatus` reconcile field. `isRunning` and the vendor-block fact table are
 * mocked so a controllable set of session ids counts as "running" and a
 * controllable set of intents counts as blocked.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ActionDescriptor, Intent } from '@ccc/shared/protocol'

const running = new Set<string>()
vi.mock('../../runs.js', () => ({
  isRunning: vi.fn((id: string) => running.has(id)),
}))

const blocked = new Map<string, ActionDescriptor>()
/** The loader each derivation was handed, so the ledger plumbing is observable. */
const loaders: ((workspacePath: string) => Intent[])[] = []
vi.mock('./action-descriptor.js', () => ({
  deriveActionDescriptor: vi.fn((r: { id: string }, load: (p: string) => Intent[]) => {
    loaders.push(load)
    return blocked.get(r.id) ?? null
  }),
}))

const ledger = new Map<string, Intent[]>()
const listIntentsMock = vi.fn((workspacePath: string) => ledger.get(workspacePath) ?? [])
vi.mock('./store.js', () => ({
  listIntents: (workspacePath: string) => listIntentsMock(workspacePath),
}))

const { enrichRunStatus, cacheRunStatus, clearRunStatus } = await import('./run-status.js')

const AUTH_BLOCKED: ActionDescriptor = {
  labelCode: 'vendor_auth_invalid',
  target: { type: 'system-settings-agent', vendor: 'claude', agentId: 'agent-1' },
}

function makeIntent(overrides: Partial<Intent> & { id: string }): Intent {
  return {
    workspaceId: 'ws',
    title: 'T',
    shortEnTitle: null,
    content: '',
    priority: 'P1',
    module: '',
    status: 'draft',
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

function enrichOne(overrides: Partial<Intent> & { id: string }): Intent {
  return enrichRunStatus([makeIntent(overrides)])[0]
}

beforeEach(() => {
  running.clear()
  blocked.clear()
  loaders.length = 0
  ledger.clear()
  listIntentsMock.mockClear()
})
afterEach(() => {
  running.clear()
  blocked.clear()
})

describe('enrichRunStatus — sessionActive derivation', () => {
  it('is true when only intentSessionId is running', () => {
    running.add('s-intent')
    expect(enrichOne({ id: 'a', intentSessionId: 's-intent' }).sessionActive).toBe(true)
  })

  it('is true when only specSessionId is running', () => {
    running.add('s-spec')
    expect(enrichOne({ id: 'a', specSessionId: 's-spec' }).sessionActive).toBe(true)
  })

  it('is true when only lastWorkSessionId is running', () => {
    running.add('s-work')
    expect(enrichOne({ id: 'a', lastWorkSessionId: 's-work' }).sessionActive).toBe(true)
  })

  it('is true when multiple session ids run simultaneously', () => {
    running.add('s-intent')
    running.add('s-work')
    const r = enrichOne({
      id: 'a',
      intentSessionId: 's-intent',
      specSessionId: 's-spec',
      lastWorkSessionId: 's-work',
    })
    expect(r.sessionActive).toBe(true)
  })

  it('is false when all session ids are null', () => {
    expect(enrichOne({ id: 'a' }).sessionActive).toBe(false)
  })

  it('is false when ids exist but none is running', () => {
    const r = enrichOne({
      id: 'a',
      intentSessionId: 's-intent',
      specSessionId: 's-spec',
      lastWorkSessionId: 's-work',
    })
    expect(r.sessionActive).toBe(false)
  })

  it('derives active for non-in_progress intents too (draft with running intent session)', () => {
    running.add('s-intent')
    const r = enrichOne({ id: 'a', status: 'draft', intentSessionId: 's-intent' })
    expect(r.sessionActive).toBe(true)
    // runStatus untouched for non-in_progress items.
    expect(r.runStatus).toBe('idle')
  })
})

describe('enrichRunStatus — runStatus independence', () => {
  afterEach(() => clearRunStatus('a'))

  it('sessionActive=true co-exists with runStatus=dangling (spec session runs, work session dead)', () => {
    running.add('s-spec')
    cacheRunStatus('a', 'dangling')
    const r = enrichOne({
      id: 'a',
      status: 'in_progress',
      specSessionId: 's-spec',
      lastWorkSessionId: 's-work-dead',
    })
    expect(r.sessionActive).toBe(true)
    expect(r.runStatus).toBe('dangling')
  })

  it('running work session sets both runStatus=running and sessionActive=true', () => {
    running.add('s-work')
    const r = enrichOne({
      id: 'a',
      status: 'in_progress',
      lastWorkSessionId: 's-work',
    })
    expect(r.runStatus).toBe('running')
    expect(r.sessionActive).toBe(true)
  })

  it('does not rewrite the item runStatus when no reconcile data and no running work session', () => {
    const r = enrichOne({
      id: 'a',
      status: 'in_progress',
      runStatus: 'dangling',
      lastWorkSessionId: 's-work-dead',
    })
    expect(r.runStatus).toBe('dangling')
    expect(r.sessionActive).toBe(false)
  })
})

describe('enrichRunStatus — actionDescriptor projection', () => {
  afterEach(() => clearRunStatus('a'))

  it('is null when nothing blocks the intent', () => {
    expect(enrichOne({ id: 'a' }).actionDescriptor).toBeNull()
  })

  it('carries the recorded block for a blocked intent', () => {
    blocked.set('a', AUTH_BLOCKED)
    expect(enrichOne({ id: 'a' }).actionDescriptor).toEqual(AUTH_BLOCKED)
  })

  it('is derived for every status, not just in_progress', () => {
    blocked.set('a', AUTH_BLOCKED)
    for (const status of ['draft', 'todo', 'in_progress', 'blocked', 'failed'] as const) {
      expect(enrichOne({ id: 'a', status }).actionDescriptor).toEqual(AUTH_BLOCKED)
    }
  })

  it('leaves runStatus and sessionActive untouched', () => {
    // A blocked intent whose work session is still alive must keep BOTH signals:
    // the descriptor is a next-step hint, never a state override.
    blocked.set('a', AUTH_BLOCKED)
    running.add('s-work')
    const r = enrichOne({ id: 'a', status: 'in_progress', lastWorkSessionId: 's-work' })
    expect(r.runStatus).toBe('running')
    expect(r.sessionActive).toBe(true)
    expect(r.actionDescriptor).toEqual(AUTH_BLOCKED)
  })

  it('derives per item, so a healthy sibling stays null', () => {
    blocked.set('a', AUTH_BLOCKED)
    const [a, b] = enrichRunStatus([makeIntent({ id: 'a' }), makeIntent({ id: 'b' })])
    expect(a.actionDescriptor).toEqual(AUTH_BLOCKED)
    expect(b.actionDescriptor).toBeNull()
  })

  it('re-derives on every send, so a cleared fact returns to null', () => {
    blocked.set('a', AUTH_BLOCKED)
    expect(enrichOne({ id: 'a' }).actionDescriptor).toEqual(AUTH_BLOCKED)
    blocked.delete('a')
    expect(enrichOne({ id: 'a' }).actionDescriptor).toBeNull()
  })

  it('never mutates its input (the stored projection stays null)', () => {
    blocked.set('a', AUTH_BLOCKED)
    const input = makeIntent({ id: 'a' })
    enrichRunStatus([input])
    expect(input.actionDescriptor).toBeNull()
  })

  it('hands the derivation the WHOLE workspace ledger, not the batch being enriched', () => {
    // The batch may be status-filtered (`list_intents` with a status); a
    // predecessor filtered out of the view is still a predecessor, so resolving
    // dependencies against the batch would make a filtered list and a broadcast
    // disagree about the same block.
    const full = [makeIntent({ id: 'a' }), makeIntent({ id: 'b' })]
    ledger.set('/proj', full)
    enrichRunStatus([makeIntent({ id: 'a' })])
    expect(loaders).toHaveLength(1)
    expect(loaders[0]('/proj')).toEqual(full)
  })

  it('reads that ledger at most once per workspace per pass, and only when asked', () => {
    ledger.set('/proj', [])
    enrichRunStatus([makeIntent({ id: 'a' }), makeIntent({ id: 'b' })])
    // Nothing asked for it: an intent with no dependency costs no query.
    expect(listIntentsMock).not.toHaveBeenCalled()
    for (const load of loaders) load('/proj')
    expect(listIntentsMock).toHaveBeenCalledTimes(1)
  })
})

/**
 * Structural guard: every `intents` frame the server sends must go through this
 * one enrich boundary. A send site that reached for `listIntents` directly would
 * ship an intent with `actionDescriptor: null` (and a stale `sessionActive`), so
 * the list, a refresh and a broadcast would disagree about whether the same
 * intent is blocked — exactly the split this projection exists to prevent.
 */
describe('intents send sites', () => {
  const HERE = path.dirname(fileURLToPath(import.meta.url))
  const SEND_SITE_FILES = [
    path.join(HERE, 'index.ts'),
    path.join(HERE, '../../wiring/broadcasts.ts'),
  ]

  it('all enrich the items they send', () => {
    const unenriched: string[] = []
    for (const file of SEND_SITE_FILES) {
      const lines = readFileSync(file, 'utf8').split('\n')
      lines.forEach((line, i) => {
        if (!/\blistIntents\(/.test(line)) return
        // Only the lines that build a frame's `items`; other call sites read the
        // ledger for internal logic and never reach the wire.
        if (!/\bitems\b/.test(line)) return
        if (/enrichRunStatus\(/.test(line)) return
        unenriched.push(`${path.basename(file)}:${i + 1}: ${line.trim()}`)
      })
    }
    expect(unenriched).toEqual([])
  })
})
