/**
 * Workspace memory contracts.
 *
 * Part of the `@ccc/shared/protocol` contract; re-exported by `../protocol.ts`.
 *
 * The domain's authority stays the work session's MCP tools — this partition
 * exists so a human can SEE and REMOVE a memory without asking the agent that
 * wrote it. It therefore carries a summary shape and a delete, and deliberately
 * no create/edit: a second write path would be a second, silently diverging
 * semantics for the same table.
 */

/**
 * The four kinds of statement a memory may be, in the order a listing groups
 * them. Single source of truth for both the store's SQL check constraint and the
 * console's grouping, so the wire and the table cannot drift apart.
 */
export const MEMORY_TYPES = ['preference', 'constraint', 'fact', 'lesson'] as const
export type MemoryType = (typeof MEMORY_TYPES)[number]

/**
 * Lifecycle state. `active` is the only state normal search — and this
 * partition's listing — returns; the other two are a recovery and cleanup
 * concern, not model context.
 */
export const MEMORY_STATUSES = ['active', 'superseded', 'deleted'] as const
export type MemoryStatus = (typeof MEMORY_STATUSES)[number]

/**
 * One row of the workspace-setting memory listing.
 *
 * A SUMMARY, not the memory: `content`, `subject` and `sourceSessionId` are
 * absent on purpose. The page answers "what is remembered here, and let me drop
 * this one" — reading a memory's prose back is the agent's job through
 * `memory_search`, and putting the body on a settings page would invite editing
 * it there.
 */
export interface WorkspaceMemoryListItem {
  /** The memory's id; the only handle the delete request carries. */
  id: string
  /** The one-line title, verbatim as saved (it is also the memory's identity). */
  title: string
  type: MemoryType
  /**
   * Always `active` while the listing is scoped to active rows. Carried anyway so
   * the wire shape matches the domain model and a later widening of the scope
   * needs no new column.
   */
  status: MemoryStatus
  /** Last write or status change, epoch ms. The listing is ordered by it, newest first. */
  updatedAt: number
}
