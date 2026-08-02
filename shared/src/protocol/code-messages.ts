/**
 * Code browsing wire messages.
 *
 * Each type is one arm of `ClientToServer` / `ServerToClient`; the unions are
 * assembled in `../protocol.ts`, which is their only definition site. These arm
 * types are internal to the partition and are NOT part of the public
 * `@ccc/shared/protocol` surface.
 */

import type {
  CodeDirEntry,
  CodeFileRead,
  CodeGitStatus,
  CodeSearchHit,
  CodeSearchMode,
} from './code.js'

/** List one workspace-relative directory. Server replies with `dir_listed`. */
export type ClientListDir = { type: 'list_dir'; workspaceId: string; rel: string }

/** Read one workspace-relative file. Server replies with `file_read`. */
export type ClientReadFile = { type: 'read_file'; workspaceId: string; rel: string }

/**
 * Request the workspace's read-only Git-status snapshot (decorates the file
 * tree). Carries only `workspaceId` — never a client path. Server replies with
 * `code_git_status`; a non-git or unreadable workspace degrades to an empty map.
 */
export type ClientGetCodeGitStatus = { type: 'get_code_git_status'; workspaceId: string }

/**
 * Search code by filename or content. Server replies with `codes_searched`.
 * `mode: 'filename'` matches `query` as a case-insensitive substring of each
 * entry's *basename* (not its relative path) — hyphens and the extension are
 * not match boundaries, so `sandbox` hits `sandbox-architecture.md` — and the
 * hit's `match` is the full basename. `pattern` is an optional glob filter on
 * file *basenames* (e.g. `*.ts`, `*.ts,*.tsx`); `*`/empty/absent ⇒ all files.
 * It scopes which files are matched/searched in both modes — directories are
 * always traversed regardless.
 */
export type ClientSearchCodes = {
  type: 'search_codes'
  workspaceId: string
  query: string
  mode: CodeSearchMode
  pattern?: string
}

/** Directory listing for one workspace-relative path. */
export type ServerDirListed = {
  type: 'dir_listed'
  workspaceId: string
  rel: string
  entries: CodeDirEntry[]
}

/** File metadata and optional text content for one workspace-relative path. */
export type ServerFileRead = { type: 'file_read'; workspaceId: string; file: CodeFileRead }

/**
 * Authoritative workspace Git-status snapshot: `files` maps every changed
 * workspace-relative file path to its `CodeGitStatus`. The client replaces its
 * prior snapshot wholesale (so cleared paths drop their markers) and aggregates
 * ancestor directories for the folder rollup. Empty ⇒ clean / non-git / error.
 */
export type ServerCodeGitStatus = {
  type: 'code_git_status'
  workspaceId: string
  files: Record<string, CodeGitStatus>
}

/** Bounded code search result set. */
export type ServerCodesSearched = {
  type: 'codes_searched'
  workspaceId: string
  query: string
  mode: CodeSearchMode
  hits: CodeSearchHit[]
  truncated: boolean
  timedOut: boolean
}
