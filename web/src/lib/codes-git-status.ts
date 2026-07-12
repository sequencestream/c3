/*
 * codes-git-status.ts — pure helpers for decorating the Codes file tree with the
 * workspace Git-status snapshot (`code_git_status`).
 *
 * The snapshot is a flat `path → CodeGitStatus` map of CHANGED files only. Files
 * match by exact path; directories show a rollup indicator when any descendant
 * changed. The rollup is computed from the snapshot's file paths (not the loaded
 * tree), so a collapsed / never-loaded directory still reveals descendant changes.
 */
import type { CodeGitStatus } from '@ccc/shared/protocol'

/** Ordered kinds for a stable, deterministic marker sequence on a file row. */
export type GitStatusKind = 'staged' | 'modified' | 'untracked'

/** Fixed display order for composed flags (`staged + modified` shows both). */
export const GIT_STATUS_ORDER: GitStatusKind[] = ['staged', 'modified', 'untracked']

/** The active flags of a status, in fixed order. Empty when all flags are false. */
export function gitStatusKinds(status: CodeGitStatus | undefined): GitStatusKind[] {
  if (!status) return []
  return GIT_STATUS_ORDER.filter((kind) => status[kind])
}

/**
 * Every ancestor directory path (workspace-relative, `/`-separated) that contains
 * at least one changed file in the snapshot. A directory node shows its rollup
 * indicator when its `path` is in this set.
 *
 * Ancestors are built from each file path's own `/` segments — never string
 * `startsWith` — so similar prefixes do NOT cross-talk (a change under `src-old`
 * marks `src-old`, never `src`). The root (`''`) is intentionally excluded: the
 * tree renders root entries directly, with no root node to decorate.
 */
export function computeGitDirtyDirs(files: Record<string, CodeGitStatus>): Set<string> {
  const dirs = new Set<string>()
  for (const path of Object.keys(files)) {
    const segments = path.split('/')
    let prefix = ''
    // Every segment except the last (the file basename) is an ancestor directory.
    for (let i = 0; i < segments.length - 1; i++) {
      prefix = prefix ? `${prefix}/${segments[i]}` : segments[i]
      dirs.add(prefix)
    }
  }
  return dirs
}
