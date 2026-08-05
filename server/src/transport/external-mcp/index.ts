/**
 * The PUBLIC external MCP route (`/mcp/<api-key>`) — the one c3 surface an agent
 * c3 did not start is allowed to reach.
 *
 * It is deliberately NOT a relaxation of the six `/internal/*-mcp/v1` routes; it
 * is a separate route with a separate trust model, and the internal ones keep
 * their loopback guard and per-run tokens untouched:
 *
 *  - internal: the peer must be loopback, and the scope comes from a run closure
 *    c3 itself created (workspace + run id), addressed by a one-shot token.
 *  - external: there is no run and no loopback assumption. The key IS the address:
 *    it decides *who*, *where* (one bound workspace) and *what* (the tool scope an
 *    administrator ticked). Nothing about the scope is negotiable by the caller —
 *    there is no `workspace` parameter left to disagree with.
 *
 * Because the key is the only credential, the checks run in a fixed order and
 * never leak more than the caller already knows:
 *   path not a single segment / key malformed / unknown / revoked → 401
 *   bound workspace no longer registered or readable                → 403
 *   authorized, but the tool was not ticked for this key            → MCP tool error
 * The key never appears in a rejection body or a log line: it is a bearer
 * credential that now rides the path, so echoing the URL would echo the secret.
 *
 * An MCP session, once initialized, is pinned to the key id AND the tool scope it
 * was authenticated with. Presenting the same session id under another key is
 * refused rather than silently re-scoped, and a session whose key has since been
 * re-scoped is refused too — so a failed teardown can never leave old privileges
 * running.
 *
 * Nothing here memoizes "this key is valid": every request re-verifies, and
 * {@link ServedExternalMcp.closeSessionsForKey} lets a revoke or a scope change
 * also tear down sessions that are already open.
 */
import type { Context } from 'hono'
import { z } from 'zod'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js'
import type { AuthenticatedMcpApiKey } from '../../kernel/config/mcp-api-keys.js'
import type {
  ExternalMcpScope,
  ExternalMcpTool,
  ExternalToolResult,
} from '../../features/external-mcp/tools.js'

/** The public path prefix the external MCP route is mounted under. */
export const EXTERNAL_MCP_PATH_PREFIX = '/mcp'

/**
 * The retired `/mcp/v1?token=…&workspace=…` entry point. It is answered with an
 * explicit discontinued response rather than a 401: a stale client must learn it
 * needs a new ADDRESS, not that its credential went bad. Keeping it as a live
 * alternative was rejected outright — two authorization sources for the same
 * surface is exactly the drift this change exists to remove.
 *
 * No key can collide with it: a plaintext key is always `c3k_<id>_<secret>`.
 */
export const LEGACY_EXTERNAL_MCP_SEGMENT = 'v1'

/** The header a Streamable HTTP client carries its session id in. */
const SESSION_HEADER = 'mcp-session-id'

/** Everything the route needs from the composition root; no store is reached directly. */
export interface ExternalMcpDeps {
  /** Verify a presented plaintext key against current storage. `null` ⇒ not authenticated. */
  authenticate: (key: string) => Promise<AuthenticatedMcpApiKey | null>
  /**
   * Map the key's bound canonical path onto the workspace path c3 itself uses, or
   * `null` when no registered workspace matches (or its directory is gone).
   * Returning the REGISTRY spelling (rather than a boolean) is deliberate: the
   * canonical form is for equivalence checks only, while feature code must be
   * handed the same path every internal caller uses.
   */
  resolveRegisteredWorkspace: (canonicalPath: string) => string | null
  /** Build the FULL externally-grantable catalog for one scope; this route filters it. */
  buildCatalog: (scope: ExternalMcpScope) => ExternalMcpTool[]
  /** Notified after each successful authentication (records "last used"). Best-effort. */
  onAuthenticated?: (keyId: string) => void
}

/** The served route: the HTTP handler plus the revocation hook. */
export interface ServedExternalMcp {
  /** The Hono handler for `ALL /mcp/*` (POST messages / GET SSE / DELETE session-end). */
  handler: (c: Context) => Promise<Response>
  /**
   * Tear down every live MCP session belonging to a key. Called when the key is
   * revoked or its tool scope changes, so an already-open transport cannot keep
   * serving under the old authorization.
   */
  closeSessionsForKey: (keyId: string) => void
  /** Number of live MCP sessions. Test seam. */
  sessionCount: () => number
}

interface Session {
  transport: WebStandardStreamableHTTPServerTransport
  server: Server
  /** Resolves once `server.connect(transport)` finishes — dispatch awaits it. */
  ready: Promise<void>
  keyId: string
  /** The registry workspace path this session was authenticated for; immutable. */
  workspacePath: string
  /** The tool scope pinned at initialize, in a comparable form. */
  scopeKey: string
}

/** Uniform rejection bodies — a caller cannot tell WHICH check failed beyond the status. */
const UNAUTHORIZED = { error: 'unauthorized' } as const
const FORBIDDEN = { error: 'forbidden' } as const
const NOT_FOUND = { error: 'not found' } as const
/** The retired query-addressed entry point. Says what to do, names no credential. */
const DISCONTINUED = {
  error: 'discontinued',
  message: 'The /mcp/v1?token=… entry point was removed. Use /mcp/<api-key> instead.',
} as const

/**
 * The refusal an un-granted (or unknown) tool call gets. It is a TOOL error, not
 * an HTTP status: the caller is authenticated and its transport is legitimate —
 * only this one capability is not its to use. The wording does not distinguish
 * "exists but not granted" from "no such tool", so the error cannot be used to
 * enumerate the catalog.
 */
function forbiddenTool(name: string): ExternalToolResult {
  return {
    content: [{ type: 'text', text: `forbidden: tool "${name}" is not authorized for this key` }],
    isError: true,
  }
}

/** A stable, comparable form of a tool scope (order-insensitive). */
function scopeKeyOf(tools: readonly string[]): string {
  return [...tools].sort().join(',')
}

export function createExternalMcp(deps: ExternalMcpDeps): ServedExternalMcp {
  const sessions = new Map<string, Session>()
  /** key id → its live session ids, so revocation is a lookup rather than a scan. */
  const byKey = new Map<string, Set<string>>()

  const track = (sessionId: string, session: Session): void => {
    sessions.set(sessionId, session)
    const set = byKey.get(session.keyId) ?? new Set<string>()
    set.add(sessionId)
    byKey.set(session.keyId, set)
  }

  const untrack = (sessionId: string): void => {
    const session = sessions.get(sessionId)
    if (!session) return
    sessions.delete(sessionId)
    const set = byKey.get(session.keyId)
    if (set) {
      set.delete(sessionId)
      if (set.size === 0) byKey.delete(session.keyId)
    }
  }

  /**
   * Stand up one MCP server serving EXACTLY this key's granted tools.
   *
   * The dispatch is written out rather than delegated to the SDK's high-level
   * `McpServer` for one reason: this surface must answer an un-granted call with a
   * stable *forbidden* tool error and run no handler, which a registry that simply
   * does not contain the tool cannot express.
   */
  const openSession = (scope: ExternalMcpScope): Session => {
    const granted = new Map<string, ExternalMcpTool>()
    for (const tool of deps.buildCatalog(scope)) {
      if (scope.tools.includes(tool.name)) granted.set(tool.name, tool)
    }

    const server = new Server({ name: 'c3', version: '1.0.0' }, { capabilities: { tools: {} } })
    // `tools/list` is the authorization surface: an un-granted tool is not
    // advertised at all, so a well-behaved client never even offers it.
    server.setRequestHandler(ListToolsRequestSchema, () => ({
      tools: [...granted.values()].map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: toJsonSchema(tool.inputSchema),
      })),
    }))
    server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
      const tool = granted.get(request.params.name)
      // Discovery can be skipped; authorization cannot.
      if (!tool) return forbiddenTool(request.params.name)
      const parsed = z.object(tool.inputSchema).safeParse(request.params.arguments ?? {})
      if (!parsed.success) {
        return {
          content: [{ type: 'text', text: `invalid arguments: ${parsed.error.message}` }],
          isError: true,
        }
      }
      return toCallResult(await tool.handler(parsed.data))
    })

    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      enableJsonResponse: true,
      onsessioninitialized: (sessionId) => track(sessionId, session),
      onsessionclosed: (sessionId) => untrack(sessionId),
    })
    // Build the record BEFORE connecting: `onsessioninitialized` fires from
    // inside the first `handleRequest` and closes over `session`, so the binding
    // must already exist by then.
    const session: Session = {
      transport,
      server,
      ready: Promise.resolve(),
      keyId: scope.keyId,
      workspacePath: scope.workspacePath,
      scopeKey: scopeKeyOf(scope.tools),
    }
    session.ready = server.connect(transport)
    return session
  }

  const closeSession = (session: Session): void => {
    void session.transport.close()
    void session.server.close()
  }

  return {
    async handler(c) {
      // 1. Address. The key is a single path segment — not a prefix match, not a
      //    nested path — so nothing after it can be mistaken for part of the
      //    credential (or smuggle a second target past the checks below).
      const segment = keySegment(c.req.path)
      if (segment === null) return c.json(UNAUTHORIZED, 401)
      if (segment === LEGACY_EXTERNAL_MCP_SEGMENT) return c.json(DISCONTINUED, 410)

      // 2. Credential. Everything downstream is derived from the record it
      //    resolves to; the request carries no other scope input.
      const auth = await deps.authenticate(segment)
      if (!auth) return c.json(UNAUTHORIZED, 401)
      deps.onAuthenticated?.(auth.id)

      // 3. Target. A key whose workspace was unregistered (or whose directory is
      //    gone) reaches nothing — it never falls back to another workspace, and
      //    the response does not disclose the host path it was bound to.
      const workspacePath = deps.resolveRegisteredWorkspace(auth.workspace)
      if (!workspacePath) return c.json(FORBIDDEN, 403)

      const scope: ExternalMcpScope = {
        workspacePath,
        keyId: auth.id,
        tools: auth.tools,
      }
      const sessionId = c.req.header(SESSION_HEADER)

      if (sessionId) {
        const existing = sessions.get(sessionId)
        // An unknown session id gets the transport-level 404 the MCP spec
        // prescribes; we answer it ourselves because no transport owns it.
        if (!existing) return c.json(NOT_FOUND, 404)
        // The session's identity is fixed at initialize. Another key on the same
        // session is a re-scope attempt, not a new session.
        if (existing.keyId !== scope.keyId) return c.json(FORBIDDEN, 403)
        // Defence in depth for the scope change path: storage is authoritative the
        // moment it is written, so a session that outlived its teardown (a close
        // that failed, a race) must not keep serving the privileges it opened with.
        if (existing.scopeKey !== scopeKeyOf(scope.tools)) {
          untrack(sessionId)
          closeSession(existing)
          return c.json(FORBIDDEN, 403)
        }
        await existing.ready
        return existing.transport.handleRequest(c.req.raw)
      }

      // No session id: this must be an `initialize`. Stand one up, let the
      // transport decide, and discard it again if the request turned out not to
      // be an initialize (otherwise every stray POST would leak a server).
      const session = openSession(scope)
      await session.ready
      const response = await session.transport.handleRequest(c.req.raw)
      if (!session.transport.sessionId) closeSession(session)
      return response
    },

    closeSessionsForKey(keyId) {
      const ids = byKey.get(keyId)
      if (!ids) return
      for (const id of [...ids]) {
        const session = sessions.get(id)
        // Evict FIRST so an in-flight request that lost the race 404s instead of
        // reaching a closing transport.
        untrack(id)
        if (session) closeSession(session)
      }
    },

    sessionCount: () => sessions.size,
  }
}

/**
 * The ONE path segment after `/mcp/`, percent-decoded, or `null` when the request
 * is not addressed that way at all.
 *
 * Rejected without looking at storage: a bare `/mcp`, a trailing-slash-only
 * `/mcp/`, and anything with a further segment (`/mcp/<key>/extra`). A key is an
 * opaque credential, so "everything after the prefix" would let a caller append
 * arbitrary text to a valid key and still be routed — the segment must be exact.
 */
export function keySegment(path: string): string | null {
  if (!path.startsWith(`${EXTERNAL_MCP_PATH_PREFIX}/`)) return null
  const rest = path.slice(EXTERNAL_MCP_PATH_PREFIX.length + 1)
  if (!rest || rest.includes('/')) return null
  try {
    const decoded = decodeURIComponent(rest)
    return decoded.length > 0 ? decoded : null
  } catch {
    // A malformed percent-escape is not a key; it is not our job to guess one.
    return null
  }
}

/**
 * Convert a tool's zod input shape to the JSON Schema `tools/list` advertises.
 * `$schema` is dropped because the MCP tool definition carries a schema OBJECT,
 * not a standalone document, and some clients reject the extra key.
 */
function toJsonSchema(shape: ExternalMcpTool['inputSchema']): Record<string, unknown> {
  const schema = z.toJSONSchema(z.object(shape), {
    io: 'input',
    // A shape c3 can validate but JSON Schema cannot express degrades to "any"
    // rather than throwing — a tool must never disappear from the list because
    // its schema had one awkward field.
    unrepresentable: 'any',
  }) as Record<string, unknown>
  const { $schema: _dropped, ...rest } = schema
  return rest
}

/** Map our framing-free tool result to the MCP SDK `CallToolResult` shape (structurally identical). */
function toCallResult(r: ExternalToolResult): {
  content: Array<{ type: 'text'; text: string }>
  isError?: boolean
} {
  return r.isError ? { content: r.content, isError: true } : { content: r.content }
}
