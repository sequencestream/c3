/**
 * Localhost HTTP MCP route for the WORK-SESSION c3 tool profile: `publish_event`
 * plus the two workspace-memory tools. They are served over this ONE
 * streamable-HTTP MCP route bound to a single run — the SAME transport every
 * vendor consumes (none uses an in-process SDK MCP server for c3 tools). Each
 * tool's logic comes from its shared framing-free definition so every vendor runs
 * identical behavior.
 *
 * Mirrors the intent MCP route (`transport/intent-mcp`): a kernel-neutral
 * bind/dispose + opaque per-run token, the HTTP `handler` mounted by the
 * composition root, and defence-in-depth (loopback guard ON TOP of c3's
 * localhost-only bind, plus token lookup). Every tool behavior is INJECTED as
 * `tools` from the composition root, so this module stays pure transport plumbing.
 *
 * Per-run isolation: each `bind()` mints a token → a private {@link McpServer}
 * whose tool handlers close over the run's binding (workspace + live run id). The
 * token rides the URL query; the workspace lives in the closure, so the model can
 * neither publish to nor be matched against another workspace's automations, and
 * neither read nor write another workspace's memory.
 * `dispose()` evicts the binding at run end.
 *
 * Which SESSIONS reach this route is decided in the run lifecycle, not here: only
 * a `work` session binds it. That is what keeps intent, spec, spec-review and
 * discussion agents from persisting their synthesized opinions as workspace facts.
 */
import type { Context } from 'hono'
import type { ZodRawShape } from 'zod'
import { getConnInfo } from '@hono/node-server/conninfo'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import type { RemoteMcpServer } from '../../kernel/agent/adapters/types.js'
import {
  publishEventDesc,
  publishEventSchema,
  type EventToolResult,
  type PublishEventArgs,
} from '../../features/events/tool-defs.js'
import {
  memorySearchDesc,
  memorySearchSchema,
  memoryWriteDesc,
  memoryWriteSchema,
  type MemorySearchArgs,
  type MemoryToolResult,
  type MemoryWriteArgs,
} from '../../features/memory/tool-defs.js'

/** The loopback path the event MCP route is mounted at. */
export const EVENT_MCP_PATH = '/internal/event-mcp/v1'

/** Per-run binding: which workspace the events belong to, and the live run id. */
export interface EventMcpBinding {
  workspacePath: string
  /** Reads the LIVE run id so a pending→real session rebind tags events with the bound session. */
  getRunId: () => string
  signal: AbortSignal
}

/**
 * The injected tool behaviors. `publish` validates + normalizes + publishes onto
 * the event bus; the memory pair reads and maintains the bound workspace's
 * notebook. The composition root resolves the binding's workspace path to its
 * persistence identity, so this module never reaches into a store.
 */
export interface EventMcpTools {
  publish(binding: EventMcpBinding, args: PublishEventArgs): EventToolResult
  memorySearch(binding: EventMcpBinding, args: MemorySearchArgs): MemoryToolResult
  memoryWrite(binding: EventMcpBinding, args: MemoryWriteArgs): MemoryToolResult
}

/** The served route: the kernel-facing bind handle plus the HTTP handler the root mounts. */
export interface ServedEventMcp {
  /** Loopback base URL the bound descriptors point at (`http://127.0.0.1:<port><PATH>`). */
  readonly baseUrl: string
  /**
   * Bind one run: mint a token, stand up a private MCP server carrying the tool,
   * and return the neutral {@link RemoteMcpServer} descriptors (for
   * `DriverStartOptions.mcpServers`) plus a `dispose` to evict at run end.
   */
  bind(binding: EventMcpBinding): {
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

/**
 * The work-session tool table: ONE list that both registers the tools on the MCP
 * server and produces the descriptor's `enabledTools`. Deriving the list from the
 * registration is not a style choice — Codex marks each name in `enabledTools`
 * required/approved and SILENTLY disables anything omitted, so a hand-maintained
 * second list would fail on exactly one vendor and look like nothing happened.
 */
const TOOL_DEFS: readonly {
  name: string
  description: string
  inputSchema: ZodRawShape
  run: (tools: EventMcpTools, binding: EventMcpBinding, args: unknown) => EventToolResult
}[] = [
  {
    name: 'publish_event',
    description: publishEventDesc,
    inputSchema: publishEventSchema,
    run: (t, b, args) => t.publish(b, args as PublishEventArgs),
  },
  {
    name: 'memory_search',
    description: memorySearchDesc,
    inputSchema: memorySearchSchema,
    run: (t, b, args) => t.memorySearch(b, args as MemorySearchArgs),
  },
  {
    name: 'memory_write',
    description: memoryWriteDesc,
    inputSchema: memoryWriteSchema,
    run: (t, b, args) => t.memoryWrite(b, args as MemoryWriteArgs),
  },
]

/** The stable, ordered names of the work-session tool profile. */
export const EVENT_MCP_TOOL_NAMES: readonly string[] = TOOL_DEFS.map((t) => t.name)

/** Loopback addresses accepted by the guard (IPv4, IPv6, IPv4-mapped IPv6). */
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

/** Loopback predicate for the route's defence-in-depth guard. Exported for tests. */
export function isLoopback(address: string | undefined): boolean {
  if (!address) return false
  return LOOPBACK.has(address) || address.startsWith('127.')
}

/**
 * Build the event MCP route. `origin` is c3's own loopback origin
 * (`http://127.0.0.1:<port>`); `tools` injects the publish behavior; `makeToken`
 * is injected for tests (defaults to `crypto.randomUUID`).
 */
export function createEventMcp(
  origin: string,
  tools: EventMcpTools,
  makeToken: () => string = () => crypto.randomUUID(),
): ServedEventMcp {
  const baseUrl = `${origin.replace(/\/$/, '')}${EVENT_MCP_PATH}`
  const entries = new Map<string, Entry>()

  const buildServer = (binding: EventMcpBinding): McpServer => {
    const server = new McpServer({ name: 'c3', version: '1.0.0' })
    for (const def of TOOL_DEFS) {
      server.registerTool(
        def.name,
        { description: def.description, inputSchema: def.inputSchema },
        async (args) => toCallResult(def.run(tools, binding, args)),
      )
    }
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
        servers: {
          c3: {
            type: 'http',
            url: `${baseUrl}?token=${token}`,
            enabledTools: [...EVENT_MCP_TOOL_NAMES],
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
      // Defence in depth: reject non-loopback peers even though c3 binds localhost.
      const remote = getConnInfo(c).remote.address
      if (!isLoopback(remote)) {
        return c.json({ error: 'event MCP is loopback-only' }, 403)
      }
      const token = c.req.query('token') ?? ''
      const entry = entries.get(token)
      if (!entry) {
        return c.json({ error: 'unknown or expired event-MCP token' }, 404)
      }
      await entry.ready
      return entry.transport.handleRequest(c.req.raw)
    },
  }
}

/** Map our framing-free tool result to the MCP SDK `CallToolResult` shape (structurally identical). */
function toCallResult(r: EventToolResult): {
  content: Array<{ type: 'text'; text: string }>
  isError?: boolean
} {
  return r.isError ? { content: r.content, isError: true } : { content: r.content }
}
