/**
 * Centralized SDD spec root — pure, deterministic path resolution.
 *
 * Specs are NOT stored under the workspace (which would give every git worktree
 * its own `.specs` copy and bury them inside each checkout). They live under the
 * c3 home at `<c3-home>/specs/<project-path-segment>/…`, mirroring the worktree
 * "project-isolated under c3 home" paradigm (see `worktree.ts`). The segment is
 * derived from the project's normalized absolute workspace path via the SAME
 * encoder as worktrees (`projectDirName`), so:
 *
 * - the same workspace path always resolves to the same spec root (deterministic,
 *   idempotent);
 * - different workspace paths resolve to different spec roots (modulo the
 *   explicit path-collision non-goal);
 * - the spec root is keyed on the OWNING workspace path (resolved via the
 *   workspace registry), never the effective cwd / worktree path — so every
 *   worktree of one project shares the SAME spec set (REQ-2).
 *
 * The spec root is fixed and never user-configurable (REQ-3): there is no
 * relative `specPath` setting any more.
 */
import path from 'node:path'
import { getSpecsBase as getKernelSpecsBase } from '../../kernel/config/workspace-path.js'

/**
 * The fixed, centralized spec root for a workspace:
 * `<c3-home>/specs/<project-path-segment>`. `workspacePath` MUST be the owning
 * (registry-resolved) workspace path, not a worktree path, so all worktrees of
 * one project resolve to the same root.
 */
export function getSpecsBase(workspacePath: string): string {
  return getKernelSpecsBase(workspacePath)
}

/**
 * Resolve an intent's stored `specPath` to an absolute path. New specs store an
 * absolute path under the centralized root; this is robust to a stored relative
 * value (treated as relative to the workspace) but the centralized read/write
 * guards confine to {@link getSpecsBase}, so legacy in-workspace `.specs` are
 * not recognized (Out-of-Scope: no migration).
 */
export function resolveSpecFileAbs(workspacePath: string, specPath: string): string {
  return path.isAbsolute(specPath) ? specPath : path.join(workspacePath, specPath)
}
