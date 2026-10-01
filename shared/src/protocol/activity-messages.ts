/**
 * Activity badge snapshot / delta wire messages.
 *
 * Each type is one arm of `ClientToServer` / `ServerToClient`; the unions are
 * assembled in `../protocol.ts`. These arm types are internal to the partition
 * and are NOT part of the public `@ccc/shared/protocol` surface.
 */

import type { WorkspaceActivitySummary } from './activity.js'

/** Ask the server for a full activity snapshot of every visible workspace. */
export type ClientRequestActivitySnapshot = { type: 'request_activity_snapshot' }

/**
 * Authoritative activity summaries for every workspace this connection may see.
 * Replaces the client's map. Sent after `ready`, and whenever the client asks
 * or detects a revision gap.
 */
export type ServerActivitySnapshot = {
  type: 'activity_snapshot'
  revision: number
  workspaces: Record<string, WorkspaceActivitySummary>
}

/**
 * Incremental activity update. `changedWorkspaces` carries complete summaries
 * for affected workspaces, not field-level +1/−1. `removedWorkspaces` drops
 * deleted (or no-longer-visible) workspace keys from the client map.
 */
export type ServerActivityDelta = {
  type: 'activity_delta'
  revision: number
  changedWorkspaces: Record<string, WorkspaceActivitySummary>
  removedWorkspaces?: string[]
}
