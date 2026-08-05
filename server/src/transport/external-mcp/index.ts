/**
 * The PUBLIC external MCP route (`/mcp/v1`) — the one c3 surface an agent c3 did
 * not start is allowed to reach.
 *
 * It is deliberately NOT a relaxation of the six `/internal/*-mcp/v1` routes; it
 * is a separate route with a separate trust model, and the internal ones keep
 * their loopback guard and per-run tokens untouched:
 *
 *  - internal: the peer must be loopback, and the scope comes from a run closure
 *    c3 itself created (workspace + run id), addressed by a one-shot token.
 *  - external: there is no run and no loopback assumption. The scope is rebuilt
 *    from the request on EVERY call — a long-lived API key decides *who*, and a
 *    `workspace` query parameter decides *where*, with the key's authorization
 *    set deciding whether that pairing is allowed at all.
 *
 * Because the key is the only credential, the checks run in a fixed order and
 * never leak more than the caller already knows:
 *   token missing/malformed/unknown/mismatched/revoked → 401 (one indistinguishable body)
 *   workspace parameter missing or not absolute        → 400
 *   workspace not in this key's authorization set      → 403
 *   authorized but not a registered c3 workspace       → 404
 * 403 precedes 404 on purpose: a caller must not be able to enumerate which
 * workspaces exist on the host by probing paths it has no claim to.
 *
 * An MCP session, once initialized, is pinned to the key id and workspace it was
 * authenticated with. A later request on the same session that
 * presents a different key or workspace is refused rather than silently
 * re-scoped — the query string cannot be used to walk a live session into
 * another workspace.
 *
 * Nothing here memoizes "this key is valid": every request re-verifies, and
 * {@link ServedExternalMcp.closeSessionsForKey} lets revocation also tear down
 * sessions that are already open.
 */
import type { Context } from 'hono'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import type { AuthenticatedMcpApiKey } from '../../kernel/config/mcp-api-keys.js'
import type {
  ExternalMcpScope,
  ExternalMcpTool,
  ExternalToolResult,
} from '../../features/external-mcp/tools.js'

/** The public path the external MCP route is mounted at. */
export const EXTERNAL_MCP_PATH = '/mcp/v1'

/** The header a Streamable HTTP client carries its session id in. */
const SESSION_HEADER = 'mcp-session-id'

/** Everything the route needs from the composition root; no store is reached directly. */
export interface ExternalMcpDeps {
  /** Verify a presented plaintext key against current storage. `null` ⇒ not authenticated. */
  authenticate: (token: string) => Promise<AuthenticatedMcpApiKey | null>
  /** Force a raw workspace parameter into the ONE canonical comparison form; `null` ⇒ not absolute. */
  canonicalizeWorkspace: (raw: string) => string | null
  /**
   * Map a canonical path onto the workspace path c3 itself uses, or `null` when
   * no registered workspace matches. Returning the REGISTRY spelling (rather than
   * a boolean) is deliberate: the canonical form is for equivalence checks only,
   * while feature code must be handed the same path every internal caller uses.
   */
  resolveRegisteredWorkspace: (canonicalPath: string) => string | null
  /** Build the allowlisted tool set for one authenticated scope. */
  buildTools: (scope: ExternalMcpScope) => ExternalMcpTool[]
  /** Notified after each successful authentication (records "last used"). Best-effort. */
  onAuthenticated?: (keyId: string) => void
}

/** The served route: the HTTP handler plus the revocation hook. */
export interface ServedExternalMcp {
  /** The Hono handler for `ALL /mcp/v1` (POST messages / GET SSE / DELETE session-end). */
  handler: (c: Context) => Promise<Response>
  /**
   * Tear down every live MCP session belonging to a key. Called when the key is
   * revoked so an already-open transport cannot keep serving after deletion.
   */
  closeSessionsForKey: (keyId: string) => void
  /** Number of live MCP sessions. Test seam. */
  sessionCount: () => number
}

interface Session {
  transport: WebStandardStreamableHTTPServerTransport
  server: McpServer
  /** Resolves once `server.connect(transport)` finishes — dispatch awaits it. */
  ready: Promise<void>
  keyId: string
  /** The registry workspace path this session was authenticated for; immutable. */
  workspacePath: string
}

/** Uniform rejection bodies — a caller cannot tell WHICH check failed beyond the status. */
const UNAUTHORIZED = { error: 'unauthorized' } as const
const FORBIDDEN = { error: 'forbidden' } as const
const NOT_FOUND = { error: 'not found' } as const
const BAD_WORKSPACE = { error: 'workspace parameter must be an absolute path' } as const

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

  const openSession = (scope: ExternalMcpScope): Session => {
    const server = new McpServer({ name: 'c3', version: '1.0.0' })
    for (const tool of deps.buildTools(scope)) {
      server.registerTool(
        tool.name,
        { description: tool.description, inputSchema: tool.inputSchema },
        async (args) => toCallResult(await tool.handler(args)),
      )
    }
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
      // 1. Credential. Checked before anything else so an unauthenticated caller
      //    learns nothing — not even whether its workspace parameter was shaped
      //    correctly.
      const token = c.req.query('token') ?? ''
      if (!token) return c.json(UNAUTHORIZED, 401)
      const auth = await deps.authenticate(token)
      if (!auth) return c.json(UNAUTHORIZED, 401)
      deps.onAuthenticated?.(auth.id)

      // 2. Target, in canonical form. A relative/blank path is the caller's
      //    mistake, not a lookup miss.
      const rawWorkspace = c.req.query('workspace') ?? ''
      const canonical = rawWorkspace ? deps.canonicalizeWorkspace(rawWorkspace) : null
      if (!canonical) return c.json(BAD_WORKSPACE, 400)

      // 3. Authorization, then existence. Never the other way round.
      if (!auth.workspaces.includes(canonical)) return c.json(FORBIDDEN, 403)
      // Everything downstream acts on the REGISTRY path, not the canonical one.
      const workspacePath = deps.resolveRegisteredWorkspace(canonical)
      if (!workspacePath) return c.json(NOT_FOUND, 404)

      const scope: ExternalMcpScope = { workspacePath, keyId: auth.id }
      const sessionId = c.req.header(SESSION_HEADER)

      if (sessionId) {
        const existing = sessions.get(sessionId)
        // An unknown session id gets the transport-level 404 the MCP spec
        // prescribes; we answer it ourselves because no transport owns it.
        if (!existing) return c.json(NOT_FOUND, 404)
        // The session's scope is fixed at initialize. Presenting another key or
        // workspace on the same session is a re-scope attempt, not a new session.
        if (existing.keyId !== scope.keyId || existing.workspacePath !== scope.workspacePath)
          return c.json(FORBIDDEN, 403)
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

/** Map our framing-free tool result to the MCP SDK `CallToolResult` shape (structurally identical). */
function toCallResult(r: ExternalToolResult): {
  content: Array<{ type: 'text'; text: string }>
  isError?: boolean
} {
  return r.isError ? { content: r.content, isError: true } : { content: r.content }
}
