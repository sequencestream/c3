/**
 * Per-connection activity snapshot / delta push.
 *
 * Frames are filtered to the workspaces THIS connection may see. The same
 * projection revision is sent to every live connection so clients can detect
 * gaps; unauthorized workspace names never appear on the wire.
 */
import type { ServerToClient } from '@ccc/shared/protocol'
import {
  activityDeltaForVisible,
  activitySnapshotForVisible,
  badgeProjection,
  type BadgeProjectionDelta,
} from '../kernel/activity/index.js'
import { visibleWorkspaceNamesForConn } from '../features/works/activity-snapshot.js'
import type { Conn } from '../transport/handler-registry.js'

export type VisibleWorkspaceNames = (conn: Conn) => string[]

export interface ActivityPush {
  add: (conn: Conn) => void
  remove: (conn: Conn) => void
  sendSnapshot: (conn: Conn) => void
  broadcast: (delta: BadgeProjectionDelta) => void
}

export function createActivityPush(
  visibleNames: VisibleWorkspaceNames = visibleWorkspaceNamesForConn,
): ActivityPush {
  const live = new Set<Conn>()
  const state = new WeakMap<Conn, { revision: number; names: Set<string> }>()

  const sendSnapshot = (conn: Conn): void => {
    const frame: Extract<ServerToClient, { type: 'activity_snapshot' }> = {
      type: 'activity_snapshot',
      ...activitySnapshotForVisible(badgeProjection, visibleNames(conn)),
    }
    conn.send(frame)
    state.set(conn, {
      revision: frame.revision,
      names: new Set(Object.keys(frame.workspaces)),
    })
    console.log(
      '[c3:activity] snapshot revision=%d workspaces=%d',
      frame.revision,
      Object.keys(frame.workspaces).length,
    )
  }

  return {
    add: (conn) => {
      live.add(conn)
    },
    remove: (conn) => {
      live.delete(conn)
    },
    sendSnapshot,
    broadcast: (delta) => {
      console.log(
        '[c3:activity] delta revision=%d changed=%s removed=%s',
        delta.revision,
        Object.keys(delta.changedWorkspaces).join(',') || '-',
        delta.removedWorkspaces.join(',') || '-',
      )
      for (const conn of live) {
        const prev = state.get(conn)
        if (!prev) {
          sendSnapshot(conn)
          continue
        }
        const visible = new Set(visibleNames(conn))
        const filtered = activityDeltaForVisible(delta, visible, prev.names)
        const frame: Extract<ServerToClient, { type: 'activity_delta' }> = {
          type: 'activity_delta',
          revision: delta.revision,
          changedWorkspaces: filtered.changedWorkspaces,
        }
        if (filtered.removedWorkspaces.length > 0) {
          frame.removedWorkspaces = filtered.removedWorkspaces
        }
        conn.send(frame)
        const names = new Set(prev.names)
        for (const name of filtered.removedWorkspaces) names.delete(name)
        for (const name of Object.keys(filtered.changedWorkspaces)) names.add(name)
        state.set(conn, { revision: delta.revision, names })
      }
    },
  }
}

export function registerActivityPush(push: ActivityPush): () => void {
  return badgeProjection.subscribe((delta) => push.broadcast(delta))
}
