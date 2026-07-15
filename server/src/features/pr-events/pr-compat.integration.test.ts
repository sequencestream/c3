/**
 * PR event integration test (AC: model tool + server-side create share the single
 * generic publish link, and the two PR consumers both read the same envelope).
 * Both publish paths — the model's `publish_event` tool (now served over the
 * loopback HTTP MCP route for both vendors) and the server-side PR-create builder —
 * route through the SAME generic pipeline (kernel normalizer registry → normalized
 * `GenericEvent` → single `'event'` bus topic). The model path is exercised by
 * running the shared `runPublishEvent` handler with the SAME envelope-tagging
 * closure the composition root wires (`{ workspacePath, sessionId: getRunId() }`).
 * We assert:
 *  - a real `'event'` subscriber receives EXACTLY ONE envelope per business
 *    publish, projecting to the pre-existing `PrOperationEvent` fields;
 *  - the envelope carries the CLOSURE's workspace + the LIVE session id;
 *  - forged same-name data (`workspacePath` / `sessionId` in `data`) cannot
 *    override the envelope;
 *  - two independent subscribers both react to the same envelope and one throwing
 *    does not block the other (bus error isolation).
 */
import { describe, expect, it, vi } from 'vitest'
import type { GenericEvent, GenericEventEnvelope } from '@ccc/shared/protocol'
import { EventBus } from '../../kernel/events/event-bus.js'
import { EventNormalizerRegistry } from '../../kernel/events/generic-event.js'
import { runPublishEvent } from '../events/tool-defs.js'
import type { PublishEventArgs } from '../events/tool-defs.js'
import type { NormalizeResult } from '../../kernel/events/generic-event.js'
import {
  PR_EVENT_TYPES,
  PR_LEGACY_EVENT_TYPE,
  normalizePrGenericEvent,
  projectPrOperationEvent,
  runServerSidePrCreate,
} from './tool-defs.js'

/** The model `publish_event` path: the shared handler + the composition root's
 *  envelope-tagging closure (`{ workspacePath, sessionId: getRunId() }`). */
function modelPublish(
  binding: { workspacePath: string; getRunId: () => string },
  deps: {
    normalize: (core: GenericEvent) => NormalizeResult
    publish: (payload: GenericEventEnvelope) => void
  },
  rawArgs: PublishEventArgs,
): { isError?: boolean } {
  return runPublishEvent(rawArgs, deps.normalize, (event) =>
    deps.publish({ workspacePath: binding.workspacePath, sessionId: binding.getRunId(), event }),
  )
}

/** Assemble the composition-root pipeline exactly as `server.ts` does. */
function wire() {
  const eventBus = new EventBus()
  const received: GenericEventEnvelope[] = []
  // A stand-in for the Automation event bridge + intent PR-status reset consumers.
  eventBus.subscribe('event', (p) => {
    received.push(p)
  })

  const registry = new EventNormalizerRegistry()
  registry.register(PR_LEGACY_EVENT_TYPE, normalizePrGenericEvent)
  for (const t of PR_EVENT_TYPES) registry.register(t, normalizePrGenericEvent)
  const normalizeEvent = (core: GenericEvent) => registry.normalize(core)
  const publishEvent = (payload: GenericEventEnvelope) => eventBus.publish('event', payload)
  return { eventBus, received, normalizeEvent, publishEvent }
}

describe('PR event integration — model tool + server-side create share the generic link', () => {
  it('model publish_event delivers ONE envelope with closure workspace + live session', () => {
    const { received, normalizeEvent, publishEvent } = wire()
    let liveRunId = 'pending-1'
    const binding = { workspacePath: '/proj', getRunId: () => liveRunId }

    // A pending→real rebind happens before the model calls the tool.
    liveRunId = 'real-7'
    const r = modelPublish(
      binding,
      { normalize: normalizeEvent, publish: publishEvent },
      {
        type: 'pr:operation',
        status: 'success',
        metadata: { operation: 'review' },
        data: { pr: { number: 5 }, association: { intentId: 'I1' } },
      },
    )

    expect(r.isError).toBeUndefined()
    expect(received).toHaveLength(1)
    expect(received[0].workspacePath).toBe('/proj')
    expect(received[0].sessionId).toBe('real-7')
    expect(received[0].event.type).toBe(PR_LEGACY_EVENT_TYPE)
    expect(projectPrOperationEvent(received[0].event)).toEqual({
      operation: 'review',
      result: 'success',
      pr: { number: 5 },
      association: { intentId: 'I1' },
    })
  })

  it('forged workspacePath / sessionId in the model payload cannot override the envelope', () => {
    const { received, normalizeEvent, publishEvent } = wire()
    const binding = { workspacePath: '/proj', getRunId: () => 'real-9' }

    // The workspace/session live on the envelope wrapper; same-name keys smuggled
    // into `data` are ignored by the normalizer's field readers and never surface.
    modelPublish(
      binding,
      { normalize: normalizeEvent, publish: publishEvent },
      {
        type: 'pr:operation',
        status: 'success',
        metadata: { operation: 'merge' },
        data: {
          workspacePath: '/evil',
          sessionId: 'evil-session',
          pr: { number: 1 },
          association: { intentId: 'I2' },
        },
      },
    )

    expect(received).toHaveLength(1)
    expect(received[0].workspacePath).toBe('/proj')
    expect(received[0].sessionId).toBe('real-9')
    expect(JSON.stringify(received[0])).not.toContain('evil')
  })

  it('server-side PR create builder delivers ONE equivalent envelope through the same link', () => {
    const { received, normalizeEvent, publishEvent } = wire()
    runServerSidePrCreate(
      {
        prId: 'pr-42',
        prUrl: 'https://h/pull/42',
        headBranch: 'intent/i3-feature',
        baseBranch: undefined,
        intentId: 'I3',
      },
      normalizeEvent,
      (event) => publishEvent({ workspacePath: '/proj', sessionId: 'sess-3', event }),
    )

    expect(received).toHaveLength(1)
    expect(received[0].workspacePath).toBe('/proj')
    expect(received[0].sessionId).toBe('sess-3')
    expect(projectPrOperationEvent(received[0].event)).toEqual({
      operation: 'create',
      result: 'success',
      pr: { url: 'https://h/pull/42' },
      ref: { head: 'intent/i3-feature' },
      association: { intentId: 'I3' },
    })
  })

  it('two subscribers both react to one envelope; one throwing does not block the other', () => {
    const { eventBus, received, normalizeEvent, publishEvent } = wire()
    const other = vi.fn(() => {
      throw new Error('consumer A exploded')
    })
    const stable = vi.fn()
    // Register a throwing consumer BEFORE a stable one; the bus isolates the throw.
    eventBus.subscribe('event', other)
    eventBus.subscribe('event', stable)

    runServerSidePrCreate(
      { prId: 'pr-1', prUrl: null, headBranch: 'h', baseBranch: undefined, intentId: 'I5' },
      normalizeEvent,
      (event) => publishEvent({ workspacePath: '/proj', sessionId: 's', event }),
    )

    expect(received).toHaveLength(1)
    expect(other).toHaveBeenCalledTimes(1)
    expect(stable).toHaveBeenCalledTimes(1)
  })

  it('publishes NOTHING when the PR type is not registered (no old normalizePrEvent bypass)', () => {
    const eventBus = new EventBus()
    const received: GenericEventEnvelope[] = []
    eventBus.subscribe('event', (p) => {
      received.push(p)
    })
    const emptyRegistry = new EventNormalizerRegistry()
    const res = runServerSidePrCreate(
      { prId: 'pr-1', prUrl: null, headBranch: 'h', baseBranch: undefined, intentId: 'I4' },
      (core) => emptyRegistry.normalize(core),
      (event) => eventBus.publish('event', { workspacePath: '/proj', sessionId: 's', event }),
    )
    expect(res.ok).toBe(false)
    expect(received).toHaveLength(0)
  })
})
