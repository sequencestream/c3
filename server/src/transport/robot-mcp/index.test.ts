/**
 * Robot MCP HTTP route — the chat-robot c3 tool subset over the loopback
 * streamable-HTTP transport. Covers:
 *  - the loopback predicate (non-local peers rejected; defence in depth);
 *  - unknown-token rejection (404) at the route;
 *  - a REAL MCP client over streamable-HTTP that lists ONLY the selected tools and
 *    calls one end-to-end, proving the binding freezes the subset (spec: 未勾选工具
 *    既不出现在 tools/list,直接调用也被服务端拒绝);
 *  - the per-turn `enabledTools` descriptor equals exactly the registered subset;
 *  - dispose evicts the token: the same URL 404s afterward.
 * Tool behaviors are the shared framing-free builders bound to a temp workspace,
 * so this exercises the transport plumbing end-to-end without a vendor binary.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { serve, type ServerType } from '@hono/node-server'
import { Hono } from 'hono'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { resetDbForTests } from '../../kernel/infra/db.js'
import type { AutomationMcpDeps } from '../../features/automations/c3-tools.js'
import { createRobotMcp, ROBOT_MCP_PATH, isLoopback, type ServedRobotMcp } from './index.js'

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

describe('robot MCP HTTP route', () => {
  const runRoot = '/abs/c3/robots/helper'
  const deps: AutomationMcpDeps = {
    broadcastIntents: () => {},
    normalizeEvent: () => ({ ok: false, reason: 'not wired in this test' }),
    publishEvent: () => {},
    broadcastDiscussions: () => {},
    broadcastDiscussionMessage: () => {},
    startDiscussionRun: () => {},
    launchRun: async () => {},
  }

  let server: ServerType
  let port: number
  let robotMcp: ServedRobotMcp
  let dir: string

  afterAll(() => {
    server?.close()
  })

  beforeAll(async () => {
    robotMcp = createRobotMcp('http://127.0.0.1', () => deps)
    const app = new Hono()
    app.all(ROBOT_MCP_PATH, (c) => robotMcp.handler(c))
    await new Promise<void>((resolve) => {
      server = serve({ fetch: app.fetch, port: 0 }, (info) => {
        port = info.port
        resolve()
      })
    })
  })

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'c3-robot-mcp-'))
    process.env.C3_DB_PATH = join(dir, 'c3.db')
    resetDbForTests()
  })

  afterEach(() => {
    resetDbForTests()
    delete process.env.C3_DB_PATH
    rmSync(dir, { recursive: true, force: true })
  })

  const routeUrl = (token: string): URL =>
    new URL(`http://127.0.0.1:${port}${ROBOT_MCP_PATH}?token=${token}`)

  const tokenOf = (url: string): string => new URL(url).searchParams.get('token') ?? ''

  const jsonHeaders = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  }

  it('rejects an unknown token with 404', async () => {
    const r = await fetch(routeUrl('nope'), {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    })
    expect(r.status).toBe(404)
  })

  it('binds a c3 http descriptor advertising exactly the selected tools', () => {
    const binding = robotMcp.bind({
      workspacePath: runRoot,
      getRunId: () => 'run-1',
      selectedTools: ['find_intents', 'view_intent'],
    })
    try {
      expect(binding.servers.c3.type).toBe('http')
      expect(binding.servers.c3.url).toContain('token=')
      expect(binding.servers.c3.enabledTools).toEqual(['find_intents', 'view_intent'])
    } finally {
      binding.dispose()
    }
  })

  it('lists only the selected tools and calls one via a real streamable-HTTP client', async () => {
    const binding = robotMcp.bind({
      workspacePath: runRoot,
      getRunId: () => 'run-1',
      selectedTools: ['find_intents'],
    })
    const client = new Client({ name: 'test', version: '1.0.0' })
    await client.connect(
      new StreamableHTTPClientTransport(routeUrl(tokenOf(binding.servers.c3.url))),
    )
    try {
      const listed = await client.listTools()
      expect(listed.tools.map((t) => t.name)).toEqual(['find_intents'])

      // A fresh robot run root has no intents — find_* returning empty is the
      // EXPECTED scoping (spec: c3 MCP 不得跨出机器人自身运行根目录), not an error.
      const find = await client.callTool({ name: 'find_intents', arguments: {} })
      expect(find.isError).toBeFalsy()
      expect(JSON.stringify(find.content)).toContain('未找到匹配的意图')
    } finally {
      await client.close()
      binding.dispose()
    }
  })

  it('an unselected tool is absent from tools/list and direct call is refused', async () => {
    const binding = robotMcp.bind({
      workspacePath: runRoot,
      getRunId: () => 'run-1',
      // save_intents is deliberately NOT selected.
      selectedTools: ['find_intents'],
    })
    const client = new Client({ name: 'test', version: '1.0.0' })
    await client.connect(
      new StreamableHTTPClientTransport(routeUrl(tokenOf(binding.servers.c3.url))),
    )
    try {
      const listed = await client.listTools()
      expect(listed.tools.map((t) => t.name)).not.toContain('save_intents')

      // The MCP SDK refuses a call to a tool the server never registered — the
      // direct-call rejection half of the spec's "未勾选工具既不出现在 tools/list,
      // 直接调用也被服务端拒绝" (an error result naming the tool as not found).
      const refused = await client.callTool({ name: 'save_intents', arguments: { intents: [] } })
      expect(refused.isError).toBe(true)
      expect(JSON.stringify(refused.content)).toContain('save_intents')
      expect(JSON.stringify(refused.content)).toContain('not found')
    } finally {
      await client.close()
      binding.dispose()
    }
  })

  it('dispose evicts the token: the same URL 404s afterward', async () => {
    const binding = robotMcp.bind({
      workspacePath: runRoot,
      getRunId: () => 'run-1',
      selectedTools: ['find_intents'],
    })
    const token = tokenOf(binding.servers.c3.url)
    const client = new Client({ name: 'test', version: '1.0.0' })
    await client.connect(new StreamableHTTPClientTransport(routeUrl(token)))
    await client.listTools()
    await client.close()

    binding.dispose()
    // Idempotent: a second dispose is a no-op, not a throw.
    expect(() => binding.dispose()).not.toThrow()

    const r = await fetch(routeUrl(token), {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    })
    expect(r.status).toBe(404)
  })
})
