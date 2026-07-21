/**
 * Envelope-tagging tests for `publish_event`, driven through the shared
 * `runPublishEvent` handler with the per-run binding closure replicated inline
 * (the closure the composition root builds): the publish sink tags the normalized
 * event with `{ workspacePath, sessionId: getRunId(), event }`. This proves:
 *  - a valid event is published once, tagged with the BOUND workspace + the LIVE
 *    run id (read at publish time, so a pending→real rebind is honored);
 *  - the event's own metadata/data can never forge the envelope workspace/session;
 *  - an update/success event carries the intent association through the normalizer;
 *  - a PR-normalizer rejection (illegal operation) publishes NOTHING.
 *
 * The framing-free core reject cases (unknown type, non-flat metadata, non-JSON
 * data, normalizer throws) live in tool-defs.test.ts and are not repeated here.
 */
import { describe, expect, it } from 'vitest'
import type { GenericEvent, GenericEventEnvelope } from '@ccc/shared'
import { EventNormalizerRegistry } from '../../kernel/events/generic-event.js'
import { runPublishEvent, type PublishEventArgs } from './tool-defs.js'
import {
  PR_EVENT_TYPES,
  PR_LEGACY_EVENT_TYPE,
  normalizePrGenericEvent,
  projectPrOperationEvent,
} from '../pr-events/tool-defs.js'

/** The registry-backed normalize the composition root injects into the tool. */
function makeNormalize(): (core: GenericEvent) => ReturnType<EventNormalizerRegistry['normalize']> {
  const registry = new EventNormalizerRegistry()
  for (const t of PR_EVENT_TYPES) registry.register(t, normalizePrGenericEvent)
  registry.register(PR_LEGACY_EVENT_TYPE, normalizePrGenericEvent)
  return (core) => registry.normalize(core)
}

/**
 * The per-run publish binding the composition root wraps around the framing-free
 * handler: normalize the core, then (on success) tag it with the bound workspace +
 * the LIVE run id and hand the envelope to the sink. Replicated here so the test
 * exercises exactly what the surface's closure does.
 */
function publishThroughBinding(
  binding: { workspacePath: string; getRunId: () => string },
  sink: GenericEventEnvelope[],
  core: PublishEventArgs,
): ReturnType<typeof runPublishEvent> {
  const normalize = makeNormalize()
  return runPublishEvent(core, normalize, (event) =>
    sink.push({ workspacePath: binding.workspacePath, sessionId: binding.getRunId(), event }),
  )
}

describe('publish_event envelope tagging (per-run binding closure)', () => {
  it('publishes a valid event tagged with the bound workspace + live run id', () => {
    const published: GenericEventEnvelope[] = []
    let liveRunId = 'pending-1'
    // A pending→real rebind happens before the model calls the tool.
    liveRunId = 'real-7'
    const r = publishThroughBinding(
      { workspacePath: '/proj', getRunId: () => liveRunId },
      published,
      {
        type: 'pr:operation',
        status: 'success',
        metadata: { operation: 'merge' },
        data: { pr: { number: 3 } },
      },
    )

    expect(r.isError).toBeUndefined()
    expect(published).toHaveLength(1)
    expect(published[0].workspacePath).toBe('/proj')
    expect(published[0].sessionId).toBe('real-7')
    expect(published[0].event.type).toBe('pr:operation')
    expect(projectPrOperationEvent(published[0].event)).toMatchObject({
      operation: 'merge',
      result: 'success',
      pr: { number: 3 },
    })
  })

  it('the event metadata/data can never forge the envelope workspace/session', () => {
    const published: GenericEventEnvelope[] = []
    const r = publishThroughBinding(
      { workspacePath: '/proj', getRunId: () => 'run-2' },
      published,
      {
        type: 'pr:operation',
        status: 'error',
        metadata: { operation: 'review' },
        // Forged same-name keys in data must be ignored by the normalizer.
        data: {
          workspacePath: 'evil',
          sessionId: 'evil',
          pr: { id: 'pr-abc' },
          association: { intentId: 'intent-1', intentTitle: 'Test intent' },
        },
      },
    )
    expect(r.isError).toBeUndefined()
    expect(published).toHaveLength(1)
    expect(published[0].workspacePath).toBe('/proj')
    expect(published[0].sessionId).toBe('run-2')
    expect(JSON.stringify(published[0].event)).not.toContain('evil')
    expect(projectPrOperationEvent(published[0].event)).toMatchObject({
      operation: 'review',
      result: 'error',
      pr: { id: 'pr-abc' },
      association: { intentId: 'intent-1', intentTitle: 'Test intent' },
    })
  })

  it('publishes an update/success event carrying the intent association', () => {
    const published: GenericEventEnvelope[] = []
    const r = publishThroughBinding(
      { workspacePath: '/proj', getRunId: () => 'run-3' },
      published,
      {
        type: 'pr:operation',
        status: 'success',
        metadata: { operation: 'update' },
        data: { pr: { number: 9, state: 'open' }, association: { intentId: 'intent-42' } },
      },
    )
    expect(r.isError).toBeUndefined()
    expect(published).toHaveLength(1)
    expect(published[0].workspacePath).toBe('/proj')
    expect(published[0].sessionId).toBe('run-3')
    expect(projectPrOperationEvent(published[0].event)).toMatchObject({
      operation: 'update',
      result: 'success',
      pr: { number: 9, state: 'open' },
      association: { intentId: 'intent-42' },
    })
  })

  it('returns an isError result and publishes nothing for an illegal PR operation', () => {
    const published: GenericEventEnvelope[] = []
    const r = publishThroughBinding(
      { workspacePath: '/proj', getRunId: () => 'run-1' },
      published,
      {
        type: 'pr:operation',
        status: 'success',
        metadata: { operation: 'rebase' },
      },
    )
    expect(r.isError).toBe(true)
    expect(published).toHaveLength(0)
  })
})
