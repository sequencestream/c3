/**
 * Code browsing wire messages.
 *
 * Each type is one arm of `ClientToServer` / `ServerToClient`; the unions are
 * assembled in `../protocol.ts`, which is their only definition site. These arm
 * types are internal to the partition and are NOT part of the public
 * `@ccc/shared/protocol` surface.
 */

import type { FileEntry, FileRead, FileGitStatus, FileSearchHit, FileSearchMode } from './file.js'

/** List one workspace-relative directory. Server replies with `dir_listed`. */
export type ClientListDir = { type: 'list_dir'; workspaceName: string; rel: string }

/** Read one workspace-relative file. Server replies with `file_read`. */
export type ClientReadFile = { type: 'read_file'; workspaceName: string; rel: string }

/**
 * Request the workspace's read-only Git-status snapshot (decorates the file
 * tree). Carries only `workspaceName` — never a client path. Server replies with
 * `file_git_status`; a non-git or unreadable workspace degrades to an empty map.
 */
export type ClientGetFileGitStatus = { type: 'get_file_git_status'; workspaceName: string }

/**
 * Search code by filename or content. Server replies with `files_searched`.
 * `mode: 'filename'` matches `query` as a case-insensitive substring of each
 * entry's *basename* (not its relative path) — hyphens and the extension are
 * not match boundaries, so `sandbox` hits `sandbox-architecture.md` — and the
 * hit's `match` is the full basename. `pattern` is an optional glob filter on
 * file *basenames* (e.g. `*.ts`, `*.ts,*.tsx`); `*`/empty/absent ⇒ all files.
 * It scopes which files are matched/searched in both modes — directories are
 * always traversed regardless.
 */
export type ClientSearchFiles = {
  type: 'search_files'
  workspaceName: string
  query: string
  mode: FileSearchMode
  pattern?: string
}

/** Directory listing for one workspace-relative path. */
export type ServerDirListed = {
  type: 'dir_listed'
  workspaceName: string
  rel: string
  entries: FileEntry[]
}

/** File metadata and optional text content for one workspace-relative path. */
export type ServerFileRead = { type: 'file_read'; workspaceName: string; file: FileRead }

/**
 * Authoritative workspace Git-status snapshot: `files` maps every changed
 * workspace-relative file path to its `FileGitStatus`. The client replaces its
 * prior snapshot wholesale (so cleared paths drop their markers) and aggregates
 * ancestor directories for the folder rollup. Empty ⇒ clean / non-git / error.
 */
export type ServerFileGitStatus = {
  type: 'file_git_status'
  workspaceName: string
  files: Record<string, FileGitStatus>
}

/** Bounded code search result set. */
export type ServerFilesSearched = {
  type: 'files_searched'
  workspaceName: string
  query: string
  mode: FileSearchMode
  hits: FileSearchHit[]
  truncated: boolean
  timedOut: boolean
}
