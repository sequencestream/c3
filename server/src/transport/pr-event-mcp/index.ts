/**
 * Localhost HTTP MCP route for the `publish_pr_event` tool (2026-06-20). The
 * work-session's publish tool is a Claude in-process SDK MCP server
 * (`features/pr-events/publish-tool.ts`); codex (`inProcessMcp: false`) can't
 * load that, so this route re-exposes the SAME tool over a streamable-HTTP MCP
 * server bound to ONE run.
 *
 * Mirrors the intent MCP route (`transport/intent-mcp`): a kernel-neutral
 * bind/dispose + opaque per-run token, the HTTP `handler` mounted by the
 * composition root, and defence-in-depth (loopback guard ON TOP of c3's
 * localhost-only bind, plus token lookup). The tool behavior (validate +
 * normalize + publish onto the event bus) is INJECTED as `tools` from the
 * composition root, so this module stays pure transport plumbing.
 *
 * Per-run isolation: each `bind()` mints a token → a private {@link McpServer}
 * whose tool handler closes over the run's binding (workspace + live run id). The
 * token rides the URL query; the workspace lives in the closure, so the model can
 * neither publish to nor be matched against another workspace's schedules.
 * `dispose()` evicts the binding at run end.
 */
import type { Context } from 'hono'
import { getConnInfo } from '@hono/node-server/conninfo'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import type { RemoteMcpServer } from '../../kernel/agent/adapters/types.js'
import {
  publishPrEventDesc,
  publishPrEventSchema,
  type PrEventToolResult,
  type PublishPrEventArgs,
} from '../../features/pr-events/tool-defs.js'

/** The loopback path the PR-event MCP route is mounted at. */
export const PR_EVENT_MCP_PATH = '/internal/pr-event-mcp/v1'

/** Per-run binding: which workspace the events belong to, and the live run id. */
export interface PrEventMcpBinding {
  workspacePath: string
  /** Reads the LIVE run id so a pending→real session rebind tags events with the bound session. */
  getRunId: () => string
  signal: AbortSignal
}

/** The injected tool behavior: validate + normalize + publish onto the event bus. */
export interface PrEventMcpTools {
  publish(binding: PrEventMcpBinding, args: PublishPrEventArgs): PrEventToolResult
}

/** The served route: the kernel-facing bind handle plus the HTTP handler the root mounts. */
export interface ServedPrEventMcp {
  /** Loopback base URL the bound descriptors point at (`http://127.0.0.1:<port><PATH>`). */
  readonly baseUrl: string
  /**
   * Bind one run: mint a token, stand up a private MCP server carrying the tool,
   * and return the neutral {@link RemoteMcpServer} descriptors (for
   * `DriverStartOptions.mcpServers`) plus a `dispose` to evict at run end.
   */
  bind(binding: PrEventMcpBinding): {
    servers: Record<string, RemoteMcpServer>
    dispose: () => void
  }
  /** The Hono handler for `ALL <PATH>` (POST messages / GET SSE / DELETE session-end). */
  handler(c: Context): Promise<Response>
}

interface Entry {
  transport: WebStandardStreamableHTTPServerTransport
  server: McpServer
  /** Resolves once `server.connect(transport)` finishes — `handler` awaits it before dispatch. */
  ready: Promise<void>
}

/** Loopback addresses accepted by the guard (IPv4, IPv6, IPv4-mapped IPv6). */
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

/** Loopback predicate for the route's defence-in-depth guard. Exported for tests. */
export function isLoopback(address: string | undefined): boolean {
  if (!address) return false
  return LOOPBACK.has(address) || address.startsWith('127.')
}

/**
 * Build the PR-event MCP route. `origin` is c3's own loopback origin
 * (`http://127.0.0.1:<port>`); `tools` injects the publish behavior; `makeToken`
 * is injected for tests (defaults to `crypto.randomUUID`).
 */
export function createPrEventMcp(
  origin: string,
  tools: PrEventMcpTools,
  makeToken: () => string = () => crypto.randomUUID(),
): ServedPrEventMcp {
  const baseUrl = `${origin.replace(/\/$/, '')}${PR_EVENT_MCP_PATH}`
  const entries = new Map<string, Entry>()

  const buildServer = (binding: PrEventMcpBinding): McpServer => {
    const server = new McpServer({ name: 'c3', version: '1.0.0' })
    server.registerTool(
      'publish_pr_event',
      { description: publishPrEventDesc, inputSchema: publishPrEventSchema },
      async (args) => toCallResult(tools.publish(binding, args as PublishPrEventArgs)),
    )
    return server
  }

  return {
    baseUrl,
    bind(binding) {
      const token = makeToken()
      const server = buildServer(binding)
      // Stateful: the client initializes once, gets a session id, and reuses it.
      // One transport per token === one MCP session per run.
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        enableJsonResponse: true,
      })
      const ready = server.connect(transport)
      entries.set(token, { transport, server, ready })
      return {
        servers: { c3: { type: 'http', url: `${baseUrl}?token=${token}` } },
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
      // Defence in depth: reject non-loopback peers even though c3 binds localhost.
      const remote = getConnInfo(c).remote.address
      if (!isLoopback(remote)) {
        return c.json({ error: 'pr-event MCP is loopback-only' }, 403)
      }
      const token = c.req.query('token') ?? ''
      const entry = entries.get(token)
      if (!entry) {
        return c.json({ error: 'unknown or expired pr-event-MCP token' }, 404)
      }
      await entry.ready
      return entry.transport.handleRequest(c.req.raw)
    },
  }
}

/** Map our framing-free tool result to the MCP SDK `CallToolResult` shape (structurally identical). */
function toCallResult(r: PrEventToolResult): {
  content: Array<{ type: 'text'; text: string }>
  isError?: boolean
} {
  return r.isError ? { content: r.content, isError: true } : { content: r.content }
}
