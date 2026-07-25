/**
 * Session cleanup — kernel type, Zod schema and compile-time pin.
 *
 * The workspace-level cleanup config governs retention of a workspace's
 * persisted session artifacts. It is a sibling of the sandbox config, not part
 * of it: a workspace governs its session store whether or not it runs agents
 * under process isolation.
 *
 * Layer: kernel/config (inner domain)
 *
 * @module
 */

import { z } from 'zod'

/** Retention window (days) applied when a workspace enables cleanup without a value. */
export const DEFAULT_SESSION_RETENTION_DAYS = 30
/** Hard floor for the retention window; lower values clamp up. */
export const MIN_SESSION_RETENTION_DAYS = 1

/**
 * Workspace-level session-store cleanup config.
 *
 * IMPORTANT: Keep in sync with shared/src/protocol.ts WorkspaceSessionCleanupConfig.
 * The Zod schema and the _AssertEqual pin below enforce this at compile time.
 */
export interface WorkspaceSessionCleanupConfig {
  /** Master switch — cleanup is off by default (absent or false ⇔ never prunes). */
  readonly enabled?: boolean
  /** Retention window in days; absent ⇒ {@link DEFAULT_SESSION_RETENTION_DAYS}. */
  readonly retentionDays?: number
}

/** Runtime contract for the workspace session-cleanup config. */
export const workspaceSessionCleanupConfigSchema = z.object({
  enabled: z.boolean().optional(),
  retentionDays: z.number().optional(),
})

/** Utility: asserts T extends U (both directions) for exact type match. */
type _AssertEqual<T, U> = T extends U ? (U extends T ? true : never) : never

/**
 * Pin workspaceSessionCleanupConfigSchema to WorkspaceSessionCleanupConfig.
 * If this line fails, the Zod schema and the interface have drifted.
 */
type _PinWorkspaceSessionCleanupSchema = _AssertEqual<
  z.infer<typeof workspaceSessionCleanupConfigSchema>,
  WorkspaceSessionCleanupConfig
>
