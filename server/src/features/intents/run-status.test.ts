/**
 * Tests for `enrichRunStatus` — the single send-time enrich boundary shared by
 * the list / refresh / broadcast paths. Focuses on the derived `sessionActive`
 * signal (any of intent / spec / work session running) and its independence
 * from the existing `runStatus` reconcile field. `isRunning` is mocked so a
 * controllable set of session ids counts as "running".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Intent } from '@ccc/shared/protocol'

const running = new Set<string>()
vi.mock('../../runs.js', () => ({
  isRunning: vi.fn((id: string) => running.has(id)),
}))

const { enrichRunStatus, cacheRunStatus, clearRunStatus } = await import('./run-status.js')

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
    intentSessionId: null,
    sessionActive: false,
    ...overrides,
  }
}

function enrichOne(overrides: Partial<Intent> & { id: string }): Intent {
  return enrichRunStatus([makeIntent(overrides)])[0]
}

beforeEach(() => running.clear())
afterEach(() => running.clear())

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
