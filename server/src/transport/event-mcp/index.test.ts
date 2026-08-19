/**
 * The work-session MCP HTTP route — the ONE transport every vendor consumes.
 * Covers:
 *  - the loopback predicate (non-local peers rejected; defence in depth);
 *  - unknown-token rejection (404) at the route;
 *  - a REAL MCP client over streamable-HTTP listing and calling all three tools
 *    (`publish_event` + the two memory tools);
 *  - the bound descriptor's `enabledTools` covering EXACTLY the registered tools,
 *    which is what stops a Codex-only silent disabling of an omitted name.
 * Tool behavior is injected, so this exercises the transport plumbing end-to-end
 * without any vendor binary.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { serve, type ServerType } from '@hono/node-server'
import { Hono } from 'hono'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { GenericEventEnvelope } from '@ccc/shared'
import {
  createEventMcp,
  EVENT_MCP_PATH,
  EVENT_MCP_TOOL_NAMES,
  isLoopback,
  type EventMcpTools,
  type ServedEventMcp,
} from './index.js'
import { EventNormalizerRegistry } from '../../kernel/events/generic-event.js'
import {
  PR_EVENT_TYPES,
  PR_LEGACY_EVENT_TYPE,
  normalizePrGenericEvent,
  projectPrOperationEvent,
} from '../../features/pr-events/tool-defs.js'
import { runPublishEvent } from '../../features/events/tool-defs.js'
import {
  runMemorySearch,
  runMemoryWrite,
  type MemoryScope,
} from '../../features/memory/tool-defs.js'
import { resetDbForTests } from '../../kernel/infra/db.js'
import { resetMemoryStoreForTests } from '../../features/memory/store.js'

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
  for (const t of PR_EVENT_TYPES) registry.register(t, normalizePrGenericEvent)
  registry.register(PR_LEGACY_EVENT_TYPE, normalizePrGenericEvent)
  // The composition root's own scope derivation: workspace from the binding's
  // path, session from the live run id. Nothing here is caller-supplied.
  const scope = (binding: { workspacePath: string; getRunId: () => string }): MemoryScope => ({
    workspaceName: binding.workspacePath,
    sessionId: binding.getRunId(),
  })
  const tools: EventMcpTools = {
    // Use the real cores so the route exercises validation + normalization +
    // publish, and real persistence for the memory pair.
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
    memorySearch: (binding, args) => runMemorySearch(scope(binding), args),
    memoryWrite: (binding, args) => runMemoryWrite(scope(binding), args),
  }

  let server: ServerType
  let port: number
  let eventMcp: ServedEventMcp

  let tokCounter = 0
  let home: string

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'c3-event-mcp-'))
    process.env.C3_DB_PATH = join(home, 'c3.db')
    resetDbForTests()
    resetMemoryStoreForTests()
    eventMcp = createEventMcp('http://127.0.0.1', tools, () => `tok-${++tokCounter}`)
    const app = new Hono()
    app.all(EVENT_MCP_PATH, (c) => eventMcp.handler(c))
    await new Promise<void>((resolve) => {
      server = serve({ fetch: app.fetch, port: 0 }, (info) => {
        port = info.port
        resolve()
      })
    })
  })

  afterAll(() => {
    server?.close()
    resetDbForTests()
    delete process.env.C3_DB_PATH
    resetMemoryStoreForTests()
    rmSync(home, { recursive: true, force: true })
  })

  const routeUrl = (token: string): URL =>
    new URL(`http://127.0.0.1:${port}${EVENT_MCP_PATH}?token=${token}`)

  it('rejects an unknown token with 404', async () => {
    const res = await fetch(routeUrl('nope'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    })
    expect(res.status).toBe(404)
  })

  it('lists and calls publish_event over a real MCP client', async () => {
    const bound = eventMcp.bind({
      workspacePath: '/proj',
      getRunId: () => 'run-9',
      signal: new AbortController().signal,
    })
    // The bound descriptor's token (deterministic 'tok-1'); connect via the real
    // listening port (the origin passed to createEventMcp carries no port).
    expect(bound.servers.c3.url).toContain('tok-1')

    const client = new Client({ name: 'test', version: '1.0.0' })
    const transport = new StreamableHTTPClientTransport(routeUrl('tok-1'))
    await client.connect(transport)
    try {
      const list = await client.listTools()
      // The descriptor must cover EXACTLY what is registered: Codex marks each
      // enabled name required/approved and silently disables anything omitted, so
      // a drift here would break one vendor and look like nothing happened.
      expect(list.tools.map((t) => t.name)).toEqual([...EVENT_MCP_TOOL_NAMES])
      expect(bound.servers.c3.enabledTools).toEqual(list.tools.map((t) => t.name))

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
    const bound = eventMcp.bind({
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

describe('the memory tools over the same route', () => {
  const tools: EventMcpTools = {
    publish: () => ({ content: [{ type: 'text', text: 'unused' }] }),
    memorySearch: (binding, args) =>
      runMemorySearch(
        { workspaceName: binding.workspacePath, sessionId: binding.getRunId() },
        args,
      ),
    memoryWrite: (binding, args) =>
      runMemoryWrite({ workspaceName: binding.workspacePath, sessionId: binding.getRunId() }, args),
  }

  let server: ServerType
  let port: number
  let eventMcp: ServedEventMcp
  let home: string
  let tokCounter = 0

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'c3-event-mcp-memory-'))
    process.env.C3_DB_PATH = join(home, 'c3.db')
    resetDbForTests()
    resetMemoryStoreForTests()
    eventMcp = createEventMcp('http://127.0.0.1', tools, () => `mtok-${++tokCounter}`)
    const app = new Hono()
    app.all(EVENT_MCP_PATH, (c) => eventMcp.handler(c))
    await new Promise<void>((resolve) => {
      server = serve({ fetch: app.fetch, port: 0 }, (info) => {
        port = info.port
        resolve()
      })
    })
  })

  afterAll(() => {
    server?.close()
    resetDbForTests()
    delete process.env.C3_DB_PATH
    resetMemoryStoreForTests()
    rmSync(home, { recursive: true, force: true })
  })

  /** Bind one run and drive it with a real MCP client, exactly as a vendor does. */
  async function withClient<T>(
    workspacePath: string,
    runId: string,
    fn: (c: Client, enabled: readonly string[] | undefined) => Promise<T>,
  ): Promise<T> {
    const bound = eventMcp.bind({
      workspacePath,
      getRunId: () => runId,
      signal: new AbortController().signal,
    })
    const token = new URL(bound.servers.c3.url).searchParams.get('token')!
    const client = new Client({ name: 'test', version: '1.0.0' })
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${port}${EVENT_MCP_PATH}?token=${token}`),
    )
    await client.connect(transport)
    try {
      return await fn(client, bound.servers.c3.enabledTools)
    } finally {
      await transport.close()
      bound.dispose()
    }
  }

  const call = async (
    c: Client,
    name: string,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> => {
    const res = (await c.callTool({ name, arguments: args })) as {
      isError?: boolean
      content: Array<{ text: string }>
    }
    expect(res.isError).toBeFalsy()
    return JSON.parse(res.content[0].text) as Record<string, unknown>
  }

  // Every vendor consumes THIS descriptor from THIS route — claude over its SDK
  // loop, codex and cursor over the driver path. Running the same assertions per
  // vendor label pins that none of them can end up with a narrower tool face.
  it.each(['claude', 'codex', 'cursor'])(
    'a %s work session lists all three tools and can call both memory tools',
    async (vendor) => {
      await withClient(`/ws-${vendor}`, `run-${vendor}`, async (client, enabled) => {
        const names = (await client.listTools()).tools.map((t) => t.name)
        expect(names).toEqual([...EVENT_MCP_TOOL_NAMES])
        expect(names).toContain('memory_search')
        expect(names).toContain('memory_write')
        expect(enabled).toEqual(names)

        const saved = await call(client, 'memory_write', {
          op: 'create',
          type: 'preference',
          title: `${vendor} 的偏好`,
          content: `用户对 ${vendor} 会话说过的偏好。`,
        })
        expect(saved).toMatchObject({ ok: true, title: `${vendor} 的偏好` })

        const dir = await call(client, 'memory_search', {})
        expect(dir).toMatchObject({ mode: 'directory', total: 1 })

        const hit = await call(client, 'memory_search', { query: vendor })
        expect((hit.memories as Array<{ sourceSessionId: string }>)[0].sourceSessionId).toBe(
          `run-${vendor}`,
        )
      })
    },
  )

  it('one run binding cannot reach another workspace memory', async () => {
    await withClient('/ws-a', 'run-a', async (client) => {
      await call(client, 'memory_write', {
        op: 'create',
        type: 'fact',
        title: 'A 的事实',
        content: '只属于 A。',
      })
    })
    await withClient('/ws-b', 'run-b', async (client) => {
      expect(await call(client, 'memory_search', {})).toMatchObject({ total: 0 })
      expect(await call(client, 'memory_search', { query: 'A 的事实' })).toMatchObject({ total: 0 })
    })
  })

  it('reports a refused write as an MCP error rather than a receipt', async () => {
    await withClient('/ws-c', 'run-c', async (client) => {
      const res = (await client.callTool({
        name: 'memory_write',
        arguments: {
          op: 'create',
          type: 'fact',
          title: '密钥',
          content: 'api_key=8f3c1a9d7e2b4056af11',
        },
      })) as { isError?: boolean; content: Array<{ text: string }> }
      expect(res.isError).toBe(true)
      expect(res.content[0].text).not.toContain('8f3c1a9d7e2b4056af11')
      expect(await call(client, 'memory_search', {})).toMatchObject({ total: 0 })
    })
  })
})
