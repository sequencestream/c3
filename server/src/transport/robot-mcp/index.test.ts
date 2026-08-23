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
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { serve, type ServerType } from '@hono/node-server'
import { Hono } from 'hono'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { resetDbForTests } from '../../kernel/infra/db.js'
import { releaseConfigDb, useConfigDb } from '../../kernel/config/config-fixture.js'
import { loadSettings, saveSettings } from '../../kernel/config/index.js'
import { registerWorkspace } from '../../kernel/config/workspace-store.js'
import { hashPassword } from '../../features/auth/password.js'
import {
  putWorkspaceScope,
  resetWorkspaceScopeStoreForTests,
} from '../../features/auth/scope-store.js'
import type { AuthConfig } from '@ccc/shared/protocol'
import { createRobot, resetRobotStoreForTests } from '../../features/im/robot-store.js'
import {
  accountNamespaceOf,
  resetIdentityStoreForTests,
  seedBindingForTests,
} from '../../features/im/identity-store.js'
import { chatContextFor, resolveCallScope } from '../../features/im/call-scope.js'
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
    process.env.C3_DIR = dir
    useConfigDb(dir)
    resetDbForTests()
    resetRobotStoreForTests()
    resetIdentityStoreForTests()
    resetWorkspaceScopeStoreForTests()
  })

  afterEach(() => {
    releaseConfigDb()
    resetDbForTests()
    delete process.env.C3_DB_PATH
    delete process.env.C3_DIR
    resetRobotStoreForTests()
    resetIdentityStoreForTests()
    resetWorkspaceScopeStoreForTests()
    rmSync(dir, { recursive: true, force: true })
  })

  const routeUrl = (token: string): URL =>
    new URL(`http://127.0.0.1:${port}${ROBOT_MCP_PATH}?token=${token}`)

  const tokenOf = (url: string): string => new URL(url).searchParams.get('token') ?? ''

  const jsonHeaders = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  }

  function useBasicAuth(...usernames: string[]): void {
    const auth: AuthConfig = {
      enabled: true,
      provider: {
        kind: 'basic',
        accounts: usernames.map((username) => ({
          username,
          passwordHash: hashPassword('pw'),
        })),
        adminUsername: usernames[0],
      },
      session: { ttlSeconds: 3600, signingKeyRef: 'C3_AUTH_KEY' },
    }
    saveSettings({ ...loadSettings(), auth })
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

      // A robot MCP bind without imAuth must not leak ledger data — L1 tools
      // refuse with the same not_visible shape as an unauthorized object read.
      const find = await client.callTool({ name: 'find_intents', arguments: {} })
      expect(JSON.stringify(find.content)).toContain('not_visible')
    } finally {
      await client.close()
      binding.dispose()
    }
  })

  it('lists and calls selected list_workspaces with the live IM scope', async () => {
    useBasicAuth('root', 'alice')
    const alphaPath = join(dir, 'workspace-alpha')
    const betaPath = join(dir, 'workspace-beta')
    const robotRoot = join(dir, 'robots', 'helper')
    for (const path of [alphaPath, betaPath, robotRoot]) mkdirSync(path, { recursive: true })
    const alpha = registerWorkspace(alphaPath, 'alpha', 200).name
    const beta = registerWorkspace(betaPath, 'beta', 100).name
    putWorkspaceScope('alice', 'selected', [beta, alpha], 1)
    const robot = createRobot({
      name: 'helper',
      platform: 'feishu',
      appId: 'cli_app',
      appSecret: 'secret',
      vendor: 'claude',
      agentId: 'agent-1',
    })
    const binding = seedBindingForTests({
      accountNamespace: accountNamespaceOf('feishu', 'cli_app'),
      senderId: 'ou_alice',
      subject: 'alice',
    })
    const chat = chatContextFor('feishu', 'cli_app', 'p2p', 'ou_alice')
    const scope = resolveCallScope({ robotId: robot.id, senderId: 'ou_alice', chat })
    expect(scope.ok).toBe(true)
    if (!scope.ok) return

    const mcpBinding = robotMcp.bind({
      workspacePath: robotRoot,
      getRunId: () => 'run-1',
      selectedTools: ['list_workspaces'],
      imAuth: {
        robotId: robot.id,
        senderId: 'ou_alice',
        chatType: 'p2p',
        chatId: 'ou_alice',
        providerAccountKey: 'cli_app',
        platform: 'feishu',
        expectedBindingId: binding.id,
        turnStartScopeHash: scope.scope.scopeHash,
      },
    })
    expect(mcpBinding.servers.c3.enabledTools).toEqual(['list_workspaces'])
    const client = new Client({ name: 'test', version: '1.0.0' })
    await client.connect(
      new StreamableHTTPClientTransport(routeUrl(tokenOf(mcpBinding.servers.c3.url))),
    )
    try {
      const listed = await client.listTools()
      expect(listed.tools.map((tool) => tool.name)).toEqual(['list_workspaces'])
      const result = await client.callTool({ name: 'list_workspaces', arguments: {} })
      const payload = JSON.parse((result.content as Array<{ text: string }>)[0]!.text) as {
        workspaces: string[]
      }
      expect(payload).toEqual({ workspaces: [alpha, beta] })
      expect(JSON.stringify(payload)).not.toContain(alphaPath)
      expect(JSON.stringify(payload)).not.toContain(betaPath)
      expect(JSON.stringify(payload)).not.toContain(robotRoot)
    } finally {
      await client.close()
      mcpBinding.dispose()
    }
  })

  it('returns not_visible for selected list_workspaces when IM auth is absent', async () => {
    const binding = robotMcp.bind({
      workspacePath: runRoot,
      getRunId: () => 'run-1',
      selectedTools: ['list_workspaces'],
    })
    const client = new Client({ name: 'test', version: '1.0.0' })
    await client.connect(
      new StreamableHTTPClientTransport(routeUrl(tokenOf(binding.servers.c3.url))),
    )
    try {
      expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(['list_workspaces'])
      const result = await client.callTool({ name: 'list_workspaces', arguments: {} })
      expect(JSON.parse((result.content as Array<{ text: string }>)[0]!.text)).toEqual({
        code: 'not_visible',
      })
    } finally {
      await client.close()
      binding.dispose()
    }
  })

  it('an unselected tool is absent from tools/list and direct call is refused', async () => {
    const binding = robotMcp.bind({
      workspacePath: runRoot,
      getRunId: () => 'run-1',
      // list_workspaces is deliberately NOT selected.
      selectedTools: ['find_intents'],
    })
    const client = new Client({ name: 'test', version: '1.0.0' })
    await client.connect(
      new StreamableHTTPClientTransport(routeUrl(tokenOf(binding.servers.c3.url))),
    )
    try {
      const listed = await client.listTools()
      expect(listed.tools.map((t) => t.name)).not.toContain('list_workspaces')

      // The MCP SDK refuses a call to a tool the server never registered — the
      // direct-call rejection half of the spec's "未勾选工具既不出现在 tools/list,
      // 直接调用也被服务端拒绝" (an error result naming the tool as not found).
      const refused = await client.callTool({ name: 'list_workspaces', arguments: {} })
      expect(refused.isError).toBe(true)
      expect(JSON.stringify(refused.content)).toContain('list_workspaces')
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
