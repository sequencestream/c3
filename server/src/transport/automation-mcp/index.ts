/**
 * Localhost HTTP MCP route for the automation c3 tool profile. The unattended
 * automation's c3 tools are served over this ONE streamable-HTTP MCP route bound to
 * a single automation execution — the SAME transport both Claude and Codex consume
 * (neither uses an in-process SDK MCP server for c3 tools).
 *
 * Mirrors the intent / event MCP routes (`transport/intent-mcp`,
 * `transport/event-mcp`): a kernel-neutral bind/dispose + opaque per-execution
 * token, the HTTP `handler` mounted by the composition root, and defence-in-depth
 * (loopback guard ON TOP of c3's localhost-only bind, plus token lookup). The tool
 * behaviors come from the shared framing-free builder
 * (`features/automations/c3-tools.ts`) with composition-root callbacks INJECTED as
 * `deps`, so this module stays pure transport plumbing and never reaches into the
 * intent / discussion stores itself.
 *
 * Per-execution isolation: each `bind()` mints a token → a private {@link McpServer}
 * whose tool handlers close over the execution's `workspacePath` + `executionId`.
 * The token rides the URL query; the workspace binding lives in the closure, so an
 * automation can neither read nor write another workspace's data. `dispose()`
 * evicts the binding at execution end, and the token is a per-execution resource:
 * the next execution of the same automation mints a fresh token, server, and closure.
 */
import type { Context } from 'hono'
import { getConnInfo } from '@hono/node-server/conninfo'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import type { RemoteMcpServer } from '../../kernel/agent/adapters/types.js'
import {
  buildAutomationC3Tools,
  type AutomationC3ToolResult,
  type AutomationMcpDeps,
} from '../../features/automations/c3-tools.js'

/** The loopback path the automation MCP route is mounted at. */
export const AUTOMATION_MCP_PATH = '/internal/automation-mcp/v1'

/** Per-execution binding: which workspace the tools act on, and the execution/log id. */
export interface AutomationMcpBinding {
  workspacePath: string
  /** The automation execution (log) id — attributes published PR events to this run. */
  executionId: string
  /**
   * The automation's own free-form annotations, seeded into every `publish_event`
   * this execution emits (the model's own `metadata` wins on key conflicts).
   * Absent means none.
   */
  metadata?: Record<string, string>
}

/** The served route: the kernel-facing bind handle plus the HTTP handler the root mounts. */
export interface ServedAutomationMcp {
  /** Loopback base URL the bound descriptors point at (`http://127.0.0.1:<port><PATH>`). */
  readonly baseUrl: string
  /**
   * Bind one automation execution: mint a token, stand up a private MCP server
   * carrying the full automation c3 tool set, and return the neutral
   * {@link RemoteMcpServer} descriptor (for `DriverStartOptions.mcpServers`) plus a
   * `dispose` to evict at execution end.
   */
  bind(binding: AutomationMcpBinding): {
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
 * Build the automation MCP route. `origin` is c3's own loopback origin
 * (`http://127.0.0.1:<port>`); `deps` injects the composition-root callbacks the
 * tool handlers need; `makeToken` is injected for tests (defaults to
 * `crypto.randomUUID`).
 */
export function createAutomationMcp(
  origin: string,
  deps: AutomationMcpDeps,
  makeToken: () => string = () => crypto.randomUUID(),
): ServedAutomationMcp {
  const baseUrl = `${origin.replace(/\/$/, '')}${AUTOMATION_MCP_PATH}`
  const entries = new Map<string, Entry>()

  const buildServer = (
    binding: AutomationMcpBinding,
  ): { server: McpServer; toolNames: string[] } => {
    const server = new McpServer({ name: 'c3', version: '1.0.0' })
    const tools = buildAutomationC3Tools(
      binding.workspacePath,
      binding.executionId,
      deps,
      binding.metadata,
    )
    for (const t of tools) {
      server.registerTool(
        t.name,
        { description: t.description, inputSchema: t.inputSchema },
        async (args) => toCallResult(await t.handler(args)),
      )
    }
    return { server, toolNames: tools.map((t) => t.name) }
  }

  return {
    baseUrl,
    bind(binding) {
      const token = makeToken()
      const { server, toolNames } = buildServer(binding)
      // Stateful: the client initializes once, gets a session id, and reuses it.
      // One transport per token === one MCP session per execution.
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
            // Codex marks each enabled tool required/approved, so the route must
            // advertise ALL automation c3 tools (not the intent route's 3-tool
            // default) or a registered tool would be silently disabled.
            enabledTools: toolNames,
          },
        },
        dispose: () => {
          const entry = entries.get(token)
          if (!entry) return
          // Evict FIRST so an in-flight request that lost the race 404s instead of
          // reaching a closing transport; then close transport + server.
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
        return c.json({ error: 'automation MCP is loopback-only' }, 403)
      }
      const token = c.req.query('token') ?? ''
      const entry = entries.get(token)
      if (!entry) {
        return c.json({ error: 'unknown or expired automation-MCP token' }, 404)
      }
      await entry.ready
      return entry.transport.handleRequest(c.req.raw)
    },
  }
}

/** Map our framing-free tool result to the MCP SDK `CallToolResult` shape (structurally identical). */
function toCallResult(r: AutomationC3ToolResult): {
  content: Array<{ type: 'text'; text: string }>
  isError?: boolean
} {
  return r.isError ? { content: r.content, isError: true } : { content: r.content }
}
