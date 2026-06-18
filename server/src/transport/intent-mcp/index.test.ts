/**
 * Intent MCP HTTP route (2026-06-12-005). Covers:
 *  - the loopback predicate (non-local peers rejected; defence in depth);
 *  - unknown-token rejection (404) at the route;
 *  - a REAL MCP client over streamable-HTTP listing + calling all three tools
 *    (the codex integration path: find/view read-only, save through the gate).
 * Tool behaviors are injected, so this exercises the transport plumbing end-to-end
 * without codex's binary.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { serve, type ServerType } from '@hono/node-server'
import { Hono } from 'hono'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import {
  createIntentMcp,
  INTENT_MCP_PATH,
  isLoopback,
  type IntentMcpTools,
  type ServedIntentMcp,
} from './index.js'

describe('isLoopback', () => {
  it.each([
    ['127.0.0.1', true],
    ['::1', true],
    ['::ffff:127.0.0.1', true],
    ['127.0.0.5', true],
    ['192.168.1.2', false],
    ['10.0.0.1', false],
    ['', false],
  ])('%s ⇒ %s', (addr, expected) => {
    expect(isLoopback(addr === '' ? undefined : addr)).toBe(expected)
  })
})

describe('intent MCP HTTP route', () => {
  const saved: unknown[] = []
  const tools: IntentMcpTools = {
    find: () => ({ content: [{ type: 'text', text: 'FOUND' }] }),
    view: () => ({ content: [{ type: 'text', text: 'VIEWED' }] }),
    save: async (_binding, args) => {
      saved.push(args)
      return { content: [{ type: 'text', text: 'SAVED' }] }
    },
  }

  let server: ServerType
  let port: number
  let intentMcp: ServedIntentMcp

  beforeAll(async () => {
    intentMcp = createIntentMcp('http://127.0.0.1', tools, () => 'tok-1')
    const app = new Hono()
    app.all(INTENT_MCP_PATH, (c) => intentMcp.handler(c))
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
    new URL(`http://127.0.0.1:${port}${INTENT_MCP_PATH}?token=${token}`)

  it('rejects an unknown token with 404', async () => {
    const r = await fetch(routeUrl('nope'), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    })
    expect(r.status).toBe(404)
  })

  it('lists and calls all three tools via a real streamable-HTTP MCP client', async () => {
    const { dispose } = intentMcp.bind({
      workspacePath: '/abs/p',
      getRunId: () => 'run-1',
      signal: new AbortController().signal,
    })
    const client = new Client({ name: 'test', version: '1.0.0' })
    const transport = new StreamableHTTPClientTransport(routeUrl('tok-1'))
    await client.connect(transport)
    try {
      const listed = await client.listTools()
      expect(listed.tools.map((t) => t.name).sort()).toEqual([
        'find_intents',
        'save_intents',
        'view_intent',
      ])

      const find = await client.callTool({ name: 'find_intents', arguments: {} })
      expect(JSON.stringify(find.content)).toContain('FOUND')

      const view = await client.callTool({ name: 'view_intent', arguments: { id: 'x' } })
      expect(JSON.stringify(view.content)).toContain('VIEWED')

      const save = await client.callTool({
        name: 'save_intents',
        arguments: {
          intents: [{ title: 't', shortEnTitle: 'auto', content: 'c', priority: 'P1' }],
        },
      })
      expect(JSON.stringify(save.content)).toContain('SAVED')
      expect(saved).toHaveLength(1)
    } finally {
      await client.close()
      dispose()
    }
  })
})
