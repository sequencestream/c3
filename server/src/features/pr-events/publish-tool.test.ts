/**
 * Integration tests for the Claude in-process `publish_event` MCP server (AC1,
 * AC2, claude path). We drive the REAL handler the SDK registered
 * (`instance._registeredTools`), not a re-implementation, so the test fails if the
 * tool's wiring changes. Asserts the tool publishes the normalized generic event
 * wrapped in an envelope tagged with the bound workspace + live run id (which the
 * event's own metadata/data can never forge), and never raises a confirmation gate.
 */
import { describe, expect, it, vi } from 'vitest'
import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk'
import type { GenericEvent, GenericEventEnvelope } from '@ccc/shared/protocol'
import { EventNormalizerRegistry } from '../../kernel/events/generic-event.js'
import { createPublishEventMcpServer } from './publish-tool.js'
import { PR_EVENT_TYPE, normalizePrGenericEvent, projectPrOperationEvent } from './tool-defs.js'

/** The registry-backed normalize the composition root injects into the tool. */
function makeNormalize(): (core: GenericEvent) => ReturnType<EventNormalizerRegistry['normalize']> {
  const registry = new EventNormalizerRegistry()
  registry.register(PR_EVENT_TYPE, normalizePrGenericEvent)
  return (core) => registry.normalize(core)
}

interface CallToolResult {
  content: { type: string; text: string }[]
  isError?: boolean
}
type Handler = (args: unknown, extra: unknown) => Promise<CallToolResult>

function getHandler(servers: Record<string, McpServerConfig>, toolName: string): Handler {
  const c3 = servers.c3 as unknown as {
    instance: { _registeredTools: Record<string, { handler: Handler }> }
  }
  return c3.instance._registeredTools[toolName].handler
}

describe('createPublishEventMcpServer — publish_event (claude in-process)', () => {
  it('registers publish_event on the c3 server', () => {
    const servers = createPublishEventMcpServer(
      { workspacePath: '/proj', getRunId: () => 'run-1', signal: new AbortController().signal },
      { normalize: makeNormalize(), publish: vi.fn() },
    )
    expect(getHandler(servers, 'publish_event')).toBeTypeOf('function')
  })

  it('publishes a valid event tagged with the bound workspace + live run id', async () => {
    const published: GenericEventEnvelope[] = []
    let liveRunId = 'pending-1'
    const servers = createPublishEventMcpServer(
      { workspacePath: '/proj', getRunId: () => liveRunId, signal: new AbortController().signal },
      { normalize: makeNormalize(), publish: (p) => published.push(p) },
    )
    const handler = getHandler(servers, 'publish_event')

    // A pending→real rebind happens before the model calls the tool.
    liveRunId = 'real-7'
    const r = await handler(
      {
        type: 'pr:operation',
        status: 'success',
        metadata: { operation: 'merge' },
        data: { pr: { number: 3 } },
      },
      {},
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

  it('the event metadata/data can never forge the envelope workspace/session', async () => {
    const published: GenericEventEnvelope[] = []
    const servers = createPublishEventMcpServer(
      { workspacePath: '/proj', getRunId: () => 'run-2', signal: new AbortController().signal },
      { normalize: makeNormalize(), publish: (p) => published.push(p) },
    )
    const handler = getHandler(servers, 'publish_event')
    const r = await handler(
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
      {},
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

  it('publishes an update/success event carrying the intent association', async () => {
    const published: GenericEventEnvelope[] = []
    const servers = createPublishEventMcpServer(
      { workspacePath: '/proj', getRunId: () => 'run-3', signal: new AbortController().signal },
      { normalize: makeNormalize(), publish: (p) => published.push(p) },
    )
    const handler = getHandler(servers, 'publish_event')
    const r = await handler(
      {
        type: 'pr:operation',
        status: 'success',
        metadata: { operation: 'update' },
        data: { pr: { number: 9, state: 'open' }, association: { intentId: 'intent-42' } },
      },
      {},
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

  it('returns an isError result and publishes nothing for an illegal operation', async () => {
    const publish = vi.fn()
    const servers = createPublishEventMcpServer(
      { workspacePath: '/proj', getRunId: () => 'run-1', signal: new AbortController().signal },
      { normalize: makeNormalize(), publish },
    )
    const handler = getHandler(servers, 'publish_event')
    const r = await handler(
      { type: 'pr:operation', status: 'success', metadata: { operation: 'rebase' } },
      {},
    )
    expect(r.isError).toBe(true)
    expect(publish).not.toHaveBeenCalled()
  })

  it('returns an isError result and publishes nothing for an unregistered type', async () => {
    const publish = vi.fn()
    const servers = createPublishEventMcpServer(
      { workspacePath: '/proj', getRunId: () => 'run-1', signal: new AbortController().signal },
      { normalize: makeNormalize(), publish },
    )
    const handler = getHandler(servers, 'publish_event')
    const r = await handler({ type: 'unknown:type', status: 'success' }, {})
    expect(r.isError).toBe(true)
    expect(publish).not.toHaveBeenCalled()
  })
})
