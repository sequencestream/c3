/**
 * Event MCP HTTP route, the codex twin of the in-process publish tool. Covers:
 *  - the loopback predicate (non-local peers rejected; defence in depth);
 *  - unknown-token rejection (404) at the route;
 *  - a REAL MCP client over streamable-HTTP listing + calling `publish_event`
 *    (the codex integration path; AC1/AC2 codex + vendor-neutral parity with
 *    claude).
 * The publish behavior is injected, so this exercises the transport plumbing
 * end-to-end without codex's binary.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { serve, type ServerType } from '@hono/node-server'
import { Hono } from 'hono'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { GenericEventEnvelope } from '@ccc/shared/protocol'
import {
  createPrEventMcp,
  PR_EVENT_MCP_PATH,
  isLoopback,
  type PrEventMcpTools,
  type ServedPrEventMcp,
} from './index.js'
import { EventNormalizerRegistry } from '../../kernel/events/generic-event.js'
import {
  PR_EVENT_TYPE,
  normalizePrGenericEvent,
  projectPrOperationEvent,
} from '../../features/pr-events/tool-defs.js'
import { runPublishEvent } from '../../features/events/tool-defs.js'

describe('isLoopback', () => {
  it.each([
    ['127.0.0.1', true],
    ['::1', true],
    ['::ffff:127.0.0.1', true],
    ['127.0.0.5', true],
    ['192.168.1.2', false],
    ['', false],
  ])('%s ⇒ %s', (addr, expected) => {
    expect(isLoopback(addr === '' ? undefined : addr)).toBe(expected)
  })
})

describe('event MCP HTTP route', () => {
  const published: GenericEventEnvelope[] = []
  const registry = new EventNormalizerRegistry()
  registry.register(PR_EVENT_TYPE, normalizePrGenericEvent)
  const tools: PrEventMcpTools = {
    // Use the real core so the route exercises validation + normalization + publish.
    publish: (binding, args) =>
      runPublishEvent(
        args,
        (core) => registry.normalize(core),
        (event) =>
          published.push({
            workspacePath: binding.workspacePath,
            sessionId: binding.getRunId(),
            event,
          }),
      ),
  }

  let server: ServerType
  let port: number
  let prEventMcp: ServedPrEventMcp

  let tokCounter = 0

  beforeAll(async () => {
    prEventMcp = createPrEventMcp('http://127.0.0.1', tools, () => `tok-${++tokCounter}`)
    const app = new Hono()
    app.all(PR_EVENT_MCP_PATH, (c) => prEventMcp.handler(c))
    await new Promise<void>((resolve) => {
      server = serve({ fetch: app.fetch, port: 0 }, (info) => {
        port = info.port
        resolve()
      })
    })
  })

  afterAll(() => {
    server?.close()
  })

  const routeUrl = (token: string): URL =>
    new URL(`http://127.0.0.1:${port}${PR_EVENT_MCP_PATH}?token=${token}`)

  it('rejects an unknown token with 404', async () => {
    const res = await fetch(routeUrl('nope'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    })
    expect(res.status).toBe(404)
  })

  it('lists and calls publish_event over a real MCP client', async () => {
    const bound = prEventMcp.bind({
      workspacePath: '/proj',
      getRunId: () => 'run-9',
      signal: new AbortController().signal,
    })
    // The bound descriptor's token (deterministic 'tok-1'); connect via the real
    // listening port (the origin passed to createPrEventMcp carries no port).
    expect(bound.servers.c3.url).toContain('tok-1')

    const client = new Client({ name: 'test', version: '1.0.0' })
    const transport = new StreamableHTTPClientTransport(routeUrl('tok-1'))
    await client.connect(transport)
    try {
      const list = await client.listTools()
      expect(list.tools.map((t) => t.name)).toContain('publish_event')

      const res = (await client.callTool({
        name: 'publish_event',
        arguments: {
          type: 'pr:operation',
          status: 'success',
          metadata: { operation: 'comment' },
          data: { pr: { number: 5 } },
        },
      })) as { isError?: boolean }
      expect(res.isError).toBeFalsy()
      const last = published[published.length - 1]
      expect(last.workspacePath).toBe('/proj')
      expect(last.sessionId).toBe('run-9')
      expect(projectPrOperationEvent(last.event)).toMatchObject({
        operation: 'comment',
        result: 'success',
        pr: { number: 5 },
      })
    } finally {
      await transport.close()
      bound.dispose()
    }
  })

  it('calls publish_event with error result and intentTitle', async () => {
    const bound = prEventMcp.bind({
      workspacePath: '/proj',
      getRunId: () => 'run-10',
      signal: new AbortController().signal,
    })

    const client = new Client({ name: 'test', version: '1.0.0' })
    const transport = new StreamableHTTPClientTransport(routeUrl('tok-2'))
    await client.connect(transport)
    try {
      const res = (await client.callTool({
        name: 'publish_event',
        arguments: {
          type: 'pr:operation',
          status: 'error',
          metadata: { operation: 'review' },
          description: 'CI pipeline timed out',
          data: {
            pr: { id: 'pr-xyz' },
            association: { intentId: 'intent-1', intentTitle: 'Fix login' },
          },
        },
      })) as { isError?: boolean }
      expect(res.isError).toBeFalsy()
      const last = published[published.length - 1]
      expect(last.workspacePath).toBe('/proj')
      expect(last.sessionId).toBe('run-10')
      expect(projectPrOperationEvent(last.event)).toMatchObject({
        operation: 'review',
        result: 'error',
        pr: { id: 'pr-xyz' },
        association: { intentId: 'intent-1', intentTitle: 'Fix login' },
        errorSummary: 'CI pipeline timed out',
      })
    } finally {
      await transport.close()
      bound.dispose()
    }
  })
})
