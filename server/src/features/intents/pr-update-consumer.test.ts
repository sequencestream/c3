/**
 * Unit tests for the intent-domain PR update consumer (`handlePrUpdateEvent`),
 * which reads a generic `'event'` envelope. Drives the pure handler with injected
 * store/broadcast fakes so the reset logic is verified without a live DB or event
 * bus. Covers: rejected/failed/closed each reset to reviewing (+ log + broadcast);
 * merged and other statuses are not reset; missing intentId, unknown intent,
 * cross-workspace intentId, non-success, non-update and non-PR-type events are
 * silently ignored.
 */
import { describe, expect, it, vi } from 'vitest'
import type { IntentPr, IntentPrStatus } from '@ccc/shared/protocol'
import type {
  GenericEventEnvelope,
  PrEventAssociation,
  PrOperation,
  PrOperationResult,
} from '@ccc/shared'
import { fakeIntentPr } from './intent-pr-fixture.js'
import { handlePrUpdateEvent, type PrUpdateConsumerDeps } from './pr-update-consumer.js'

type FakeIntent = { id: string; workspaceId: string; prs: IntentPr[] }

function makeDeps(intent: FakeIntent | null): {
  deps: PrUpdateConsumerDeps
  upsertIntentPr: ReturnType<typeof vi.fn>
  safeInsertIntentLog: ReturnType<typeof vi.fn>
  broadcastIntents: ReturnType<typeof vi.fn>
} {
  const upsertIntentPr = vi.fn()
  const safeInsertIntentLog = vi.fn()
  const broadcastIntents = vi.fn()
  const deps: PrUpdateConsumerDeps = {
    getIntent: (id) => (intent && intent.id === id ? intent : null),
    // Fake identity mapping: the workspace path IS its id for the test.
    pathToId: (path) => (path ? `id:${path}` : null),
    upsertIntentPr,
    safeInsertIntentLog,
    broadcastIntents,
  }
  return { deps, upsertIntentPr, safeInsertIntentLog, broadcastIntents }
}

/** Build a generic `'event'` envelope carrying a `pr:operation` core. */
function payload(
  over: {
    operation?: PrOperation
    result?: PrOperationResult
    association?: PrEventAssociation
    type?: string
  } = {},
): GenericEventEnvelope {
  const operation = over.operation ?? 'update'
  const result = over.result ?? 'success'
  const association = over.association ?? { intentId: 'intent-1' }
  return {
    workspacePath: '/proj',
    sessionId: 'run-1',
    event: {
      type: over.type ?? 'pr:operation',
      status: result,
      metadata: { operation },
      ...(Object.keys(association).length ? { data: { association: { ...association } } } : {}),
    },
  }
}

const WS_ID = 'id:/proj'

describe('handlePrUpdateEvent — resettable statuses', () => {
  it.each(['rejected', 'failed', 'closed'] as const)(
    'resets a %s PR row to reviewing, logs pr_updated, and broadcasts',
    (from) => {
      const { deps, upsertIntentPr, safeInsertIntentLog, broadcastIntents } = makeDeps({
        id: 'intent-1',
        workspaceId: WS_ID,
        prs: [fakeIntentPr(from, { intentId: 'intent-1', number: '1' })],
      })

      const changed = handlePrUpdateEvent(payload(), deps)

      expect(changed).toBe(true)
      expect(upsertIntentPr).toHaveBeenCalledWith(
        expect.objectContaining({ intentId: 'intent-1', number: '1', status: 'reviewing' }),
      )
      expect(safeInsertIntentLog).toHaveBeenCalledWith(
        'intent-1',
        'pr_updated',
        expect.stringContaining('reviewing'),
        'automation',
      )
      expect(broadcastIntents).toHaveBeenCalledWith('/proj')
    },
  )
})

describe('handlePrUpdateEvent — ignored cases', () => {
  it('does not reset a merged intent (terminal state)', () => {
    const { deps, upsertIntentPr, broadcastIntents } = makeDeps({
      id: 'intent-1',
      workspaceId: WS_ID,
      prs: [fakeIntentPr('merged', { intentId: 'intent-1', number: '1' })],
    })
    expect(handlePrUpdateEvent(payload(), deps)).toBe(false)
    expect(upsertIntentPr).not.toHaveBeenCalled()
    expect(broadcastIntents).not.toHaveBeenCalled()
  })

  it('does not reset an already-reviewing intent', () => {
    const { deps, upsertIntentPr } = makeDeps({
      id: 'intent-1',
      workspaceId: WS_ID,
      prs: [fakeIntentPr('reviewing', { intentId: 'intent-1', number: '1' })],
    })
    expect(handlePrUpdateEvent(payload(), deps)).toBe(false)
    expect(upsertIntentPr).not.toHaveBeenCalled()
  })

  it('does not reset when the intent owns no PR', () => {
    const { deps, upsertIntentPr } = makeDeps({
      id: 'intent-1',
      workspaceId: WS_ID,
      prs: [],
    })
    expect(handlePrUpdateEvent(payload(), deps)).toBe(false)
    expect(upsertIntentPr).not.toHaveBeenCalled()
  })

  it('ignores an event without an intentId', () => {
    const { deps, upsertIntentPr } = makeDeps({
      id: 'intent-1',
      workspaceId: WS_ID,
      prs: [fakeIntentPr('rejected', { intentId: 'intent-1', number: '1' })],
    })
    expect(handlePrUpdateEvent(payload({ association: {} }), deps)).toBe(false)
    expect(upsertIntentPr).not.toHaveBeenCalled()
  })

  it('ignores an unknown intent without throwing', () => {
    const { deps, upsertIntentPr } = makeDeps(null)
    expect(handlePrUpdateEvent(payload(), deps)).toBe(false)
    expect(upsertIntentPr).not.toHaveBeenCalled()
  })

  it('ignores a cross-workspace intentId (workspace mismatch)', () => {
    const { deps, upsertIntentPr } = makeDeps({
      id: 'intent-1',
      workspaceId: 'id:/other-proj',
      prs: [fakeIntentPr('rejected', { intentId: 'intent-1', number: '1' })],
    })
    expect(handlePrUpdateEvent(payload(), deps)).toBe(false)
    expect(upsertIntentPr).not.toHaveBeenCalled()
  })

  it('ignores a non-success result', () => {
    const { deps, upsertIntentPr } = makeDeps({
      id: 'intent-1',
      workspaceId: WS_ID,
      prs: [fakeIntentPr('rejected', { intentId: 'intent-1', number: '1' })],
    })
    expect(handlePrUpdateEvent(payload({ result: 'failure' }), deps)).toBe(false)
    expect(upsertIntentPr).not.toHaveBeenCalled()
  })

  it('ignores a non-update operation', () => {
    const { deps, upsertIntentPr } = makeDeps({
      id: 'intent-1',
      workspaceId: WS_ID,
      prs: [fakeIntentPr('rejected', { intentId: 'intent-1', number: '1' })],
    })
    expect(handlePrUpdateEvent(payload({ operation: 'review' }), deps)).toBe(false)
    expect(upsertIntentPr).not.toHaveBeenCalled()
  })

  it('ignores a non-pr:operation event type', () => {
    const { deps, upsertIntentPr } = makeDeps({
      id: 'intent-1',
      workspaceId: WS_ID,
      prs: [fakeIntentPr('rejected', { intentId: 'intent-1', number: '1' })],
    })
    expect(handlePrUpdateEvent(payload({ type: 'other:event' }), deps)).toBe(false)
    expect(upsertIntentPr).not.toHaveBeenCalled()
  })

  it('swallows a store error and returns false', () => {
    const { deps } = makeDeps({
      id: 'intent-1',
      workspaceId: WS_ID,
      prs: [fakeIntentPr('rejected', { intentId: 'intent-1', number: '1' })],
    })
    deps.upsertIntentPr = () => {
      throw new Error('db down')
    }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(handlePrUpdateEvent(payload(), deps)).toBe(false)
    warn.mockRestore()
  })
})
