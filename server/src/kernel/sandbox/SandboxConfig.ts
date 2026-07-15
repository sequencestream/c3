/**
 * SandboxConfig — Zod Schema and Compile-Time Pins
 *
 * The workspace-level sandbox config (arapuca process-level isolation) is the
 * only persisted sandbox shape. There is no longer a system-level "template"
 * def nor a merge step: the fixed allowances (workspace root ro, worktree rw,
 * specsBase rw) are derived at resolve time from the run, and `extraMounts`
 * carries the only user-configurable allowances.
 *
 * Layer: kernel/sandbox (inner domain)
 *
 * @module
 */

import { z } from 'zod'
import type { WorkspaceSandboxConfig } from './types.js'
import { SESSION_KINDS } from '@ccc/shared/protocol'

// ─── Zod Schemas ─────────────────────────────────────────────────────────────

/**
 * Zod schema for a supplementary allowed directory.
 * `path` must be a non-empty string (absolute-path / canonicalize checks are a
 * runtime concern in `resolvePaths()`, not a schema concern).
 */
export const sandboxExtraMountSchema = z.object({
  path: z.string().min(1, 'extraMount path is required'),
  readonly: z.boolean().optional(),
})

/**
 * Zod schema for workspace-level sandbox config.
 *
 * IMPORTANT: Keep in sync with shared/src/protocol.ts WorkspaceSandboxConfig.
 * The _AssertEqual pin below enforces this at compile time.
 */
export const workspaceSandboxConfigSchema = z.object({
  enabled: z.boolean().optional(),
  extraMounts: z.array(sandboxExtraMountSchema).optional(),
  sandboxSessionKinds: z.array(z.enum(SESSION_KINDS)).optional(),
})

// ─── Compile-Time Type Pins ──────────────────────────────────────────────────

/**
 * Utility: asserts T extends U (both directions) for exact type match.
 */
type _AssertEqual<T, U> = T extends U ? (U extends T ? true : never) : never

/**
 * Pin workspaceSandboxConfigSchema to WorkspaceSandboxConfig.
 * If this line fails, the Zod schema and the interface have drifted.
 */
type _PinWorkspaceConfigSchema = _AssertEqual<
  z.infer<typeof workspaceSandboxConfigSchema>,
  WorkspaceSandboxConfig
>
