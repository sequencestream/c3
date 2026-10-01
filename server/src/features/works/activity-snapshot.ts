/**
 * Activity snapshot for one connection. Authorization uses the same workspace
 * list as the handshake, so a client cannot see summaries for workspaces it
 * cannot list.
 */
import type { ServerToClient } from '@ccc/shared/protocol'
import { activitySnapshotForVisible, badgeProjection } from '../../kernel/activity/index.js'
import { listWorkspacesForSubject, resolveAuthSubject } from '../auth/authorization.js'
import type { Conn, Handler } from '../../transport/handler-registry.js'

export function visibleWorkspaceNamesForConn(conn: Conn): string[] {
  return listWorkspacesForSubject(resolveAuthSubject(conn.subject)).map(
    (workspace) => workspace.name,
  )
}

export function buildActivitySnapshot(
  conn: Conn,
): Extract<ServerToClient, { type: 'activity_snapshot' }> {
  return {
    type: 'activity_snapshot',
    ...activitySnapshotForVisible(badgeProjection, visibleWorkspaceNamesForConn(conn)),
  }
}

export const requestActivitySnapshot: Handler<'request_activity_snapshot'> = (_ctx, conn) => {
  conn.send(buildActivitySnapshot(conn))
  console.log('[c3:activity] snapshot reason=client_request')
}
