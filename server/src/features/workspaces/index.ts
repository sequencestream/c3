/**
 * `workspaces` feature handlers — slice 1/3 (ADR-0009).
 */
import { resolve } from 'node:path'
import { addWorkspace, removeWorkspace } from '../../state.js'
import { getRuntime, removeRuntimesForWorkspace } from '../../runs.js'
import { isStoreAvailable as isScheduleStoreAvailable } from '../schedules/store.js'
import { onWorkspaceRemoved } from '../schedules/archiver.js'
import type { Handler } from '../../transport/handler-registry.js'

export const addWorkspaceHandler: Handler<'add_workspace'> = async (_ctx, conn, msg) => {
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
