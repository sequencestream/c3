/**
 * Unit tests for the intent-domain `pr:operation` update consumer
 * (`handlePrUpdateEvent`). Drives the pure handler with injected store/broadcast
 * fakes so the reset logic is verified without a live DB or event bus. Covers:
 * rejected/failed/closed each reset to reviewing (+ log + broadcast); merged and
 * other statuses are not reset; missing intentId, unknown intent, cross-workspace
 * intentId, non-success and non-update events are silently ignored.
 */
import { describe, expect, it, vi } from 'vitest'
import type { IntentPrStatus } from '@ccc/shared/protocol'
import {
  handlePrUpdateEvent,
  type PrOperationBusPayload,
  type PrUpdateConsumerDeps,
} from './pr-update-consumer.js'

type FakeIntent = { id: string; workspaceId: string; prStatus: IntentPrStatus | null }

function makeDeps(intent: FakeIntent | null): {
  deps: PrUpdateConsumerDeps
  setPrStatus: ReturnType<typeof vi.fn>
  safeInsertIntentLog: ReturnType<typeof vi.fn>
  broadcastIntents: ReturnType<typeof vi.fn>
} {
  const setPrStatus = vi.fn()
  const safeInsertIntentLog = vi.fn()
  const broadcastIntents = vi.fn()
  const deps: PrUpdateConsumerDeps = {
    getIntent: (id) => (intent && intent.id === id ? intent : null),
    // Fake identity mapping: the workspace path IS its id for the test.
    pathToId: (path) => (path ? `id:${path}` : null),
    setPrStatus,
    safeInsertIntentLog,
    broadcastIntents,
  }
  return { deps, setPrStatus, safeInsertIntentLog, broadcastIntents }
}

function payload(over: Partial<PrOperationBusPayload> = {}): PrOperationBusPayload {
  return {
    workspacePath: '/proj',
    sessionId: 'run-1',
    operation: 'update',
    result: 'success',
    association: { intentId: 'intent-1' },
    ...over,
  }
}

const WS_ID = 'id:/proj'

describe('handlePrUpdateEvent — resettable statuses', () => {
  it.each(['rejected', 'failed', 'closed'] as const)(
    'resets prStatus=%s to reviewing, logs pr_updated, and broadcasts',
    (from) => {
      const { deps, setPrStatus, safeInsertIntentLog, broadcastIntents } = makeDeps({
        id: 'intent-1',
        workspaceId: WS_ID,
        prStatus: from,
      })

      const changed = handlePrUpdateEvent(payload(), deps)

      expect(changed).toBe(true)
      expect(setPrStatus).toHaveBeenCalledWith('intent-1', 'reviewing')
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
    const { deps, setPrStatus, broadcastIntents } = makeDeps({
      id: 'intent-1',
      workspaceId: WS_ID,
      prStatus: 'merged',
    })
    expect(handlePrUpdateEvent(payload(), deps)).toBe(false)
    expect(setPrStatus).not.toHaveBeenCalled()
    expect(broadcastIntents).not.toHaveBeenCalled()
  })

  it('does not reset an already-reviewing intent', () => {
    const { deps, setPrStatus } = makeDeps({
      id: 'intent-1',
      workspaceId: WS_ID,
      prStatus: 'reviewing',
    })
    expect(handlePrUpdateEvent(payload(), deps)).toBe(false)
    expect(setPrStatus).not.toHaveBeenCalled()
  })

  it('does not reset when prStatus is null', () => {
    const { deps, setPrStatus } = makeDeps({
      id: 'intent-1',
      workspaceId: WS_ID,
      prStatus: null,
    })
    expect(handlePrUpdateEvent(payload(), deps)).toBe(false)
    expect(setPrStatus).not.toHaveBeenCalled()
  })

  it('ignores an event without an intentId', () => {
    const { deps, setPrStatus } = makeDeps({
      id: 'intent-1',
      workspaceId: WS_ID,
      prStatus: 'rejected',
    })
    expect(handlePrUpdateEvent(payload({ association: {} }), deps)).toBe(false)
    expect(setPrStatus).not.toHaveBeenCalled()
  })

  it('ignores an unknown intent without throwing', () => {
    const { deps, setPrStatus } = makeDeps(null)
    expect(handlePrUpdateEvent(payload(), deps)).toBe(false)
    expect(setPrStatus).not.toHaveBeenCalled()
  })

  it('ignores a cross-workspace intentId (workspace mismatch)', () => {
    const { deps, setPrStatus } = makeDeps({
      id: 'intent-1',
      workspaceId: 'id:/other-proj',
      prStatus: 'rejected',
    })
    expect(handlePrUpdateEvent(payload(), deps)).toBe(false)
    expect(setPrStatus).not.toHaveBeenCalled()
  })

  it('ignores a non-success result', () => {
    const { deps, setPrStatus } = makeDeps({
      id: 'intent-1',
      workspaceId: WS_ID,
      prStatus: 'rejected',
    })
    expect(handlePrUpdateEvent(payload({ result: 'failure' }), deps)).toBe(false)
    expect(setPrStatus).not.toHaveBeenCalled()
  })

  it('ignores a non-update operation', () => {
    const { deps, setPrStatus } = makeDeps({
      id: 'intent-1',
      workspaceId: WS_ID,
      prStatus: 'rejected',
    })
    expect(handlePrUpdateEvent(payload({ operation: 'review' }), deps)).toBe(false)
    expect(setPrStatus).not.toHaveBeenCalled()
  })

  it('swallows a store error and returns false', () => {
    const { deps } = makeDeps({ id: 'intent-1', workspaceId: WS_ID, prStatus: 'rejected' })
    deps.setPrStatus = () => {
      throw new Error('db down')
    }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(handlePrUpdateEvent(payload(), deps)).toBe(false)
    warn.mockRestore()
  })
})
