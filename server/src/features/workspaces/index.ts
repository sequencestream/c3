/**
 * `workspaces` feature handlers — slice 1/3 (ADR-0009).
 */
import { resolve } from 'node:path'
import { addWorkspace, removeWorkspace } from '../../state.js'
import { getRuntime, removeRuntimesForWorkspace } from '../../runs.js'
import { isStoreAvailable as isScheduleStoreAvailable } from '../schedules/store.js'
import { onWorkspaceRemoved } from '../schedules/archiver.js'
import { requireAdmin } from '../auth/authz.js'
import type { Handler } from '../../transport/handler-registry.js'

export const addWorkspaceHandler: Handler<'add_workspace'> = async (_ctx, conn, msg) => {
  // `add_workspace` is the ONLY entry where an absolute path legitimately enters
  // the system — it establishes a new trust root. Gate it behind an authenticated
  // session (defense-in-depth: the dispatch gate already refuses non-exempt
  // frames when auth is enabled, but this explicit check documents the contract).
  if (!conn.authed) {
    conn.send({ type: 'unauthenticated', reason: 'missing' })
    return
  }
  // Creating a trust root is an admin-only action (WS-R*; ADR-0023 authz). Inert
  // when no admin gate applies (auth disabled / unconfigured) — loopback trust.
  if (!requireAdmin(conn)) return
  const abs = addWorkspace(msg.path, Date.now())
  if (!abs) {
    conn.send({
      type: 'error',
      error: { code: 'path.notDirectory', params: { path: msg.path } },
    })
    return
  }
  conn.sendWorkspaces()
  await conn.sendSessions(abs)
}

export const removeWorkspaceHandler: Handler<'remove_workspace'> = (ctx, conn, msg) => {
  // Removing a workspace tears down a trust root — same gates as add.
  if (!conn.authed) {
    conn.send({ type: 'unauthenticated', reason: 'missing' })
    return
  }
  // Tearing down a trust root is admin-only too (WS-R*; ADR-0023 authz).
  if (!requireAdmin(conn)) return
  const abs = resolve(msg.path)
  // Tear down any background runs under this workspace.
  removeRuntimesForWorkspace(abs)
  // Pause all schedules under this workspace (SCH-R1).
  if (isScheduleStoreAvailable()) {
    onWorkspaceRemoved(abs)
  }
  removeWorkspace(abs)
  if (conn.viewing && getRuntime(conn.viewing) === undefined) conn.viewing = null
  conn.sendWorkspaces()
  ctx.broadcastStatuses()
}
