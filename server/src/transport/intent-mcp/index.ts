/**
 * Localhost HTTP MCP route for the three intent tools (2026-06-12-005). The
 * comm-agent's `find_intents` / `view_intent` / `save_intents` are a Claude
 * in-process SDK MCP server (`features/intents/save-tool.ts`); codex
 * (`inProcessMcp: false`) can't load that, so this route re-exposes the SAME
 * three tools over a streamable-HTTP MCP server bound to ONE run.
 *
 * Mirrors the codex relay (`transport/codex-relay`): a kernel-neutral bind/dispose
 * + opaque per-run token, the HTTP `handler` mounted by the composition root, and
 * defence-in-depth (loopback guard ON TOP of c3's localhost-only bind, plus token
 * lookup). The feature logic (store reads, the save confirmation gate) is INJECTED
 * as `tools` from the composition root, so this module stays pure transport
 * plumbing and never reaches into `kernel/permission` or the intent store itself.
 *
 * Per-run isolation: each `bind()` mints a token → a private {@link McpServer} +
 * Web-standards streamable HTTP transport whose tool handlers close over the
 * run's binding (project path + live run id + abort signal). The token rides the
 * URL query; the project binding lives in the closure, so an agent can neither
 * read nor write another project's ledger. `dispose()` evicts the binding at run
 * end.
 */
import type { Context } from 'hono'
import { getConnInfo } from '@hono/node-server/conninfo'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import type { RemoteMcpServer } from '../../kernel/agent/adapters/types.js'
import {
  findDesc,
  findSchema,
  saveDesc,
  saveSchema,
  viewDesc,
  viewSchema,
  type FindArgs,
  type IntentToolResult,
  type SaveArgs,
  type ViewArgs,
} from '../../features/intents/tool-defs.js'

/** The loopback path the intent MCP route is mounted at. */
export const INTENT_MCP_PATH = '/internal/intent-mcp/v1'

/** Per-run binding: which project the tools act on, the live run id, and the run's abort signal. */
export interface IntentMcpBinding {
  workspacePath: string
  /** Reads the LIVE run id so a pending→real session rebind routes the save gate correctly. */
  getRunId: () => string
  signal: AbortSignal
}

/**
 * The injected feature behaviors. `find`/`view` are read-only; `save` MUST run the
 * confirmation gate (the user confirms in c3 UI) BEFORE persisting — the composition
 * root wires it to `permission_request`/`waitForDecision` + the intent store.
 */
export interface IntentMcpTools {
  find(workspacePath: string, args: FindArgs): IntentToolResult | Promise<IntentToolResult>
  view(workspacePath: string, args: ViewArgs): IntentToolResult | Promise<IntentToolResult>
  save(binding: IntentMcpBinding, args: SaveArgs): Promise<IntentToolResult>
}

/** The served route: the kernel-facing bind handle plus the HTTP handler the root mounts. */
export interface ServedIntentMcp {
  /** Loopback base URL the bound descriptors point at (`http://127.0.0.1:<port><PATH>`). */
  readonly baseUrl: string
  /**
   * Bind one run: mint a token, stand up a private MCP server carrying the three
   * tools, and return the neutral {@link RemoteMcpServer} descriptors (for
   * `DriverStartOptions.mcpServers`) plus a `dispose` to evict at run end.
   */
  bind(binding: IntentMcpBinding): {
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
 * Build the intent MCP route. `origin` is c3's own loopback origin
 * (`http://127.0.0.1:<port>`); `tools` injects the store-backed behaviors + save
 * gate; `makeToken` is injected for tests (defaults to `crypto.randomUUID`).
 */
export function createIntentMcp(
  origin: string,
  tools: IntentMcpTools,
  makeToken: () => string = () => crypto.randomUUID(),
): ServedIntentMcp {
  const baseUrl = `${origin.replace(/\/$/, '')}${INTENT_MCP_PATH}`
  const entries = new Map<string, Entry>()

  const buildServer = (binding: IntentMcpBinding): McpServer => {
    const server = new McpServer({ name: 'c3', version: '1.0.0' })
    server.registerTool(
      'save_intents',
      { description: saveDesc, inputSchema: saveSchema },
      async (args) => toCallResult(await tools.save(binding, args as SaveArgs)),
    )
    server.registerTool(
      'find_intents',
      { description: findDesc, inputSchema: findSchema },
      async (args) => toCallResult(await tools.find(binding.workspacePath, args as FindArgs)),
    )
    server.registerTool(
      'view_intent',
      { description: viewDesc, inputSchema: viewSchema },
      async (args) => toCallResult(await tools.view(binding.workspacePath, args as ViewArgs)),
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
        return c.json({ error: 'intent MCP is loopback-only' }, 403)
      }
      const token = c.req.query('token') ?? ''
      const entry = entries.get(token)
      if (!entry) {
        return c.json({ error: 'unknown or expired intent-MCP token' }, 404)
      }
      await entry.ready
      return entry.transport.handleRequest(c.req.raw)
    },
  }
}

/** Map our framing-free tool result to the MCP SDK `CallToolResult` shape (structurally identical). */
function toCallResult(r: IntentToolResult): {
  content: Array<{ type: 'text'; text: string }>
  isError?: boolean
} {
  return r.isError ? { content: r.content, isError: true } : { content: r.content }
}
