/**
 * Localhost HTTP MCP route for the spec REVIEWER's tools — the same transport
 * both Claude and Codex consume (no in-process SDK MCP server for c3 tools).
 *
 * Deliberately NOT a reuse of the spec-query route: a reviewer needs one tool the
 * author must never have (`submit_spec_review`), and the author needs none of the
 * reviewer's binding. Keeping the two routes apart means neither can drift into
 * offering the other's surface.
 *
 * The binding carries the reviewed intent and the spec fingerprint captured at
 * launch. Neither is a tool argument, so a review run can only ever conclude
 * about the ONE intent it was launched for, and can never claim to have judged
 * content it did not see.
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
import {
  runSubmitSpecReview,
  submitSpecReviewDesc,
  submitSpecReviewSchema,
  type SubmitSpecReviewArgs,
} from '../../features/intents/spec-review.js'

export const SPEC_REVIEW_MCP_PATH = '/internal/spec-review-mcp/v1'

export interface SpecReviewMcpBinding {
  workspacePath: string
  /** The intent under review. Fixed at launch; never a tool argument. */
  intentId: string
  /** The spec fingerprint captured when this review was launched. */
  fingerprint: string
  getRunId: () => string
  signal: AbortSignal
}

export interface ServedSpecReviewMcp {
  readonly baseUrl: string
  bind(binding: SpecReviewMcpBinding): {
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

export function createSpecReviewMcp(
  origin: string,
  makeToken: () => string = () => crypto.randomUUID(),
): ServedSpecReviewMcp {
  const baseUrl = `${origin.replace(/\/$/, '')}${SPEC_REVIEW_MCP_PATH}`
  const entries = new Map<string, Entry>()

  const buildServer = (binding: SpecReviewMcpBinding): McpServer => {
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
    server.registerTool(
      'submit_spec_review',
      { description: submitSpecReviewDesc, inputSchema: submitSpecReviewSchema },
      async (args) =>
        toCallResult(
          runSubmitSpecReview(
            binding.workspacePath,
            {
              intentId: binding.intentId,
              sessionId: binding.getRunId(),
              fingerprint: binding.fingerprint,
            },
            args as SubmitSpecReviewArgs,
          ),
        ),
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
            enabledTools: ['find_intents', 'view_intent', 'submit_spec_review'],
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
        return c.json({ error: 'spec review MCP is loopback-only' }, 403)
      }
      const token = c.req.query('token') ?? ''
      const entry = entries.get(token)
      if (!entry) {
        return c.json({ error: 'unknown or expired spec-review-MCP token' }, 404)
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
