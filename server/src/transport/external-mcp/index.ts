/**
 * The PUBLIC external MCP route — `POST /mcp`, the one c3 surface an agent c3
 * did not start is allowed to reach.
 *
 * The address carries no secret. The credential is `Authorization: Bearer c3k_…`
 * and nothing else: not a path segment, not a query parameter, not `X-API-Key`.
 * A URL is logged by proxies, kept in shell history and pasted into issues; a key
 * that rides one is a key that leaks by being used. `/mcp/<anything>` is not a
 * compatibility route — it is a 404, because two live addresses for one surface
 * is exactly the drift this design removes.
 *
 * Which workspace a session works in comes from `X-C3-Workspace` at initialize.
 * That header is a c3 HTTP extension, NOT an MCP protocol field: Streamable HTTP
 * defines protocol headers such as `Mcp-Session-Id` and leaves tenant selection
 * to the application. The consequence is stated plainly rather than worked
 * around: a client that cannot send arbitrary headers cannot use this endpoint,
 * and there is no query, path, body or tool-argument fallback to guess with.
 *
 * Deliberately NOT a relaxation of the six `/internal/*-mcp/v1` routes. Those
 * keep loopback plus a per-run token, because their scope comes from a run
 * closure c3 itself created. An external caller has no run, so its scope comes
 * from an authorization decision instead — and this route makes exactly one, via
 * the injected {@link ExternalMcpDeps.authorize}. Nothing here decides who may
 * reach what; it only refuses what the gate refused.
 *
 * Checks run in a fixed order, and the order is a security property:
 *   exposed with no administrator                    → 503 (no session at all)
 *   not the bare `/mcp` path                         → 404
 *   credential missing / malformed / unknown / stale → 401, one identical body
 *   workspace header absent or unusable              → 400
 *   workspace outside the caller's effective set     → 403
 *   authorized, tool not in the effective set        → MCP tool error
 * The bearer value never appears in a response body or a log line.
 *
 * A session, once initialized, is pinned to `(keyId, secretVersion,
 * workspaceName, policyEpoch)` and re-checked on every request. Persisted policy
 * is authoritative the instant it is written, so a transport that outlived its
 * teardown — a close that failed, a race — cannot keep serving the authority it
 * opened with.
 *
 * Every TOOL CALL is authorized again on its own terms. A write may name another
 * workspace (`workspaceName`), which is a request for a different target, not a
 * re-scope of the session: the gate runs with the current principal, that target
 * and that tool name, and the handler then acts on the scope the gate produced.
 * Nothing here trusts the workspace a session was built with, so a model that was
 * talked into inventing a workspace name gets a forbidden, not a write.
 *
 * Every attempted call of a KNOWN WRITE tool is audited — granted or not, valid
 * or not — and the audit insert is awaited before the tool response is sent.
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
import type {
  AuthorizeResult,
  EffectiveScope,
  ExternalMcpPrincipal,
} from '../../features/auth/authorization.js'
import type {
  ExternalMcpAuditResult,
  ExternalMcpWriteAuditInput,
} from '../../features/external-mcp/audit-store.js'
import type { ExternalMcpTool, ExternalToolResult } from '../../features/external-mcp/tools.js'

/** The one public path. Not a prefix: nothing may follow it. */
export const EXTERNAL_MCP_PATH = '/mcp'

/** The header a Streamable HTTP client carries its session id in. */
const SESSION_HEADER = 'mcp-session-id'

/** The c3 extension header that selects a session's workspace at initialize. */
export const WORKSPACE_HEADER = 'x-c3-workspace'

/**
 * Loopback addresses: IPv4, IPv6, IPv4-mapped, and the `localhost` spelling.
 *
 * A peer address is always numeric, so `localhost` is here for the OTHER caller:
 * the bind-address check. `--host localhost` binds to loopback exactly like
 * `--host 127.0.0.1`, and reading it as "exposed to the network" would answer
 * 503 to a deployment that is not exposed at all.
 */
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1', 'localhost'])

/** Whether an address is the local host. Exported for tests. */
export function isLoopbackAddress(address: string | undefined | null): boolean {
  if (!address) return false
  return LOOPBACK.has(address) || address.startsWith('127.')
}

/**
 * What an `Authorization` header amounts to. THREE states, not two, and the
 * third one is the security-relevant one: a header that is present but yields no
 * bearer is a credential the caller DID present, so it must be refused — folding
 * it in with `absent` would let `Bearer ` (empty), `Bearer a b` or a `Basic`
 * credential fall through to the trusted-local principal and turn a typo into
 * full access.
 */
export type Credential =
  { kind: 'absent' } | { kind: 'bearer'; token: string } | { kind: 'unusable' }

/**
 * Read the credential out of the `Authorization` header.
 *
 * Only a header that is not there at all is `absent`. A header that is there but
 * carries nothing readable — including the empty value a proxy leaves behind
 * when it strips `Authorization`, which the Fetch standard hands us as `""`
 * whether the value was empty or only whitespace — is `unusable`, because the
 * existence of the header is itself the caller presenting a credential.
 *
 * Case-insensitive on the scheme (RFC 7235 says the scheme is case-insensitive)
 * but strict about everything else: no second credential, no empty token. A
 * `Basic` or `X-API-Key` credential is not read as a credential value — but its
 * presence is still noticed, because "presented and unusable" is a 401 and not a
 * credential-free request.
 */
export function readCredential(header: string | undefined | null): Credential {
  if (typeof header !== 'string') return { kind: 'absent' }
  const match = /^Bearer[ \t]+(\S+)[ \t]*$/i.exec(header.trim())
  return match ? { kind: 'bearer', token: match[1] } : { kind: 'unusable' }
}

/** A workspace header that is syntactically usable, or why it is not. */
export type WorkspaceHeader =
  { ok: true; name: string } | { ok: false; reason: 'missing' | 'malformed' }

/**
 * Validate `X-C3-Workspace` as a STRING, before any registry lookup. Duplicated
 * headers arrive comma-joined per the Fetch standard, and a comma cannot occur in
 * a workspace name — so a repeated header is a malformed request, never a silent
 * "first one wins". Existence and authorization are separate questions answered
 * later, with a response that does not distinguish them.
 */
export function readWorkspaceHeader(raw: string | undefined | null): WorkspaceHeader {
  if (typeof raw !== 'string' || raw.trim().length === 0) return { ok: false, reason: 'missing' }
  const value = raw.trim()
  // 64 mirrors the registry's own name length limit; anything longer cannot name
  // a workspace, so it is rejected before it reaches a lookup.
  if (value.includes(',') || value.length > 64) return { ok: false, reason: 'malformed' }
  return { ok: true, name: value }
}

/** Everything the route needs from the composition root; no store is reached directly. */
export interface ExternalMcpDeps {
  /** Verify a presented bearer key against current storage. `null` ⇒ not authenticated. */
  authenticate: (key: string) => Promise<ExternalMcpPrincipal | null>
  /**
   * The principal a credential-free loopback peer acts as, or `null` when this
   * deployment requires a key. Non-null only in trusted-local mode (no configured
   * administrator).
   */
  trustedLocalPrincipal: () => ExternalMcpPrincipal | null
  /** The ONE authorization gate. `toolName` is null when no tool is being called. */
  authorize: (
    auth: ExternalMcpPrincipal,
    workspaceName: string,
    toolName: string | null,
  ) => AuthorizeResult
  /**
   * Whether the whole surface must refuse: reachable from the network with no
   * administrator to authorize anything. Checked before everything else.
   */
  exposedWithoutAdmin: () => boolean
  /** The peer's address, for the trusted-local guard. */
  remoteAddress: (c: Context) => string | undefined
  /**
   * Build the FULL externally-grantable catalog. It takes no scope: a handler is
   * given the scope of the CALL, so one catalog serves every key and workspace.
   * This route filters it down to what the caller was granted.
   */
  buildCatalog: () => ExternalMcpTool[]
  /**
   * Persist ONE audit row for an attempted write. Must reject (throw, or return
   * a rejecting promise) when the row did not land — the dispatcher reports the
   * gap rather than assuming coverage.
   */
  recordWriteAudit: (entry: ExternalMcpWriteAuditInput) => void | Promise<void>
  /** The clock an audit row is stamped with. Injected so a test can pin the value. */
  now?: () => number
  /** Notified after each successful authentication (records "last used"). Best-effort. */
  onAuthenticated?: (keyId: string) => void
}

/** The served route: the HTTP handler plus the revocation hook. */
export interface ServedExternalMcp {
  /** The Hono handler for the bare `/mcp` and for every `/mcp/*` form (which 404s). */
  handler: (c: Context) => Promise<Response>
  /**
   * Tear down every live MCP session belonging to a key. Called when the key is
   * revoked, so an already-open transport cannot keep serving under it.
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
  /** The pinning tuple, fixed at initialize. */
  keyId: string
  secretVersion: number
  workspaceName: string
  policyEpoch: number
  /** The scope the current in-flight request re-authorized. Never client-supplied. */
  scope: EffectiveScope
  /** The principal that presented itself on the current in-flight request. */
  principal: ExternalMcpPrincipal
}

/** Uniform rejection bodies — a caller cannot tell WHICH check failed beyond the status. */
const UNAUTHORIZED = { error: 'unauthorized' } as const
const FORBIDDEN = { error: 'forbidden' } as const
const NOT_FOUND = { error: 'not found' } as const
const BAD_WORKSPACE = {
  error: 'bad request',
  message: 'X-C3-Workspace must name exactly one workspace.',
} as const
/**
 * The refusal when c3 can be reached from the network but nobody can authorize
 * anything. It names the two ways out, because the alternative — serving the
 * trusted-local principal to whoever connects — would publish every workspace.
 */
const UNCONFIGURED = {
  error: 'unavailable',
  message:
    'External MCP is disabled: c3 is bound to a non-loopback address with no administrator. ' +
    'Configure a basic administrator, or restart c3 bound to a loopback address.',
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

/** The refusal for arguments that do not fit the tool's schema. */
function invalidArguments(detail: string): ExternalToolResult {
  return { content: [{ type: 'text', text: `invalid arguments: ${detail}` }], isError: true }
}

export function createExternalMcp(deps: ExternalMcpDeps): ServedExternalMcp {
  const sessions = new Map<string, Session>()
  /** key id → its live session ids, so revocation is a lookup rather than a scan. */
  const byKey = new Map<string, Set<string>>()
  const now = deps.now ?? (() => Date.now())
  // The catalog is scope-free, so ONE build serves every session. Built lazily
  // so constructing the route stays free of feature work.
  let builtCatalog: Map<string, ExternalMcpTool> | null = null
  const tools = (): Map<string, ExternalMcpTool> => {
    if (!builtCatalog) builtCatalog = new Map(deps.buildCatalog().map((tool) => [tool.name, tool]))
    return builtCatalog
  }

  /**
   * Record one attempted write and WAIT for it, then let the caller answer.
   *
   * Fail-open on purpose: a database that cannot take the row must not turn a
   * legitimate write into an error, because that would make the audit trail a
   * second availability dependency of the business surface. It is not silent
   * though — losing coverage is the thing an incident later depends on, so it is
   * reported with the non-secret metadata of the call that went unrecorded.
   */
  const audit = async (entry: ExternalMcpWriteAuditInput): Promise<void> => {
    try {
      await deps.recordWriteAudit(entry)
    } catch (err) {
      console.error(
        `[c3] external MCP write audit failed: key=${entry.keyId} owner=${entry.ownerSubject} ` +
          `workspace=${entry.workspaceName} tool=${entry.tool} result=${entry.result}:`,
        err instanceof Error ? err.message : String(err),
      )
    }
  }

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

  const closeSession = (session: Session): void => {
    void session.transport.close()
    void session.server.close()
  }

  /** Evict a session so an in-flight request that lost the race 404s instead. */
  const evict = (sessionId: string): void => {
    const session = sessions.get(sessionId)
    untrack(sessionId)
    if (session) closeSession(session)
  }

  /**
   * Stand up one MCP server that advertises EXACTLY this scope's granted tools.
   *
   * It serves from the shared catalog and narrows by the scope re-read from the
   * live session, so the tool map itself grants nothing — what a call may do is
   * decided in the call handler below, per call.
   *
   * The dispatch is written out rather than delegated to the SDK's high-level
   * `McpServer` for one reason: this surface must answer an un-granted call with
   * a stable *forbidden* tool error and run no handler, which a registry that
   * simply does not contain the tool cannot express.
   */
  const openSession = (scope: EffectiveScope, principal: ExternalMcpPrincipal): Session => {
    const catalog = tools()

    const server = new Server({ name: 'c3', version: '1.0.0' }, { capabilities: { tools: {} } })
    // `tools/list` is the authorization surface: an un-granted tool is not
    // advertised at all, so a well-behaved client never even offers it. It is
    // built from the SAME effective set the call gate enforces, re-read from the
    // live session so discovery and execution can never disagree.
    server.setRequestHandler(ListToolsRequestSchema, () => ({
      tools: session.scope.tools
        .map((name) => catalog.get(name))
        .filter((tool): tool is ExternalMcpTool => tool !== undefined)
        .map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: toJsonSchema(tool.inputSchema),
        })),
    }))
    server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
      const name = request.params.name
      const args = (request.params.arguments ?? {}) as Record<string, unknown>
      // The catalog answers "is this a known external tool, and is it a write?"
      // — a question about the tool, not about this key's grants. An unknown name
      // is refused exactly like an un-granted one and is NOT audited: it names no
      // capability, so there is nothing to attribute.
      const tool = catalog.get(name)
      if (!tool) return forbiddenTool(name)
      const write = tool.access === 'write'

      // A write may aim at another workspace; a read is always the pinned one.
      // The target is only a REQUEST — the gate below decides whether it is the
      // caller's to name, and nothing is substituted if it is not.
      const target =
        write && typeof args.workspaceName === 'string'
          ? args.workspaceName.trim()
          : session.workspaceName
      const stamp = (result: ExternalMcpAuditResult): ExternalMcpWriteAuditInput => ({
        occurredAt: now(),
        keyId: session.principal.keyId,
        ownerSubject: session.principal.ownerSubject,
        workspaceName: target,
        tool: name,
        result,
      })
      /** Answer, but not before the attempt has been recorded. */
      const answer = async (
        result: ExternalMcpAuditResult,
        payload: ExternalToolResult,
      ): Promise<CallToolResult> => {
        if (write) await audit(stamp(result))
        return toCallResult(payload)
      }

      // Discovery can be skipped; authorization cannot. The gate runs here — with
      // the principal, the TARGET workspace and the tool name of the CURRENT
      // call — rather than trusting the tool map or the workspace the session was
      // built from. An out-of-scope override is answered with the same wording as
      // an un-granted tool, so neither can be used to probe for existence.
      const decision = deps.authorize(session.principal, target, name)
      if (!decision.ok) return answer('rejected', forbiddenTool(name))

      // A read tool has no workspace parameter, so a caller sending one is either
      // confused or probing; either way the call is refused rather than quietly
      // executed against the pinned workspace.
      if (!write && 'workspaceName' in args) {
        return toCallResult(invalidArguments('workspaceName is not accepted by this tool'))
      }

      const parsed = z.object(tool.inputSchema).safeParse(args)
      if (!parsed.success) {
        return answer('rejected', invalidArguments(parsed.error.message))
      }
      // Every id the arguments name is checked against the AUTHORIZED workspace
      // before the business core runs: an id that belongs elsewhere buys no
      // mutation, no broadcast, no event and no launch.
      const refusal = tool.validate?.(parsed.data, decision.scope)
      if (refusal !== null && refusal !== undefined) {
        return answer('rejected', { content: [{ type: 'text', text: refusal }], isError: true })
      }
      try {
        const result = await tool.handler(parsed.data, decision.scope)
        return answer(result.isError ? 'failure' : 'success', result)
      } catch (err) {
        // A thrown handler is still a handler that ran: audited as a failure,
        // then re-thrown so the SDK reports it exactly as it did before.
        if (write) await audit(stamp('failure'))
        throw err
      }
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
      secretVersion: scope.secretVersion,
      workspaceName: scope.workspaceName,
      policyEpoch: scope.policyEpoch,
      scope,
      principal,
    }
    session.ready = server.connect(transport)
    return session
  }

  /**
   * Resolve the caller. Returns the principal, or the response that refuses it.
   *
   * A presented credential must verify — an invalid bearer never falls back to
   * the trusted-local principal, which would turn a typo into full access. That
   * covers a credential that is unreadable as much as one that is merely wrong:
   * a malformed `Authorization` header is answered 401, never treated as the
   * credential-free request it is not. The credential-free path exists only in
   * trusted-local mode AND only for a loopback peer: defence in depth behind the
   * loopback bind, for the case where something in front of c3 forwards a remote
   * request onto localhost.
   */
  const authenticate = async (
    c: Context,
  ): Promise<{ principal: ExternalMcpPrincipal } | { response: Response }> => {
    const credential = readCredential(c.req.header('authorization'))
    if (credential.kind === 'bearer') {
      const principal = await deps.authenticate(credential.token)
      if (!principal) return { response: c.json(UNAUTHORIZED, 401) }
      deps.onAuthenticated?.(principal.keyId)
      return { principal }
    }
    if (credential.kind === 'unusable') return { response: c.json(UNAUTHORIZED, 401) }
    const local = deps.trustedLocalPrincipal()
    if (!local) return { response: c.json(UNAUTHORIZED, 401) }
    if (!isLoopbackAddress(deps.remoteAddress(c))) return { response: c.json(UNAUTHORIZED, 401) }
    return { principal: local }
  }

  /** Map an authorization denial onto its response. `owner` reads as a bad credential. */
  const denied = (c: Context, result: Extract<AuthorizeResult, { ok: false }>): Response =>
    result.reason === 'owner' ? c.json(UNAUTHORIZED, 401) : c.json(FORBIDDEN, 403)

  return {
    async handler(c) {
      // 0. Exposure. Reachable from the network with nobody able to authorize
      //    anything is not a degraded mode — it is a misconfiguration, and it
      //    refuses even loopback requests so the answer does not depend on which
      //    interface a caller happened to arrive on.
      if (deps.exposedWithoutAdmin()) return c.json(UNCONFIGURED, 503)

      // 1. Address. Exactly `/mcp`. Every other form — the former `/mcp/<key>`,
      //    `/mcp/v1`, a trailing slash — is a route that does not exist.
      if (c.req.path !== EXTERNAL_MCP_PATH) return c.json(NOT_FOUND, 404)

      // 2. Credential, before any workspace resolution: an unauthenticated caller
      //    must not be able to probe which workspace names exist.
      const auth = await authenticate(c)
      if ('response' in auth) return auth.response
      const principal = auth.principal

      const header = readWorkspaceHeader(c.req.header(WORKSPACE_HEADER))
      const sessionId = c.req.header(SESSION_HEADER)

      if (sessionId) {
        const existing = sessions.get(sessionId)
        // An unknown session id gets the transport-level 404 the MCP spec
        // prescribes; we answer it ourselves because no transport owns it.
        if (!existing) return c.json(NOT_FOUND, 404)
        // Another key on the same session is answered exactly like an unknown
        // session: the response reveals nothing about who the id belongs to, and
        // one key cannot destroy another key's transport by guessing an id.
        if (existing.keyId !== principal.keyId) return c.json(NOT_FOUND, 404)
        // Clients send their configured headers on EVERY request, so the header
        // repeating the pinned workspace is normal. A DIFFERENT one is a re-scope
        // attempt: refused, and the session is left alone — the request changed,
        // not its authority.
        if (header.ok && header.name !== existing.workspaceName) return c.json(FORBIDDEN, 403)

        // Re-authorize from scratch. Storage is authoritative the moment it is
        // written, so nothing about the previous decision is reused.
        const decision = deps.authorize(principal, existing.workspaceName, null)
        if (!decision.ok) {
          evict(sessionId)
          return denied(c, decision)
        }
        // The authority the session was pinned to is gone: a rotated secret or a
        // policy change. Evicting here is the backstop for a teardown that failed
        // or raced; 404 tells the client to initialize again rather than retry.
        if (
          decision.scope.secretVersion !== existing.secretVersion ||
          decision.scope.policyEpoch !== existing.policyEpoch
        ) {
          evict(sessionId)
          return c.json(NOT_FOUND, 404)
        }
        existing.scope = decision.scope
        existing.principal = principal
        await existing.ready
        return existing.transport.handleRequest(c.req.raw)
      }

      // 3. No session id: this must be an `initialize`, and initialize is the one
      //    moment the workspace is chosen. There is no default and no "most
      //    recent" guess — an absent header is an error, not an invitation.
      if (!header.ok) return c.json(BAD_WORKSPACE, 400)
      const decision = deps.authorize(principal, header.name, null)
      if (!decision.ok) return denied(c, decision)

      // Stand one up, let the transport decide, and discard it again if the
      // request turned out not to be an initialize (otherwise every stray POST
      // would leak a server).
      const session = openSession(decision.scope, principal)
      await session.ready
      const response = await session.transport.handleRequest(c.req.raw)
      if (!session.transport.sessionId) closeSession(session)
      return response
    },

    closeSessionsForKey(keyId) {
      const ids = byKey.get(keyId)
      if (!ids) return
      for (const id of [...ids]) evict(id)
    },

    sessionCount: () => sessions.size,
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
