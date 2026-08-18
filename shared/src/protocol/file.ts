/**
 * Code browsing: directory listing, file read, git status and search.
 *
 * Part of the `@ccc/shared/protocol` contract; re-exported by `../protocol.ts`.
 */

export type FileEntryType = 'file' | 'directory'

/**
 * A single file's working-tree Git state, as composable flags (not a mutually
 * exclusive enum): `MM`/`AM` are both `staged` and `modified` at once. `untracked`
 * never combines with the other two. Absent ⇒ no Git state (clean, non-git
 * workspace, or older directory data). Derived read-only from `git status
 * --porcelain`; deletions, renames, copies and conflicts never produce one.
 */
export interface FileGitStatus {
  /** Working-tree column is `M` (unstaged edit). */
  modified: boolean
  /** `??` — a new, untracked path. */
  untracked: boolean
  /** Index column is `A` or `M` (change staged in the index). */
  staged: boolean
}

export interface FileEntry {
  name: string
  path: string
  type: FileEntryType
  /**
   * Optional Git state for this entry. Populated client-side by merging the
   * workspace Git-status snapshot (`file_git_status`); absent ⇒ no state. Kept
   * optional so `dir_listed` and non-git workspaces need not carry it.
   */
  gitStatus?: FileGitStatus
}

export interface FileRead {
  path: string
  size: number
  binary: boolean
  truncated: boolean
  content?: string
}

export type FileSearchMode = 'filename' | 'content'

export interface FileSearchHit {
  path: string
  type: FileEntryType
  line?: number
  lineText?: string
  match?: string
}
