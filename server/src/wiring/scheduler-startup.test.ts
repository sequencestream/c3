/**
 * Unit tests for the generic `'event'` → `pr:operation` automation dispatch bridge
 * (`dispatchPrEventFromEnvelope`). The bridge is what lets a model-published generic
 * envelope still drive event-triggered automations: it discriminates the PR type
 * and projects operation/result off the normalized event before the existing
 * dispatch runs its topic/workspace/PR filter/in-flight gate.
 */
import { describe, expect, it, vi } from 'vitest'
import type { GenericEventEnvelope } from '@ccc/shared/protocol'
import { dispatchPrEventFromEnvelope } from './scheduler-startup.js'

function envelope(
  event: GenericEventEnvelope['event'],
  over: Partial<Pick<GenericEventEnvelope, 'workspacePath' | 'sessionId'>> = {},
): GenericEventEnvelope {
  return { workspacePath: '/proj', sessionId: 'run-1', event, ...over }
}

describe('dispatchPrEventFromEnvelope', () => {
  it('projects operation/result and forwards the pr:operation dispatch payload', () => {
    const dispatch = vi.fn()
    dispatchPrEventFromEnvelope(
      envelope({
        type: 'pr:operation',
        status: 'success',
        metadata: { operation: 'merge' },
        data: { pr: { number: 3 } },
      }),
      dispatch,
    )
    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'run-1',
        workspacePath: '/proj',
        operation: 'merge',
        result: 'success',
      }),
    )
  })

  it('does NOT dispatch for a non-pr:operation event type', () => {
    const dispatch = vi.fn()
    dispatchPrEventFromEnvelope(envelope({ type: 'other:event', status: 'success' }), dispatch)
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('does NOT dispatch when operation/result are not valid enums', () => {
    const dispatch = vi.fn()
    dispatchPrEventFromEnvelope(
      envelope({ type: 'pr:operation', status: 'maybe', metadata: { operation: 'rebase' } }),
      dispatch,
    )
    expect(dispatch).not.toHaveBeenCalled()
  })
})
