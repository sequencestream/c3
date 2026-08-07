/**
 * Unit tests for the intent-domain PR update consumer (`handlePrUpdateEvent`),
 * which reads a generic `'event'` envelope. Drives the pure handler with injected
 * store/broadcast fakes so the reset logic is verified without a live DB or event
 * bus. Covers: rejected/failed/closed each reset to reviewing (+ log + broadcast);
 * merged and other statuses are not reset; missing intentId, unknown intent,
 * cross-workspace intentId, non-success, non-update and non-PR-type events are
 * silently ignored; and the locator rules — `association.deliveryId` / `pr.number`
 * address one row, disagreeing locators and a locator-less event with anything
 * other than exactly one ACTIVE PR are refused with an error log and no writes.
 */
import { describe, expect, it, vi } from 'vitest'
import type { IntentPr, IntentPrStatus } from '@ccc/shared/protocol'
import type {
  GenericEventEnvelope,
  PrEventAssociation,
  PrOperation,
  PrOperationResult,
  PrRef,
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
    pr?: PrRef
    type?: string
  } = {},
): GenericEventEnvelope {
  const operation = over.operation ?? 'update'
  const result = over.result ?? 'success'
  const association = over.association ?? { intentId: 'intent-1' }
  const data = {
    ...(Object.keys(association).length ? { association: { ...association } } : {}),
    ...(over.pr ? { pr: { ...over.pr } } : {}),
  }
  return {
    workspacePath: '/proj',
    sessionId: 'run-1',
    event: {
      type: over.type ?? 'pr:operation',
      status: result,
      metadata: { operation },
      ...(Object.keys(data).length ? { data } : {}),
    },
  }
}

/** Run the handler with `console.error` muted, returning the refusal lines it wrote. */
function captureRefusal(fn: () => boolean): { changed: boolean; errors: string[] } {
  const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
  const changed = fn()
  const errors = spy.mock.calls.map((c) => String(c[0]))
  spy.mockRestore()
  return { changed, errors }
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

      // Carries the PR number as its locator — `closed` is not "active", so the
      // no-locator fallback would (correctly) refuse to guess for that row.
      const changed = handlePrUpdateEvent(payload({ pr: { number: 1 } }), deps)

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

describe('handlePrUpdateEvent — locating the target PR', () => {
  /** An intent owning one mainline PR and one PR toward `delivery-a`. */
  function twoPrIntent(mainline: IntentPrStatus, delivery: IntentPrStatus): FakeIntent {
    return {
      id: 'intent-1',
      workspaceId: WS_ID,
      prs: [
        fakeIntentPr(mainline, { intentId: 'intent-1', number: '1', deliveryId: null }),
        fakeIntentPr(delivery, { intentId: 'intent-1', number: '2', deliveryId: 'delivery-a' }),
      ],
    }
  }

  it('resets exactly the PR named by association.deliveryId', () => {
    const { deps, upsertIntentPr } = makeDeps(twoPrIntent('rejected', 'rejected'))

    const changed = handlePrUpdateEvent(
      payload({ association: { intentId: 'intent-1', deliveryId: 'delivery-a' } }),
      deps,
    )

    expect(changed).toBe(true)
    expect(upsertIntentPr).toHaveBeenCalledWith(
      expect.objectContaining({ number: '2', deliveryId: 'delivery-a', status: 'reviewing' }),
    )
  })

  it('accepts deliveryId + number when both name the same row', () => {
    const { deps, upsertIntentPr } = makeDeps(twoPrIntent('rejected', 'rejected'))

    const changed = handlePrUpdateEvent(
      payload({
        association: { intentId: 'intent-1', deliveryId: 'delivery-a' },
        pr: { number: 2 },
      }),
      deps,
    )

    expect(changed).toBe(true)
    expect(upsertIntentPr).toHaveBeenCalledWith(expect.objectContaining({ number: '2' }))
  })

  it('refuses when deliveryId and number name different rows', () => {
    const { deps, upsertIntentPr, safeInsertIntentLog, broadcastIntents } = makeDeps(
      twoPrIntent('rejected', 'rejected'),
    )

    const { changed, errors } = captureRefusal(() =>
      handlePrUpdateEvent(
        payload({
          association: { intentId: 'intent-1', deliveryId: 'delivery-a' },
          pr: { number: 1 },
        }),
        deps,
      ),
    )

    expect(changed).toBe(false)
    expect(errors.join('\n')).toContain('指向不同的 PR 行')
    // A refusal writes NOTHING: no ledger row, no lifecycle log, no broadcast.
    expect(upsertIntentPr).not.toHaveBeenCalled()
    expect(safeInsertIntentLog).not.toHaveBeenCalled()
    expect(broadcastIntents).not.toHaveBeenCalled()
  })

  it('refuses a deliveryId no PR row carries', () => {
    const { deps, upsertIntentPr } = makeDeps(twoPrIntent('rejected', 'rejected'))

    const { changed } = captureRefusal(() =>
      handlePrUpdateEvent(
        payload({ association: { intentId: 'intent-1', deliveryId: 'delivery-z' } }),
        deps,
      ),
    )

    expect(changed).toBe(false)
    expect(upsertIntentPr).not.toHaveBeenCalled()
  })

  it('refuses a PR number no row carries', () => {
    const { deps, upsertIntentPr } = makeDeps(twoPrIntent('rejected', 'rejected'))

    const { changed } = captureRefusal(() =>
      handlePrUpdateEvent(payload({ pr: { number: 99 } }), deps),
    )

    expect(changed).toBe(false)
    expect(upsertIntentPr).not.toHaveBeenCalled()
  })

  it('falls back to the single active PR when the event carries no locator', () => {
    // The mainline row is merged (terminal), leaving exactly one active row.
    const { deps, upsertIntentPr } = makeDeps(twoPrIntent('merged', 'rejected'))

    expect(handlePrUpdateEvent(payload(), deps)).toBe(true)
    expect(upsertIntentPr).toHaveBeenCalledWith(expect.objectContaining({ number: '2' }))
  })

  it('refuses a locator-less event when several PRs are active', () => {
    const { deps, upsertIntentPr, broadcastIntents } = makeDeps(twoPrIntent('rejected', 'rejected'))

    const { changed, errors } = captureRefusal(() => handlePrUpdateEvent(payload(), deps))

    expect(changed).toBe(false)
    expect(errors.join('\n')).toContain('2 条活跃 PR')
    expect(upsertIntentPr).not.toHaveBeenCalled()
    expect(broadcastIntents).not.toHaveBeenCalled()
  })

  it('refuses a locator-less event when only closed rows remain', () => {
    // `closed` IS resettable, but it is not ACTIVE — so it can only be reached
    // by an event that says which row it means.
    const { deps, upsertIntentPr } = makeDeps({
      id: 'intent-1',
      workspaceId: WS_ID,
      prs: [fakeIntentPr('closed', { intentId: 'intent-1', number: '1' })],
    })

    const { changed } = captureRefusal(() => handlePrUpdateEvent(payload(), deps))

    expect(changed).toBe(false)
    expect(upsertIntentPr).not.toHaveBeenCalled()
  })
})

describe('handlePrUpdateEvent — ignored cases', () => {
  it('does not reset a merged intent (terminal state)', () => {
    const { deps, upsertIntentPr, broadcastIntents } = makeDeps({
      id: 'intent-1',
      workspaceId: WS_ID,
      prs: [fakeIntentPr('merged', { intentId: 'intent-1', number: '1' })],
    })
    // Located by number, so this exercises the terminal-status guard itself and
    // not the locator's refusal (a merged row is not "active").
    expect(handlePrUpdateEvent(payload({ pr: { number: 1 } }), deps)).toBe(false)
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
    const { changed } = captureRefusal(() => handlePrUpdateEvent(payload(), deps))
    expect(changed).toBe(false)
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
