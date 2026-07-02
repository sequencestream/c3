/**
 * PR-event MCP HTTP route (2026-06-20), the codex twin of the in-process publish
 * tool. Covers:
 *  - the loopback predicate (non-local peers rejected; defence in depth);
 *  - unknown-token rejection (404) at the route;
 *  - a REAL MCP client over streamable-HTTP listing + calling `publish_pr_event`
 *    (the codex integration path; AC3 codex + vendor-neutral parity with claude).
 * The publish behavior is injected, so this exercises the transport plumbing
 * end-to-end without codex's binary.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { serve, type ServerType } from '@hono/node-server'
import { Hono } from 'hono'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import {
  createPrEventMcp,
  PR_EVENT_MCP_PATH,
  isLoopback,
  type PrEventMcpTools,
  type ServedPrEventMcp,
} from './index.js'
import { runPublishPrEvent } from '../../features/pr-events/tool-defs.js'

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

describe('pr-event MCP HTTP route', () => {
  const published: unknown[] = []
  const tools: PrEventMcpTools = {
    // Use the real core so the route exercises validation + normalization + publish.
    publish: (binding, args) =>
      runPublishPrEvent(args, (event) =>
        published.push({
          workspacePath: binding.workspacePath,
          sessionId: binding.getRunId(),
          ...event,
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

  it('lists and calls publish_pr_event over a real MCP client', async () => {
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
      expect(list.tools.map((t) => t.name)).toContain('publish_pr_event')

      const res = (await client.callTool({
        name: 'publish_pr_event',
        arguments: { operation: 'comment', result: 'success', pr: { number: 5 } },
      })) as { isError?: boolean }
      expect(res.isError).toBeFalsy()
      expect(published).toContainEqual(
        expect.objectContaining({
          workspacePath: '/proj',
          sessionId: 'run-9',
          operation: 'comment',
          result: 'success',
        }),
      )
    } finally {
      await transport.close()
      bound.dispose()
    }
  })

  it('calls publish_pr_event with error result and intentTitle', async () => {
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
        name: 'publish_pr_event',
        arguments: {
          operation: 'review',
          result: 'error',
          pr: { id: 'pr-xyz' },
          association: { intentId: 'intent-1', intentTitle: 'Fix login' },
          errorSummary: 'CI pipeline timed out',
        },
      })) as { isError?: boolean }
      expect(res.isError).toBeFalsy()
      expect(published).toContainEqual(
        expect.objectContaining({
          workspacePath: '/proj',
          sessionId: 'run-10',
          operation: 'review',
          result: 'error',
          pr: { id: 'pr-xyz' },
          association: { intentId: 'intent-1', intentTitle: 'Fix login' },
          errorSummary: 'CI pipeline timed out',
        }),
      )
    } finally {
      await transport.close()
      bound.dispose()
    }
  })
})
