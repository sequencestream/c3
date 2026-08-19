/**
 * Workspace memory wire messages — the console's read-and-remove surface.
 *
 * Each type is one arm of `ClientToServer` / `ServerToClient`; the unions are
 * assembled in `../protocol.ts`, which is their only definition site. These arm
 * types are internal to the partition and are NOT part of the public
 * `@ccc/shared/protocol` surface.
 *
 * There is no create and no update here. Memories are written by an agent in a
 * work session through the MCP tools; the console only looks and deletes, which
 * is exactly the authority a user needs when the agent itself is the thing that
 * misbehaved.
 */

import type { WorkspaceMemoryListItem } from './memory.js'

/** List one workspace's active memories (reply: `workspace_memories`). */
export type ClientListWorkspaceMemories = {
  type: 'list_workspace_memories'
  workspaceName: string
}

/**
 * The summary listing for one workspace, newest first. `items` is empty both when
 * the workspace remembers nothing and when the database is unavailable — the
 * store's read contract degrades to empty rather than throwing, and this reply
 * does not invent a distinction the store cannot make.
 */
export type ServerWorkspaceMemories = {
  type: 'workspace_memories'
  workspaceName: string
  items: WorkspaceMemoryListItem[]
}

/**
 * Soft-delete one memory in the named workspace. Same semantics as the agent's
 * `memory_write { op: 'delete' }` — the row becomes `deleted` and waits out the
 * janitor's recovery window; nothing is erased here.
 */
export type ClientDeleteWorkspaceMemory = {
  type: 'delete_workspace_memory'
  workspaceName: string
  id: string
}

/**
 * A confirmed soft-delete. `title` is what the server actually removed (read back
 * from the row, not echoed from the request), so the toast names the memory that
 * is gone instead of the one the page happened to be showing.
 */
export type ServerWorkspaceMemoryDeleted = {
  type: 'workspace_memory_deleted'
  workspaceName: string
  id: string
  title: string
}
