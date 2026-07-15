/**
 * Localhost HTTP MCP route for the spec author's read-only ledger tools. Spec
 * sessions attach this smaller HTTP server carrying only `find_intents` and
 * `view_intent` — the SAME transport both Claude and Codex consume (neither uses
 * an in-process SDK MCP server for c3 tools).
 */
import type { Context } from 'hono'
import { getConnInfo } from '@hono/node-server/conninfo'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import type { RemoteMcpServer } from '../../kernel/agent/adapters/types.js'
import {
  findDesc,
  findSchema,
  runFind,
  runView,
  viewDesc,
  viewSchema,
  type FindArgs,
  type IntentToolResult,
  type ViewArgs,
} from '../../features/intents/tool-defs.js'

export const SPEC_QUERY_MCP_PATH = '/internal/spec-query-mcp/v1'

export interface SpecQueryMcpBinding {
  workspacePath: string
  getRunId: () => string
  signal: AbortSignal
}

export interface ServedSpecQueryMcp {
  readonly baseUrl: string
  bind(binding: SpecQueryMcpBinding): {
    servers: Record<string, RemoteMcpServer>
    dispose: () => void
  }
  handler(c: Context): Promise<Response>
}

interface Entry {
  transport: WebStandardStreamableHTTPServerTransport
  server: McpServer
  ready: Promise<void>
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

export function isLoopback(address: string | undefined): boolean {
  if (!address) return false
  return LOOPBACK.has(address) || address.startsWith('127.')
}

export function createSpecQueryMcp(
  origin: string,
  makeToken: () => string = () => crypto.randomUUID(),
): ServedSpecQueryMcp {
  const baseUrl = `${origin.replace(/\/$/, '')}${SPEC_QUERY_MCP_PATH}`
  const entries = new Map<string, Entry>()

  const buildServer = (binding: SpecQueryMcpBinding): McpServer => {
    const server = new McpServer({ name: 'c3', version: '1.0.0' })
    server.registerTool(
      'find_intents',
      { description: findDesc, inputSchema: findSchema },
      async (args) => toCallResult(runFind(binding.workspacePath, args as FindArgs)),
    )
    server.registerTool(
      'view_intent',
      { description: viewDesc, inputSchema: viewSchema },
      async (args) => toCallResult(runView(binding.workspacePath, args as ViewArgs)),
    )
    return server
  }

  return {
    baseUrl,
    bind(binding) {
      const token = makeToken()
      const server = buildServer(binding)
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        enableJsonResponse: true,
      })
      const ready = server.connect(transport)
      entries.set(token, { transport, server, ready })
      return {
        servers: {
          c3: {
            type: 'http',
            url: `${baseUrl}?token=${token}`,
            enabledTools: ['find_intents', 'view_intent'],
          },
        },
        dispose: () => {
          const entry = entries.get(token)
          if (!entry) return
          entries.delete(token)
          void entry.transport.close()
          void entry.server.close()
        },
      }
    },
    async handler(c) {
      const remote = getConnInfo(c).remote.address
      if (!isLoopback(remote)) {
        return c.json({ error: 'spec query MCP is loopback-only' }, 403)
      }
      const token = c.req.query('token') ?? ''
      const entry = entries.get(token)
      if (!entry) {
        return c.json({ error: 'unknown or expired spec-query-MCP token' }, 404)
      }
      await entry.ready
      return entry.transport.handleRequest(c.req.raw)
    },
  }
}

function toCallResult(r: IntentToolResult): {
  content: Array<{ type: 'text'; text: string }>
  isError?: boolean
} {
  return r.isError ? { content: r.content, isError: true } : { content: r.content }
}
