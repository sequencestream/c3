/**
 * Localhost HTTP MCP route for the chat-robot c3 tool profile. A robot turn's
 * SELECTED c3 tools are served over this ONE streamable-HTTP MCP route bound to
 * a single robot turn — the same transport every vendor consumes (mirror of
 * `transport/automation-mcp`, but the binding registers only the subset this
 * robot's allowlist ticked, never the full automation catalogue).
 *
 * Per-turn isolation: each `bind()` mints a token → a private {@link McpServer}
 * whose tool handlers close over the robot's run root (`~/.c3/robots/<name>`,
 * passed as `workspacePath`) and the live run/session identity. Only the
 * selected tools are registered — an unselected tool appears in neither
 * `tools/list` nor dispatch (the MCP SDK rejects a call to an unregistered
 * tool). `dispose()` evicts the binding at turn end (complete, timeout, blocked
 * or launch failure), and the token is a per-turn resource: the next turn of
 * the same robot mints a fresh token, server, and closure.
 *
 * The tool behaviors come from the shared automation c3-tools builder with
 * composition-root callbacks injected as `deps` — a lazy getter, because the
 * full deps object closes over `launchDeps` which is constructed later at the
 * composition root. The deps are only consulted at tool-dispatch time, well
 * after startup, so the getter resolves the same object every route reads.
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

/** The loopback path the robot MCP route is mounted at. */
export const ROBOT_MCP_PATH = '/internal/robot-mcp/v1'

/** Per-turn binding: which directory the tools act on, and the run identity. */
export interface RobotMcpBinding {
  /** The robot's working directory — `~/.c3/robots/<name>`. All tools are scoped to it. */
  workspacePath: string
  /**
   * The LIVE run/session id. A getter so a pending→real rebind attributes the
   * turn's `publish_event` to the bound session, not the stale pending id.
   */
  getRunId: () => string
  /** Bare c3 tool names the robot's allowlist selected (`find_intents`, …). */
  selectedTools: readonly string[]
}

/** The served route: the kernel-facing bind handle plus the HTTP handler the root mounts. */
export interface ServedRobotMcp {
  /** Loopback base URL the bound descriptors point at (`http://127.0.0.1:<port><PATH>`). */
  readonly baseUrl: string
  /**
   * Bind one robot turn: mint a token, stand up a private MCP server carrying
   * exactly the turn's selected c3 tools, and return the neutral
   * {@link RemoteMcpServer} descriptor (for `DriverStartOptions.mcpServers`) plus a
   * `dispose` to evict at turn end.
   */
  bind(binding: RobotMcpBinding): {
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
 * Build the robot MCP route. `origin` is c3's own loopback origin
 * (`http://127.0.0.1:<port>`); `deps` lazily supplies the composition-root
 * callbacks the tool handlers need (the same object automation binds); `makeToken`
 * is injected for tests (defaults to `crypto.randomUUID`).
 */
export function createRobotMcp(
  origin: string,
  deps: () => AutomationMcpDeps | null,
  makeToken: () => string = () => crypto.randomUUID(),
): ServedRobotMcp {
  const baseUrl = `${origin.replace(/\/$/, '')}${ROBOT_MCP_PATH}`
  const entries = new Map<string, Entry>()

  const buildServer = (binding: RobotMcpBinding): { server: McpServer; toolNames: string[] } => {
    const server = new McpServer({ name: 'c3', version: '1.0.0' })
    const tools = buildAutomationC3Tools(binding.workspacePath, binding.getRunId, deps()).filter(
      (t) => binding.selectedTools.includes(t.name),
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
      // One transport per token === one MCP session per robot turn.
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
            // advertise EXACTLY the registered subset — a registered tool that is
            // omitted here would be silently disabled.
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
        return c.json({ error: 'robot MCP is loopback-only' }, 403)
      }
      const token = c.req.query('token') ?? ''
      const entry = entries.get(token)
      if (!entry) {
        return c.json({ error: 'unknown or expired robot-MCP token' }, 404)
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
