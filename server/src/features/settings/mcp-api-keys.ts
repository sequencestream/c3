/**
 * `settings` feature handlers for the external-MCP API keys — the admin-facing
 * half of the credential `POST /mcp` authenticates with.
 *
 * The operations are addressed by workspace because that is where a key is
 * ADMINISTERED: one settings tab lists the keys filed under it. That page context
 * confers nothing. What a key can reach is its owner's administrator-managed
 * workspace scope, resolved per request; a key created on workspace A's tab is
 * not thereby allowed into workspace A.
 *
 * Mutations sit behind the administrator gate: minting a key hands out the
 * owner's access, and ticking a write tool hands out the ability to change what
 * it reaches. Listing is NOT gated — the roster carries no secret (names,
 * prefixes, timestamps, tool scope), and hiding it from non-administrators would
 * only make the feature look absent rather than restricted.
 *
 * Two things are decided here and nowhere else:
 *  - the owner: the connection's VERIFIED subject, never a client-stated one and
 *    never the page. A blank resolution refuses the create rather than storing a
 *    record the authorization gate cannot evaluate.
 *  - the plaintext key: it exists in exactly one reply and is then unrecoverable.
 *
 * Revocation reaches further than storage: an already-open MCP session must die
 * too, so the composition root registers {@link setExternalMcpSessionCloser} and
 * the revoke path calls it. A tool-scope change needs no such call — it advances
 * the policy epoch, which every live session is re-checked against on its next
 * request — but the closer still runs so the transport goes away immediately
 * rather than at the next poll.
 */
import type { McpApiKeyMeta } from '@ccc/shared/protocol'
import { EXTERNAL_MCP_DEFAULT_TOOLS } from '@ccc/shared/protocol'
import {
  createMcpApiKey,
  listMcpApiKeysForWorkspace,
  revokeMcpApiKeyInWorkspace,
  updateMcpApiKeyInWorkspace,
  type McpApiKeyInfo,
} from '../../kernel/config/mcp-api-keys.js'
import { resolveWorkspaceRoot } from '../../state.js'
import { externalMcpToolDescriptors, normalizeExternalMcpToolScope } from '../external-mcp/tools.js'
import type { Conn, Handler } from '../../transport/handler-registry.js'
import { requireAdmin } from '../auth/authz.js'
import { isValidOwner, resolveAuthSubject } from '../auth/authorization.js'

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

/** Project the stored record onto the wire shape. Never carries hash material. */
function toMeta(info: McpApiKeyInfo): McpApiKeyMeta {
  return {
    id: info.id,
    name: info.name,
    createdAt: info.createdAt,
    lastUsedAt: info.lastUsedAt,
    // The settings page that administers this key, not a grant.
    workspaceName: info.workspaceName,
    // A key whose owner is no longer a principal this deployment recognizes
    // reaches nothing at all — an account that was removed, or a `local` owner
    // after basic auth was configured. The console marks it unavailable and
    // offers only revocation; how much its owner may reach is a separate,
    // per-request question the console does not answer.
    unavailable: !isValidOwner(info.ownerSubject),
    tools: [...info.tools],
    displayPrefix: info.displayPrefix,
  }
}

/** The roster reply for ONE workspace; `created` rides along only on a successful mint. */
function roster(
  workspaceName: string,
  created?: { meta: McpApiKeyMeta; key: string },
): {
  type: 'mcp_api_keys'
  workspaceName: string
  keys: McpApiKeyMeta[]
  catalog: ReturnType<typeof externalMcpToolDescriptors>
  created?: { meta: McpApiKeyMeta; key: string }
} {
  return {
    type: 'mcp_api_keys',
    workspaceName,
    keys: listMcpApiKeysForWorkspace(workspaceName).map(toMeta),
    catalog: externalMcpToolDescriptors(),
    ...(created ? { created } : {}),
  }
}

/**
 * Check that the addressed workspace exists before answering for it. A page that
 * does not resolve has no roster; the request is refused rather than answered
 * with another workspace's keys.
 */
function resolveWorkspace(conn: Conn, workspaceName: string): string | null {
  if (!resolveWorkspaceRoot(workspaceName)) {
    conn.send({
      type: 'error',
      error: { code: 'mcpApiKey.unknownWorkspace', params: { workspaceName } },
    })
    return null
  }
  return workspaceName
}

function reportFailure(conn: Conn, err: unknown): void {
  console.error('[c3] external MCP key operation failed:', err)
  conn.send({ type: 'error', error: { code: 'mcpApiKey.saveFailed' } })
}

export const listMcpApiKeysHandler: Handler<'list_mcp_api_keys'> = (_ctx, conn, msg) => {
  const workspaceName = resolveWorkspace(conn, msg.workspaceName)
  if (!workspaceName) return
  conn.send(roster(msg.workspaceName))
}

export const createMcpApiKeyHandler: Handler<'create_mcp_api_key'> = async (_ctx, conn, msg) => {
  if (!requireAdmin(conn)) return
  const workspaceName = resolveWorkspace(conn, msg.workspaceName)
  if (!workspaceName) return
  // The owner is the VERIFIED requesting identity, never the page it was created
  // from: a workspace settings tab is where a key is administered, not evidence
  // that its holder may reach that workspace. Under basic auth this is the
  // administrator who passed the gate above; with no accounts it is the
  // synthesized `local` principal. It is never blank.
  const ownerSubject = resolveAuthSubject(conn.subject)
  if (!ownerSubject) {
    conn.send({ type: 'error', error: { code: 'auth.adminOnly' } })
    return
  }
  try {
    // The initial scope is server-decided: the default set and not one write
    // tool, whatever the client proposed. That default is deliberately NARROWER
    // than the read-graded catalog — a grantable read tool still has to be ticked.
    // Any grant beyond it is only ever the result of an explicit, confirmed edit.
    const { meta, key } = await createMcpApiKey(
      msg.name,
      msg.workspaceName,
      ownerSubject,
      [...EXTERNAL_MCP_DEFAULT_TOOLS],
      Date.now(),
    )
    // The one and only appearance of the plaintext. Nothing logs it.
    conn.send(roster(msg.workspaceName, { meta: toMeta(meta), key }))
  } catch (err) {
    reportFailure(conn, err)
  }
}

export const updateMcpApiKeyHandler: Handler<'update_mcp_api_key'> = (_ctx, conn, msg) => {
  if (!requireAdmin(conn)) return
  const workspaceName = resolveWorkspace(conn, msg.workspaceName)
  if (!workspaceName) return
  try {
    let normalizedTools: string[] | undefined
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
      normalizedTools = normalized.tools
    }

    const patch: { name?: string; tools?: string[] } = {}
    if (msg.name !== undefined) patch.name = msg.name
    if (normalizedTools !== undefined) patch.tools = normalizedTools

    if (Object.keys(patch).length > 0) {
      if (updateMcpApiKeyInWorkspace(msg.id, msg.workspaceName, patch) === null) {
        conn.send({ type: 'error', error: { code: 'mcpApiKey.unknown', params: { id: msg.id } } })
        return
      }
      if (normalizedTools !== undefined) {
        // Storage is authoritative from here on. Only then are live transports cut,
        // so a teardown that fails cannot restore the previous privileges — the next
        // request is refused either way.
        closeExternalSessions?.(msg.id)
      }
    }
    conn.send(roster(msg.workspaceName))
  } catch (err) {
    reportFailure(conn, err)
  }
}

export const revokeMcpApiKeyHandler: Handler<'revoke_mcp_api_key'> = (_ctx, conn, msg) => {
  if (!requireAdmin(conn)) return
  const workspaceName = resolveWorkspace(conn, msg.workspaceName)
  if (!workspaceName) return
  try {
    if (!revokeMcpApiKeyInWorkspace(msg.id, msg.workspaceName)) {
      conn.send({ type: 'error', error: { code: 'mcpApiKey.unknown', params: { id: msg.id } } })
      return
    }
    // Storage is authoritative for the NEXT request; this kills the sessions that
    // are already open so the revoke is immediate in both directions.
    closeExternalSessions?.(msg.id)
    conn.send(roster(msg.workspaceName))
  } catch (err) {
    reportFailure(conn, err)
  }
}
