/**
 * Localhost HTTP MCP route for the QUEUE ADVISOR tool group.
 *
 * A sibling of `transport/automation-mcp`, deliberately not a reuse of it: the
 * advisor group is bound per CONSULTATION (a workspace + one intent + a chain
 * depth), not per automation execution, and it must never be reachable from an
 * ordinary automation's tool list. Two routes with two registries is what makes
 * "the advisor has capabilities automations do not" a structural fact rather
 * than a naming convention.
 *
 * Same plumbing discipline as its siblings: an opaque per-consultation token, a
 * loopback guard ON TOP of c3's localhost-only bind, and behaviour that comes
 * entirely from the framing-free builder (`features/intents/advisor-tools.ts`)
 * with composition-root callbacks injected — this module never reaches into a
 * store itself.
 *
 * Vendor neutrality (ADR-0011): Claude and Codex read the SAME tools from the
 * SAME route. The descriptor lists every tool name explicitly because Codex
 * marks each enabled tool required/approved — a name missing from
 * `enabledTools` would be silently disabled for Codex only, which is exactly the
 * kind of per-vendor drift the neutrality rule exists to prevent.
 */
import type { Context } from 'hono'
import { getConnInfo } from '@hono/node-server/conninfo'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import type { RemoteMcpServer } from '../../kernel/agent/adapters/types.js'
import {
  buildAdvisorC3Tools,
  type AdvisorScopeBinding,
  type AdvisorToolDeps,
  type AdvisorToolResult,
} from '../../features/intents/advisor-tools.js'

/** The loopback path the advisor MCP route is mounted at. */
export const ADVISOR_MCP_PATH = '/internal/advisor-mcp/v1'

/** Per-consultation binding — exactly the scope the tools close over. */
export type AdvisorMcpBinding = AdvisorScopeBinding

/** The served route: the kernel-facing bind handle plus the HTTP handler the root mounts. */
export interface ServedAdvisorMcp {
  /** Loopback base URL the bound descriptors point at. */
  readonly baseUrl: string
  bind(binding: AdvisorMcpBinding): {
    servers: Record<string, RemoteMcpServer>
    dispose: () => void
  }
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

export function createAdvisorMcp(
  origin: string,
  deps: AdvisorToolDeps,
  makeToken: () => string = () => crypto.randomUUID(),
): ServedAdvisorMcp {
  const baseUrl = `${origin.replace(/\/$/, '')}${ADVISOR_MCP_PATH}`
  const entries = new Map<string, Entry>()

  return {
    baseUrl,
    bind(binding) {
      const token = makeToken()
      const server = new McpServer({ name: 'c3', version: '1.0.0' })
      const tools = buildAdvisorC3Tools(binding, deps)
      for (const t of tools) {
        server.registerTool(
          t.name,
          { description: t.description, inputSchema: t.inputSchema },
          async (args) => toCallResult(await t.handler(args)),
        )
      }
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
            enabledTools: tools.map((t) => t.name),
          },
        },
        dispose: () => {
          const entry = entries.get(token)
          if (!entry) return
          // Evict FIRST so an in-flight request that lost the race 404s instead
          // of reaching a closing transport; then close transport + server.
          entries.delete(token)
          void entry.transport.close()
          void entry.server.close()
        },
      }
    },
    async handler(c) {
      const remote = getConnInfo(c).remote.address
      if (!isLoopback(remote)) {
        return c.json({ error: 'advisor MCP is loopback-only' }, 403)
      }
      const token = c.req.query('token') ?? ''
      const entry = entries.get(token)
      if (!entry) {
        return c.json({ error: 'unknown or expired advisor-MCP token' }, 404)
      }
      await entry.ready
      return entry.transport.handleRequest(c.req.raw)
    },
  }
}

/** Map our framing-free tool result to the MCP SDK `CallToolResult` shape. */
function toCallResult(r: AdvisorToolResult): {
  content: Array<{ type: 'text'; text: string }>
  isError?: boolean
} {
  return r.isError ? { content: r.content, isError: true } : { content: r.content }
}
