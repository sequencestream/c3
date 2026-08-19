/**
 * The console's read-and-remove surface over workspace memory.
 *
 * Two handlers, no new semantics: the listing is `listActiveMemories` narrowed to
 * a summary, and the delete IS the agent's own `memory_write { op: 'delete' }`
 * soft delete. This exists because the user's only other way to correct a wrong
 * memory was to ask the agent that wrote it — which is exactly the party they
 * cannot rely on when the memory is wrong.
 *
 * Both handlers resolve the workspace through the same registry every other
 * feature uses, so a connection can only reach a workspace it can already name.
 * The listing hands back `title` / `type` / `status` / `updatedAt` and NOT
 * `content`: the settings page is not a reader for memory prose, and shipping the
 * body there would be the first half of an edit form nobody asked for.
 */
import type { WorkspaceMemoryListItem } from '@ccc/shared/protocol'
import type { UiError } from '@ccc/shared/ui-codes'
import type { Handler } from '../../transport/handler-registry.js'
import { resolveWorkspaceRoot } from '../../state.js'
import {
  MemoryStoreError,
  deleteMemory,
  listActiveMemories,
  type WorkspaceMemory,
} from './store.js'

/** Reply `workspace.unknown` for a name this connection cannot resolve. */
function rejectUnknownWorkspace(conn: Parameters<Handler>[1], workspaceName: string): boolean {
  if (resolveWorkspaceRoot(workspaceName)) return false
  conn.send({
    type: 'error',
    error: { code: 'workspace.unknown', params: { path: workspaceName } },
  })
  return true
}

/** Narrow a stored memory to what the listing shows — never the body. */
function toListItem(m: WorkspaceMemory): WorkspaceMemoryListItem {
  return { id: m.id, title: m.title, type: m.type, status: m.status, updatedAt: m.updatedAt }
}

/**
 * Translate a store refusal into a UI error. Every branch means the row is
 * untouched, so the page keeps showing it rather than reporting a delete that
 * did not happen.
 */
function toUiError(err: unknown): UiError {
  if (err instanceof MemoryStoreError) {
    if (err.code === 'not_found') return { code: 'memory.notFound' }
    if (err.code === 'db_unavailable') return { code: 'memory.unavailable' }
  }
  return { code: 'memory.deleteFailed', params: { detail: String(err) } }
}

/**
 * Every active memory in one workspace, newest first. An unavailable database
 * returns an empty list — the store's read contract degrades to empty instead of
 * throwing, and inventing an error here would claim a distinction the store
 * cannot make.
 */
export const listWorkspaceMemoriesHandler: Handler<'list_workspace_memories'> = (
  _ctx,
  conn,
  msg,
) => {
  if (rejectUnknownWorkspace(conn, msg.workspaceName)) return
  conn.send({
    type: 'workspace_memories',
    workspaceName: msg.workspaceName,
    items: listActiveMemories(msg.workspaceName).map(toListItem),
  })
}

/**
 * Soft-delete one memory. The reply carries the title the store actually removed,
 * read back from the row — so the confirmation names the memory that is gone even
 * if the page was showing a stale one.
 */
export const deleteWorkspaceMemoryHandler: Handler<'delete_workspace_memory'> = (
  _ctx,
  conn,
  msg,
) => {
  if (rejectUnknownWorkspace(conn, msg.workspaceName)) return
  try {
    const removed = deleteMemory(msg.workspaceName, msg.id)
    conn.send({
      type: 'workspace_memory_deleted',
      workspaceName: msg.workspaceName,
      id: removed.id,
      title: removed.title,
    })
  } catch (err) {
    console.error('[c3:memory] 删除工作区记忆失败:', err)
    conn.send({ type: 'error', error: toUiError(err) })
  }
}
