/**
 * `settings` feature handlers for the external-MCP API keys — the credential
 * `POST /mcp` authenticates with.
 *
 * TWO surfaces over one store, split by who the authority is:
 *
 *  - SELF-SERVICE (`*_my_mcp_api_key`) — an account's own keys. No administrator
 *    gate: a key is an owned capability, so its holder is its authority, and an
 *    administrator gets no view of, and no power over, anyone else's. Every
 *    operation resolves its owner from the verified connection and matches on it
 *    inside the store operation.
 *  - WORKSPACE-ADDRESSED (the four legacy operations) — the historical page that
 *    administered keys FILED under one workspace. Kept wire-compatible; no
 *    first-party page calls it, and a self-service key is filed nowhere and so
 *    can never appear in or be mutated through it.
 *
 * Filing confers nothing either way. What a key can reach is its owner's
 * administrator-managed workspace scope, resolved per request; a key created on
 * workspace A's tab was never thereby allowed into workspace A.
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
  listMcpApiKeysForOwner,
  listMcpApiKeysForWorkspace,
  replaceMcpApiKeySecretForOwner,
  revokeMcpApiKeyForOwner,
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

// ---------------------------------------------------------------------------
// Self-service: an account manages its OWN keys.
//
// No administrator gate anywhere below, and that is the point: a key is an owned
// credential, so its holder is the authority over it and being administrator
// confers nothing over someone else's. The owner is resolved from the VERIFIED
// connection on every single operation and is never a message field, so there is
// no parameter a caller could aim at another account.
//
// An unknown key id and a key belonging to someone else produce the SAME
// not-found result and mutate nothing, so ids cannot be swept to learn which ones
// exist or who holds them.
// ---------------------------------------------------------------------------

/** The requesting connection's owner identity, or `null` when it has none. */
function resolveOwner(conn: Conn): string | null {
  const owner = resolveAuthSubject(conn.subject)
  if (!owner) {
    conn.send({ type: 'error', error: { code: 'mcpApiKey.noIdentity' } })
    return null
  }
  return owner
}

/**
 * ONE owner's roster. Deliberately carries no `catalog`: self-service has no
 * tool-scope editor, so shipping the grantable catalog would only suggest one.
 */
function ownerRoster(
  ownerSubject: string,
  created?: { meta: McpApiKeyMeta; key: string },
): {
  type: 'my_mcp_api_keys'
  keys: McpApiKeyMeta[]
  created?: { meta: McpApiKeyMeta; key: string }
} {
  return {
    type: 'my_mcp_api_keys',
    keys: listMcpApiKeysForOwner(ownerSubject).map(toMeta),
    ...(created ? { created } : {}),
  }
}

/** The refusal an unknown id and a foreign id share. It is never told apart. */
function notMyKey(conn: Conn, id: string): void {
  conn.send({ type: 'error', error: { code: 'mcpApiKey.unknown', params: { id } } })
}

export const listMyMcpApiKeysHandler: Handler<'list_my_mcp_api_keys'> = (_ctx, conn) => {
  const owner = resolveOwner(conn)
  if (!owner) return
  conn.send(ownerRoster(owner))
}

export const createMyMcpApiKeyHandler: Handler<'create_my_mcp_api_key'> = async (
  _ctx,
  conn,
  msg,
) => {
  const owner = resolveOwner(conn)
  if (!owner) return
  try {
    // Filed under NO workspace: this is an account-level credential labelled by
    // device or client, not a grant on the page it was created from. The initial
    // scope is the server's default set, exactly as on the administered path.
    const { meta, key } = await createMcpApiKey(
      msg.name,
      null,
      owner,
      [...EXTERNAL_MCP_DEFAULT_TOOLS],
      Date.now(),
    )
    // The one and only appearance of the plaintext. Nothing logs it.
    conn.send(ownerRoster(owner, { meta: toMeta(meta), key }))
  } catch (err) {
    reportFailure(conn, err)
  }
}

export const resetMyMcpApiKeyHandler: Handler<'reset_my_mcp_api_key'> = async (_ctx, conn, msg) => {
  const owner = resolveOwner(conn)
  if (!owner) return
  try {
    // Persist first: the new hash and the incremented version are on disk before
    // anything is torn down, so a close that fails cannot resurrect the old secret.
    const rotated = await replaceMcpApiKeySecretForOwner(msg.id, owner)
    if (!rotated) {
      notMyKey(conn, msg.id)
      return
    }
    // Then close what is already open. There is no grace period: sessions pinned
    // to the previous version would be rejected on their next request anyway, and
    // this makes the reset immediate in both directions.
    closeExternalSessions?.(msg.id)
    conn.send(ownerRoster(owner, { meta: toMeta(rotated.meta), key: rotated.key }))
  } catch (err) {
    reportFailure(conn, err)
  }
}

export const revokeMyMcpApiKeyHandler: Handler<'revoke_my_mcp_api_key'> = (_ctx, conn, msg) => {
  const owner = resolveOwner(conn)
  if (!owner) return
  try {
    if (!revokeMcpApiKeyForOwner(msg.id, owner)) {
      notMyKey(conn, msg.id)
      return
    }
    closeExternalSessions?.(msg.id)
    conn.send(ownerRoster(owner))
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
