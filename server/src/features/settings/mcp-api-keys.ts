/**
 * `settings` feature handlers for the external-MCP API keys — the admin-facing
 * half of the credential the public `/mcp/<api-key>` route authenticates with.
 *
 * These are WORKSPACE-scoped operations even though the records live in the
 * global settings file: a key is bound to exactly one workspace, so the roster a
 * caller may ask for is that workspace's, and a create always binds the workspace
 * that was named — never a set, never a wildcard.
 *
 * Mutations sit behind the administrator gate: minting a key hands out access to
 * a workspace's ledger, and ticking a write tool hands out the ability to change
 * it. Listing is NOT gated — the roster carries no secret (names, prefixes,
 * timestamps, tool scope), and hiding it from non-administrators would only make
 * the feature look absent rather than restricted.
 *
 * Two translations happen here and nowhere else:
 *  - the workspace: the console addresses it by opaque id (it must never
 *    construct a path), the store binds by canonical absolute path (that is what
 *    an incoming request resolves against). An id that does not resolve is
 *    REJECTED, so an administrator is never told a key was bound to something it
 *    was not.
 *  - the plaintext key: it exists in exactly one reply and is then unrecoverable.
 *
 * Revocation AND re-scoping reach further than storage: an already-open MCP
 * session must die too, so the composition root registers
 * {@link setExternalMcpSessionCloser} and both paths call it. Without that a
 * client that handshook before the change would keep serving under the old
 * authorization.
 */
import type { McpApiKeyMeta } from '@ccc/shared/protocol'
import { EXTERNAL_MCP_READ_TOOLS } from '@ccc/shared/protocol'
import {
  createMcpApiKey,
  listMcpApiKeysForWorkspace,
  renameMcpApiKey,
  revokeMcpApiKey,
  updateMcpApiKeyTools,
  type McpApiKeyInfo,
} from '../../kernel/config/mcp-api-keys.js'
import {
  canonicalPathToWorkspaceId,
  resolveRegisteredWorkspacePath,
  workspaceIdToCanonicalPath,
} from '../external-mcp/workspace-scope.js'
import { externalMcpToolDescriptors, normalizeExternalMcpToolScope } from '../external-mcp/tools.js'
import type { Conn, Handler } from '../../transport/handler-registry.js'
import { requireAdmin } from '../auth/authz.js'

/**
 * Composition-root sink that tears down a key's live MCP sessions. Null until the
 * server wires it (unit tests and embedders never stand up the route), in which
 * case storage-level enforcement still applies on the next request.
 */
let closeExternalSessions: ((keyId: string) => void) | null = null

/** Register the live-session teardown used when a key is revoked or re-scoped. */
export function setExternalMcpSessionCloser(hook: ((keyId: string) => void) | null): void {
  closeExternalSessions = hook
}

/** Project the store's path-bound record onto the id-addressed wire shape. */
function toMeta(info: McpApiKeyInfo): McpApiKeyMeta {
  const workspaceId = canonicalPathToWorkspaceId(info.workspace)
  return {
    id: info.id,
    name: info.name,
    createdAt: info.createdAt,
    lastUsedAt: info.lastUsedAt,
    // `null` ⇒ the bound workspace is no longer registered. The path itself stays
    // server-side: the console needs to know the key is unusable, not where the
    // host keeps its directories.
    workspaceId,
    // Registered but directory gone (or deregistered entirely): the key reaches
    // nothing. The console marks it unavailable and offers only revocation.
    unavailable: resolveRegisteredWorkspacePath(info.workspace) === null,
    tools: [...info.tools],
    displayPrefix: info.displayPrefix,
  }
}

/** The roster reply for ONE workspace; `created` rides along only on a successful mint. */
function roster(
  workspaceId: string,
  canonicalPath: string,
  created?: { meta: McpApiKeyMeta; key: string },
): {
  type: 'mcp_api_keys'
  workspaceId: string
  keys: McpApiKeyMeta[]
  catalog: ReturnType<typeof externalMcpToolDescriptors>
  created?: { meta: McpApiKeyMeta; key: string }
} {
  return {
    type: 'mcp_api_keys',
    workspaceId,
    keys: listMcpApiKeysForWorkspace(canonicalPath).map(toMeta),
    catalog: externalMcpToolDescriptors(),
    ...(created ? { created } : {}),
  }
}

/**
 * Resolve the id-addressed workspace to its canonical path, refusing the request
 * when it does not resolve. There is no fallback: a key that cannot name its one
 * workspace has no address to be reached at.
 */
function resolveWorkspace(conn: Conn, workspaceId: string): string | null {
  const path = workspaceIdToCanonicalPath(workspaceId)
  if (!path) {
    conn.send({
      type: 'error',
      error: { code: 'mcpApiKey.unknownWorkspace', params: { workspaceId } },
    })
    return null
  }
  return path
}

function reportFailure(conn: Conn, err: unknown): void {
  console.error('[c3] external MCP key operation failed:', err)
  conn.send({ type: 'error', error: { code: 'mcpApiKey.saveFailed' } })
}

export const listMcpApiKeysHandler: Handler<'list_mcp_api_keys'> = (_ctx, conn, msg) => {
  const path = resolveWorkspace(conn, msg.workspaceId)
  if (!path) return
  conn.send(roster(msg.workspaceId, path))
}

export const createMcpApiKeyHandler: Handler<'create_mcp_api_key'> = async (_ctx, conn, msg) => {
  if (!requireAdmin(conn)) return
  const path = resolveWorkspace(conn, msg.workspaceId)
  if (!path) return
  try {
    // The initial scope is server-decided: the complete read-only set and not one
    // write tool, whatever the client proposed. A write grant is only ever the
    // result of an explicit, separately confirmed edit.
    const { meta, key } = await createMcpApiKey(
      msg.name,
      path,
      [...EXTERNAL_MCP_READ_TOOLS],
      Date.now(),
    )
    // The one and only appearance of the plaintext. Nothing logs it.
    conn.send(roster(msg.workspaceId, path, { meta: toMeta(meta), key }))
  } catch (err) {
    reportFailure(conn, err)
  }
}

export const updateMcpApiKeyHandler: Handler<'update_mcp_api_key'> = (_ctx, conn, msg) => {
  if (!requireAdmin(conn)) return
  const path = resolveWorkspace(conn, msg.workspaceId)
  if (!path) return
  try {
    if (msg.name !== undefined && renameMcpApiKey(msg.id, msg.name) === null) {
      conn.send({ type: 'error', error: { code: 'mcpApiKey.unknown', params: { id: msg.id } } })
      return
    }
    if (msg.tools !== undefined) {
      // All-or-nothing: an unknown or repeated name aborts before anything is
      // written, so the saved scope is always exactly the submitted one.
      const normalized = normalizeExternalMcpToolScope(msg.tools)
      if (!normalized.ok) {
        conn.send({
          type: 'error',
          error: { code: 'mcpApiKey.unknownTool', params: { tool: normalized.offender } },
        })
        return
      }
      if (updateMcpApiKeyTools(msg.id, normalized.tools) === null) {
        conn.send({ type: 'error', error: { code: 'mcpApiKey.unknown', params: { id: msg.id } } })
        return
      }
      // Storage is authoritative from here on. Only then are live transports cut,
      // so a teardown that fails cannot restore the previous privileges — the next
      // request is refused either way.
      closeExternalSessions?.(msg.id)
    }
    conn.send(roster(msg.workspaceId, path))
  } catch (err) {
    reportFailure(conn, err)
  }
}

export const revokeMcpApiKeyHandler: Handler<'revoke_mcp_api_key'> = (_ctx, conn, msg) => {
  if (!requireAdmin(conn)) return
  const path = resolveWorkspace(conn, msg.workspaceId)
  if (!path) return
  try {
    if (!revokeMcpApiKey(msg.id)) {
      conn.send({ type: 'error', error: { code: 'mcpApiKey.unknown', params: { id: msg.id } } })
      return
    }
    // Storage is authoritative for the NEXT request; this kills the sessions that
    // are already open so the revoke is immediate in both directions.
    closeExternalSessions?.(msg.id)
    conn.send(roster(msg.workspaceId, path))
  } catch (err) {
    reportFailure(conn, err)
  }
}
