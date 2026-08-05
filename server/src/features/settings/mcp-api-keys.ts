/**
 * `settings` feature handlers for the external-MCP API keys — the admin-facing
 * half of the credential the public `/mcp/v1` route authenticates with.
 *
 * All four operations sit behind the SAME administrator gate as the rest of
 * system configuration: minting a key hands out read access to a workspace's
 * intent ledger and discussions, and even the roster (names, authorization sets,
 * last-used times) is an inventory of who can reach what.
 *
 * Two translations happen here and nowhere else:
 *  - workspaces: the console addresses them by opaque id (it must never construct
 *    a path), the store authorizes by canonical absolute path (that is what an
 *    incoming request is matched against). An id that does not resolve is
 *    REJECTED rather than dropped, so an administrator is never told a grant
 *    succeeded when part of it silently vanished.
 *  - the plaintext key: it exists in exactly one reply and is then unrecoverable.
 *
 * Revocation reaches further than storage: an already-open MCP session must die
 * too, so the composition root registers {@link setExternalMcpRevocationHook} and
 * the delete path calls it. Without that a client that handshook before the
 * revoke would keep serving from a live transport.
 */
import type { McpApiKeyMeta } from '@ccc/shared/protocol'
import {
  createMcpApiKey,
  listMcpApiKeys,
  renameMcpApiKey,
  revokeMcpApiKey,
  updateMcpApiKeyWorkspaces,
  type McpApiKeyInfo,
} from '../../kernel/config/mcp-api-keys.js'
import {
  canonicalPathToWorkspaceId,
  workspaceIdToCanonicalPath,
} from '../external-mcp/workspace-scope.js'
import type { Conn, Handler } from '../../transport/handler-registry.js'
import { requireAdmin } from '../auth/authz.js'

/**
 * Composition-root sink that tears down a revoked key's live MCP sessions. Null
 * until the server wires it (unit tests and embedders never stand up the route),
 * in which case storage-level revocation still applies on the next request.
 */
let closeExternalSessions: ((keyId: string) => void) | null = null

/** Register the live-session teardown used when a key is revoked. */
export function setExternalMcpRevocationHook(hook: ((keyId: string) => void) | null): void {
  closeExternalSessions = hook
}

/** Project the store's path-addressed record onto the id-addressed wire shape. */
function toMeta(info: McpApiKeyInfo): McpApiKeyMeta {
  const workspaceIds: string[] = []
  const staleWorkspaces: string[] = []
  for (const path of info.workspaces) {
    const id = canonicalPathToWorkspaceId(path)
    if (id) workspaceIds.push(id)
    else staleWorkspaces.push(path)
  }
  return {
    id: info.id,
    name: info.name,
    createdAt: info.createdAt,
    lastUsedAt: info.lastUsedAt,
    workspaceIds,
    staleWorkspaces,
    displayPrefix: info.displayPrefix,
  }
}

/** The full roster reply; `created` rides along only on a successful mint. */
function roster(created?: { meta: McpApiKeyMeta; key: string }): {
  type: 'mcp_api_keys'
  keys: McpApiKeyMeta[]
  created?: { meta: McpApiKeyMeta; key: string }
} {
  return {
    type: 'mcp_api_keys',
    keys: listMcpApiKeys().map(toMeta),
    ...(created ? { created } : {}),
  }
}

/**
 * Resolve id-addressed workspaces to canonical paths, refusing the whole request
 * on the first unknown id. All-or-nothing on purpose: a partially applied grant
 * is worse than a rejected one, because the administrator would believe the
 * missing workspace was covered.
 */
function resolveWorkspaceIds(conn: Conn, ids: readonly string[]): string[] | null {
  const paths: string[] = []
  for (const id of ids) {
    const path = workspaceIdToCanonicalPath(id)
    if (!path) {
      conn.send({
        type: 'error',
        error: { code: 'mcpApiKey.unknownWorkspace', params: { workspaceId: id } },
      })
      return null
    }
    paths.push(path)
  }
  return paths
}

function reportFailure(conn: Conn, err: unknown): void {
  console.error('[c3] external MCP key operation failed:', err)
  conn.send({ type: 'error', error: { code: 'mcpApiKey.saveFailed' } })
}

export const listMcpApiKeysHandler: Handler<'list_mcp_api_keys'> = (_ctx, conn) => {
  if (!requireAdmin(conn)) return
  conn.send(roster())
}

export const createMcpApiKeyHandler: Handler<'create_mcp_api_key'> = async (_ctx, conn, msg) => {
  if (!requireAdmin(conn)) return
  // A key with no workspace could never do anything; refuse it rather than store
  // an inert credential the administrator would have to debug later.
  if (msg.workspaceIds.length === 0) {
    conn.send({ type: 'error', error: { code: 'mcpApiKey.noWorkspace' } })
    return
  }
  const paths = resolveWorkspaceIds(conn, msg.workspaceIds)
  if (!paths) return
  try {
    const { meta, key } = await createMcpApiKey(msg.name, paths, Date.now())
    // The one and only appearance of the plaintext. Nothing logs it.
    conn.send(roster({ meta: toMeta(meta), key }))
  } catch (err) {
    reportFailure(conn, err)
  }
}

export const updateMcpApiKeyHandler: Handler<'update_mcp_api_key'> = (_ctx, conn, msg) => {
  if (!requireAdmin(conn)) return
  try {
    if (msg.name !== undefined && renameMcpApiKey(msg.id, msg.name) === null) {
      conn.send({ type: 'error', error: { code: 'mcpApiKey.unknown', params: { id: msg.id } } })
      return
    }
    if (msg.workspaceIds !== undefined) {
      // An explicitly empty set is a legitimate "this key reaches nothing"; only
      // an unresolvable id aborts.
      const paths = resolveWorkspaceIds(conn, msg.workspaceIds)
      if (!paths) return
      if (updateMcpApiKeyWorkspaces(msg.id, paths) === null) {
        conn.send({ type: 'error', error: { code: 'mcpApiKey.unknown', params: { id: msg.id } } })
        return
      }
    }
    conn.send(roster())
  } catch (err) {
    reportFailure(conn, err)
  }
}

export const revokeMcpApiKeyHandler: Handler<'revoke_mcp_api_key'> = (_ctx, conn, msg) => {
  if (!requireAdmin(conn)) return
  try {
    if (!revokeMcpApiKey(msg.id)) {
      conn.send({ type: 'error', error: { code: 'mcpApiKey.unknown', params: { id: msg.id } } })
      return
    }
    // Storage is authoritative for the NEXT request; this kills the sessions that
    // are already open so the revoke is immediate in both directions.
    closeExternalSessions?.(msg.id)
    conn.send(roster())
  } catch (err) {
    reportFailure(conn, err)
  }
}
