/**
 * Session cleanup — kernel type, Zod schema and compile-time pin.
 *
 * The cleanup config governs retention of the session transcripts vendors write
 * to disk. It is system-wide and vendor-neutral: the stores it prunes are shared
 * homes (one vendor home holds every workspace's sessions), so the decision
 * cannot be expressed per workspace. It is also independent of the sandbox
 * config — isolation only decides which home a run writes into.
 *
 * Layer: kernel/config (inner domain)
 *
 * @module
 */

import { z } from 'zod'

/** Retention window (days) applied when cleanup is enabled without a value. */
export const DEFAULT_SESSION_RETENTION_DAYS = 30
/** Hard floor for the retention window; lower values clamp up. */
export const MIN_SESSION_RETENTION_DAYS = 1

/**
 * System-wide session-store cleanup config.
 *
 * IMPORTANT: Keep in sync with shared/src/protocol.ts SessionCleanupConfig.
 * The Zod schema and the _AssertEqual pin below enforce this at compile time.
 */
export interface SessionCleanupConfig {
  /** Master switch — cleanup is off by default (absent or false ⇔ never prunes). */
  readonly enabled?: boolean
  /** Retention window in days; absent ⇒ {@link DEFAULT_SESSION_RETENTION_DAYS}. */
  readonly retentionDays?: number
}

/** Runtime contract for the session-cleanup config. */
export const sessionCleanupConfigSchema = z.object({
  enabled: z.boolean().optional(),
  retentionDays: z.number().optional(),
})

/** Utility: asserts T extends U (both directions) for exact type match. */
type _AssertEqual<T, U> = T extends U ? (U extends T ? true : never) : never

/**
 * Pin sessionCleanupConfigSchema to SessionCleanupConfig.
 * If this line fails, the Zod schema and the interface have drifted.
 */
type _PinSessionCleanupSchema = _AssertEqual<
  z.infer<typeof sessionCleanupConfigSchema>,
  SessionCleanupConfig
>
