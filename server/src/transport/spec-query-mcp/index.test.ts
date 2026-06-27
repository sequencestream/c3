import { describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { createSpecQueryMcp, SPEC_QUERY_MCP_PATH } from './index.js'

describe('spec-query MCP transport', () => {
  it('advertises and serves only find_intents/view_intent', async () => {
    const app = new Hono()
    const specMcp = createSpecQueryMcp('http://127.0.0.1', () => 'tok-1')
    app.all(SPEC_QUERY_MCP_PATH, (c) => specMcp.handler(c))
    const server = serve({ fetch: app.fetch, port: 0 })
    const addr = server.address()
    const port = typeof addr === 'object' && addr ? addr.port : 0
    const url = `http://127.0.0.1:${port}${SPEC_QUERY_MCP_PATH}?token=tok-1`
    const bound = specMcp.bind({
      workspacePath: '/proj',
      getRunId: () => 'run-1',
      signal: new AbortController().signal,
    })
    const client = new Client({ name: 'test', version: '1.0.0' })
    const transport = new StreamableHTTPClientTransport(new URL(url))
    await client.connect(transport)
    try {
      expect(bound.servers.c3.enabledTools).toEqual(['find_intents', 'view_intent'])
      const listed = await client.listTools()
      expect(listed.tools.map((t) => t.name).sort()).toEqual(['find_intents', 'view_intent'])
    } finally {
      await client.close()
      bound.dispose()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})
