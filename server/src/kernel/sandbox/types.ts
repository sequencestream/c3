/**
 * Sandbox — Kernel Boundary Types
 *
 * Core type definitions for the sandbox subsystem. These are pure types (zero
 * runtime cost) that define the contract between the config layer, the path
 * resolver, and the arapuca wrapper generator.
 *
 * Backend: arapuca process-level isolation — the vendor CLI runs as a host
 * process (current host user, host original paths) with directory read/write
 * narrowed by a kernel MAC (Linux Landlock / macOS Seatbelt / Windows
 * AppContainer). No container / image / bind mount / rootfs. Same-path
 * principle: a host `/abs/path` is the same `/abs/path` the process sees — the
 * sandbox only tags paths ro/rw.
 *
 * Layer: kernel/sandbox (inner domain)
 *
 * @module
 */

import type { SessionKind } from '@ccc/shared/protocol'

// ─── Configuration Types ─────────────────────────────────────────────────────

/**
 * A supplementary allowed directory (same-path passthrough).
 *
 * Kernel copy of the protocol {@link import('@ccc/shared/protocol').SandboxExtraMount}.
 * Kept in sync by the `_AssertEqual` pin in SandboxConfig.ts.
 */
export interface SandboxExtraMount {
  /** Host absolute path, exposed at the same path inside the sandbox. */
  readonly path: string
  /** Read-only when true or absent; false grants read-write. */
  readonly readonly?: boolean
}

/**
 * Workspace-level sandbox config (arapuca process-level isolation).
 *
 * IMPORTANT: Keep in sync with shared/src/protocol.ts WorkspaceSandboxConfig.
 * The Zod schema and _AssertEqual pin in SandboxConfig.ts enforce this.
 */
export interface WorkspaceSandboxConfig {
  /** Master switch — sandboxing is off by default (absent or false ⇔ disabled). */
  readonly enabled?: boolean
  /** Supplementary allowed directories (same-path). Read-only by default per item. */
  readonly extraMounts?: readonly SandboxExtraMount[]
  /** Session kinds that run inside the sandbox when enabled. Absent ⇒ `['work']`. */
  readonly sandboxSessionKinds?: readonly SessionKind[]
  /**
   * Retention window (days) for the persistent sandbox CODEX_HOME rollouts. The
   * daily janitor prunes rollout files older than this. Absent ⇒ 30 days.
   */
  readonly sessionRetentionDays?: number
}

// ─── Resolved Path Model ─────────────────────────────────────────────────────

/**
 * A single canonicalized allowed mount, mapped to an arapuca `-v <path>:ro|rw`
 * flag. `readonly` is explicit here (deny-by-default is expressed by the mount
 * simply not being present, not by a separate flag).
 */
export interface ResolvedMount {
  /** Canonicalized host absolute path (same path inside the sandbox). */
  readonly path: string
  /** Whether this mount is read-only (true) or read-write (false). */
  readonly readonly: boolean
}

/**
 * The fully resolved, canonicalized, validated set of allowed paths for a run.
 *
 * Produced by `resolvePaths()`. The fixed allowances are always present; the
 * supplementary allowances come from {@link WorkspaceSandboxConfig.extraMounts}
 * after canonicalize + allowlist/denylist + reserved-path overlap checks.
 */
export interface ResolvedSandboxPaths {
  /**
   * The run's actual code execution directory — the sole read-write code path.
   * An isolated worktree for a worktree run; the source workspace for a
   * current-branch run or any selected run without an isolated cwd.
   */
  readonly executionRoot: string
  /**
   * Source workspace root — read-only baseline code. Absent when it is the same
   * canonical path as {@link executionRoot} (a current-branch run): the two
   * collapse into the single read-write {@link executionRoot} grant so arapuca
   * never receives a conflicting ro/rw pair for one path.
   */
  readonly workspaceRoot?: string
  /** Centralized specs root — read-write, same host absolute path. */
  readonly specsBase: string
  /**
   * Persistent per-workspace sandbox CODEX_HOME — read-write, same host absolute
   * path. Outlives the per-run temp dir so codex thread rollouts survive for the
   * next turn's `resume` (see `getSandboxCodexHome`). Mounted + exported as
   * `CODEX_HOME` only for a codex run.
   */
  readonly codexHome: string
  /**
   * The claude config dir a sandbox claude run uses (`CLAUDE_CONFIG_DIR`) —
   * read-write, same host absolute path. Unlike codex this is the HOST claude
   * config dir (`getSandboxClaudeConfigDir`), so the transcript the sandbox writes
   * is read back host-side through the claude SDK unchanged. Mounted + exported as
   * `CLAUDE_CONFIG_DIR` only for a claude run.
   */
  readonly claudeConfigDir: string
  /** Supplementary allowed directories, each ro/rw as declared. */
  readonly extra: readonly ResolvedMount[]
  /**
   * Absolute path of the arapuca binary this launch selected — the c3-managed
   * install when available, otherwise the host-PATH hit. The wrapper `exec`s
   * THIS path rather than resolving `arapuca` from the runtime PATH again, so
   * the binary the probe verified is provably the one that runs.
   */
  readonly arapucaBin: string
}

// ─── Probe Types ─────────────────────────────────────────────────────────────

/**
 * Where a resolved arapuca binary came from. `managed` is the c3-downloaded,
 * checksum-verified install under `~/.c3/sandbox/arapuca/`; `host-path` is the
 * user's own binary found on PATH (the fallback while — or because — the
 * managed install is unavailable).
 */
export type ArapucaSource = 'managed' | 'host-path'

/**
 * Result of probing for arapuca availability + platform capability.
 *
 * On failure carries a {@link uiCode} the UI turns into a localized message
 * (no hardcoded English). A failed probe hard-fails a sandbox-enabled run —
 * never a silent host fallback.
 */
export type ArapucaProbeResult =
  | { readonly ok: true; readonly path: string; readonly source: ArapucaSource }
  | { readonly ok: false; readonly uiCode: SandboxUiCode }

/** Structured error codes for sandbox launch failures (UI localizes these). */
export type SandboxUiCode =
  | 'arapuca-missing'
  | 'platform-unsupported'
  | 'nested-sandbox-unsupported'
  | 'path-illegal'
  | 'launch-failed'
