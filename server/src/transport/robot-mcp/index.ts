/**
 * Localhost HTTP MCP route for the chat-robot c3 tool profile.
 *
 * Per-turn isolation: each `bind()` mints a token → a private {@link McpServer}.
 * L1 read tools use call-level scope (re-read binding / ACL / group whitelist on
 * every handler). The run root is NOT an authorization workspace for ledger
 * tools. Non-L1 selected c3 tools refuse with a Web-only guide — they must not
 * reverse-lookup object ids into registered workspace paths.
 *
 * External MCP's connection-level `X-C3-Workspace` pin is deliberately not used
 * here.
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
import {
  buildRobotL1Tools,
  refuseWriteViaObjectId,
  type RobotL1AuthContext,
} from '../../features/im/robot-l1-tools.js'
import { isL1ReadTool } from '../../features/im/call-scope.js'
import type { ImPlatform } from '@ccc/shared/protocol'

/** The loopback path the robot MCP route is mounted at. */
export const ROBOT_MCP_PATH = '/internal/robot-mcp/v1'

/** Per-turn binding: run root for local tools + IM auth for L1 ledger tools. */
export interface RobotMcpBinding {
  /**
   * Robot working directory — `~/.c3/robots/<name>`. Local file tools stay here;
   * it is never treated as a registered workspace for L1 ledger tools.
   */
  workspacePath: string
  getRunId: () => string
  /** Bare c3 tool names the robot's allowlist selected. */
  selectedTools: readonly string[]
  /** Required for L1 call-level scope. Absent ⇒ L1 tools refuse. */
  imAuth?: {
    robotId: string
    senderId: string
    chatType: 'group' | 'p2p'
    chatId: string
    providerAccountKey: string
    platform: ImPlatform
    expectedBindingId: string
    turnStartScopeHash: string
    onScopeChanged?: () => void
  }
}

export interface ServedRobotMcp {
  readonly baseUrl: string
  bind(binding: RobotMcpBinding): {
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

function toCallResult(r: AutomationC3ToolResult): {
  content: Array<{ type: 'text'; text: string }>
  isError?: boolean
} {
  return r.isError ? { content: r.content, isError: true } : { content: r.content }
}

export function createRobotMcp(
  origin: string,
  deps: () => AutomationMcpDeps | null,
  makeToken: () => string = () => crypto.randomUUID(),
): ServedRobotMcp {
  const baseUrl = `${origin.replace(/\/$/, '')}${ROBOT_MCP_PATH}`
  const entries = new Map<string, Entry>()

  const buildServer = (binding: RobotMcpBinding): { server: McpServer; toolNames: string[] } => {
    const server = new McpServer({ name: 'c3', version: '1.0.0' })
    const selected = binding.selectedTools
    const toolNames: string[] = []

    const l1Selected = selected.filter(isL1ReadTool)
    if (l1Selected.length > 0 && binding.imAuth) {
      const auth: RobotL1AuthContext = {
        robotId: binding.imAuth.robotId,
        senderId: binding.imAuth.senderId,
        chat: {
          chatType: binding.imAuth.chatType,
          chatId: binding.imAuth.chatId,
          platform: binding.imAuth.platform,
          providerAccountKey: binding.imAuth.providerAccountKey,
        },
        expectedBindingId: binding.imAuth.expectedBindingId,
        turnStartScopeHash: binding.imAuth.turnStartScopeHash,
        onScopeChanged: binding.imAuth.onScopeChanged,
      }
      for (const t of buildRobotL1Tools(auth)) {
        if (!l1Selected.includes(t.name as (typeof l1Selected)[number])) continue
        server.registerTool(
          t.name,
          { description: t.description, inputSchema: t.inputSchema },
          async (args) => toCallResult(await t.handler(args)),
        )
        toolNames.push(t.name)
      }
    } else if (l1Selected.length > 0) {
      // Auth missing — register L1 names that always refuse (no ledger leak).
      for (const name of l1Selected) {
        server.registerTool(name, { description: 'identity required', inputSchema: {} }, async () =>
          toCallResult({
            content: [{ type: 'text', text: JSON.stringify({ code: 'not_visible' }) }],
          }),
        )
        toolNames.push(name)
      }
    }

    // Non-L1 selected tools: never bind to a registered workspace path.
    const nonL1 = selected.filter((n) => !isL1ReadTool(n))
    if (nonL1.length > 0) {
      const all = buildAutomationC3Tools(binding.workspacePath, binding.getRunId, deps())
      for (const t of all) {
        if (!nonL1.includes(t.name)) continue
        // Write / action tools: Web-only guide. Do not close over a registry path.
        server.registerTool(
          t.name,
          { description: t.description, inputSchema: t.inputSchema },
          async () => toCallResult(refuseWriteViaObjectId()),
        )
        toolNames.push(t.name)
      }
    }

    return { server, toolNames }
  }

  return {
    baseUrl,
    bind(binding) {
      const token = makeToken()
      const { server, toolNames } = buildServer(binding)
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
            enabledTools: toolNames,
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
