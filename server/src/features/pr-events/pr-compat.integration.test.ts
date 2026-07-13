/**
 * PR compatibility integration test (AC: existing `pr:operation` consumer sees an
 * unchanged contract). Both publish paths — the model's `publish_pr_event` tool
 * (Claude in-process surface) and the server-side PR-create builder — route
 * through the SAME generic pipeline (kernel normalizer registry → compat bridge →
 * `pr:operation` bus topic). We assert:
 *  - a real `pr:operation` subscriber receives EXACTLY ONE payload per business
 *    publish, equivalent to the pre-existing `{ workspacePath, sessionId } &
 *    PrOperationEvent` contract;
 *  - the envelope carries the CLOSURE's workspace + the LIVE session id;
 *  - forged same-name data (`workspacePath` / `sessionId` in `data`) cannot
 *    override the envelope.
 */
import { describe, expect, it } from 'vitest'
import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk'
import type { GenericEvent, PrOperationEvent } from '@ccc/shared/protocol'
import { EventBus } from '../../kernel/events/event-bus.js'
import { EventNormalizerRegistry } from '../../kernel/events/generic-event.js'
import { createPrEventMcpServer } from './publish-tool.js'
import { PR_EVENT_TYPE, normalizePrGenericEvent, runServerSidePrCreate } from './tool-defs.js'

type BusPayload = { workspacePath: string; sessionId: string } & PrOperationEvent
type Handler = (args: unknown, extra: unknown) => Promise<{ isError?: boolean }>

function getHandler(servers: Record<string, McpServerConfig>): Handler {
  const c3 = servers.c3 as unknown as {
    instance: { _registeredTools: Record<string, { handler: Handler }> }
  }
  return c3.instance._registeredTools.publish_pr_event.handler
}

/** Assemble the composition-root pipeline exactly as `server.ts` does. */
function wire() {
  const eventBus = new EventBus()
  const received: BusPayload[] = []
  // A stand-in for the Automation event bridge + intent PR-status reset consumers.
  eventBus.subscribe('pr:operation', (p) => {
    received.push(p as BusPayload)
  })

  const registry = new EventNormalizerRegistry()
  registry.register(PR_EVENT_TYPE, normalizePrGenericEvent)
  const normalizeEvent = (core: GenericEvent) => registry.normalize(core)
  const publishPrEvent = (payload: BusPayload) => eventBus.publish('pr:operation', payload)
  return { received, normalizeEvent, publishPrEvent }
}

describe('PR compat integration — model tool + server-side create share the generic link', () => {
  it('model publish_pr_event delivers ONE envelope with closure workspace + live session', async () => {
    const { received, normalizeEvent, publishPrEvent } = wire()
    let liveRunId = 'pending-1'
    const servers = createPrEventMcpServer(
      { workspacePath: '/proj', getRunId: () => liveRunId, signal: new AbortController().signal },
      { normalize: normalizeEvent, publish: publishPrEvent },
    )
    const handler = getHandler(servers)

    // A pending→real rebind happens before the model calls the tool.
    liveRunId = 'real-7'
    const r = await handler(
      {
        operation: 'review',
        result: 'success',
        pr: { number: 5 },
        association: { intentId: 'I1' },
      },
      {},
    )

    expect(r.isError).toBeUndefined()
    expect(received).toHaveLength(1)
    expect(received[0]).toEqual({
      workspacePath: '/proj',
      sessionId: 'real-7',
      operation: 'review',
      result: 'success',
      pr: { number: 5 },
      association: { intentId: 'I1' },
    })
  })

  it('forged workspacePath / sessionId in the model payload cannot override the envelope', async () => {
    const { received, normalizeEvent, publishPrEvent } = wire()
    const servers = createPrEventMcpServer(
      { workspacePath: '/proj', getRunId: () => 'real-9', signal: new AbortController().signal },
      { normalize: normalizeEvent, publish: publishPrEvent },
    )
    const handler = getHandler(servers)

    // The model tool schema has no workspace/session fields; a hostile client
    // could still smuggle same-name keys into pr/association/etc. — they are
    // ignored by the normalizer's field readers and never reach the envelope.
    await handler(
      {
        operation: 'merge',
        result: 'success',
        pr: { number: 1, workspacePath: '/evil' },
        association: { intentId: 'I2', sessionId: 'evil-session' },
      },
      {},
    )

    expect(received).toHaveLength(1)
    expect(received[0].workspacePath).toBe('/proj')
    expect(received[0].sessionId).toBe('real-9')
    expect(JSON.stringify(received[0])).not.toContain('evil')
  })

  it('server-side PR create builder delivers ONE equivalent payload through the same link', () => {
    const { received, normalizeEvent, publishPrEvent } = wire()
    runServerSidePrCreate(
      {
        prId: 'pr-42',
        prUrl: 'https://h/pull/42',
        headBranch: 'intent/i3-feature',
        baseBranch: undefined,
        intentId: 'I3',
      },
      normalizeEvent,
      (event) => publishPrEvent({ workspacePath: '/proj', sessionId: 'sess-3', ...event }),
    )

    expect(received).toHaveLength(1)
    expect(received[0]).toEqual({
      workspacePath: '/proj',
      sessionId: 'sess-3',
      operation: 'create',
      result: 'success',
      pr: { url: 'https://h/pull/42' },
      ref: { head: 'intent/i3-feature' },
      association: { intentId: 'I3' },
    })
  })

  it('publishes NOTHING when the PR type is not registered (no old normalizePrEvent bypass)', () => {
    const eventBus = new EventBus()
    const received: BusPayload[] = []
    eventBus.subscribe('pr:operation', (p) => {
      received.push(p as BusPayload)
    })
    const emptyRegistry = new EventNormalizerRegistry()
    const res = runServerSidePrCreate(
      { prId: 'pr-1', prUrl: null, headBranch: 'h', baseBranch: undefined, intentId: 'I4' },
      (core) => emptyRegistry.normalize(core),
      (event) =>
        eventBus.publish('pr:operation', { workspacePath: '/proj', sessionId: 's', ...event }),
    )
    expect(res.ok).toBe(false)
    expect(received).toHaveLength(0)
  })
})
