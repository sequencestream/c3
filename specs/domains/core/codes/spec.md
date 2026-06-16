# codes — Domain Spec

## Overview

The codes domain lets the browser inspect the current workspace's source tree without granting
write access. It exists so a panel can browse files, read text, and search code while preserving
the constitution's deny-by-default boundary around filesystem roots.

**Scope:** read-only directory listing, text-file reading, and filename/content search within one
registered workspace. **Boundary:** it does not edit files, compute diffs, blame history, follow
symbols, or access files outside the selected workspace.

## Core entities

| Entity        | Description                                                   | Key attributes                              |
| ------------- | ------------------------------------------------------------- | ------------------------------------------- |
| WorkspaceRoot | The registered workspace directory that bounds all code reads | server-issued workspace id, resolved root   |
| CodePath      | A workspace-relative path requested by the browser            | normalized relative path, file or directory |
| CodeResult    | A read-only observation returned to the browser               | entry metadata, text content, search hit    |

## Business Rules

| ID      | Rule                                                                                                                                                                                                                                                                                                                        |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CODE-R1 | All codes requests are read-only. The domain must never create, edit, delete, rename, chmod, or otherwise mutate workspace files.                                                                                                                                                                                           |
| CODE-R2 | The trust root is server-owned: a request identifies a registered workspace by its opaque id. A forged or unregistered id is rejected and must never be treated as a filesystem path.                                                                                                                                       |
| CODE-R3 | All requested paths are workspace-relative. Absolute paths, parent traversal, null bytes, and any resolved path outside the registered root are rejected. Symlink targets are judged by their resolved target, not by the link's text.                                                                                      |
| CODE-R4 | `.git` is excluded from directory listings, file reads, and search results.                                                                                                                                                                                                                                                 |
| CODE-R5 | Reading a text file returns content and metadata. Binary files and files over the configured size limit return metadata only, never content.                                                                                                                                                                                |
| CODE-R6 | Search returns bounded results only. Filename and content searches must enforce both a result limit and a runtime limit so a large workspace cannot monopolize the server.                                                                                                                                                  |
| CODE-R7 | Paths returned by list/search are always relative to the workspace root and must themselves satisfy the same root guard.                                                                                                                                                                                                    |
| CODE-R8 | Accepted risk: within an allowed workspace, non-`.git` sensitive files such as `.env` are readable by the local user. c3 relies on localhost-only operation, authenticated workspace registration, and the workspace owner viewing their own files; the codes domain does not implement secret scanning or per-file policy. |

## States & Transitions

Codes requests are stateless. Each request resolves a workspace root, validates the relative path,
performs a bounded read/list/search, returns a result or error, and retains no per-request state.

## Domain Events

Consumes `list_dir`, `read_file`, and `search_codes` WebSocket messages. Emits `dir_listed`,
`file_read`, `codes_searched`, or `error`. See the
[shared protocol](../../../shared/api-conventions/websocket-protocol.md).

## Interactions

- **session-registry** supplies the registered workspace id to root mapping.
- **web-console** sends relative-path browse/search requests and renders results.
- **non-functional/security** owns the cross-domain path-traversal and trust-root invariants.

## Non-Goals

- No editing or write operations.
- No cross-workspace browsing in a single request.
- No git diff, blame, history, or status.
- No symbol indexing or jump-to-definition.
- No special secret filtering beyond the explicit `.git` exclusion.

## Anti-Scenarios

- A client-supplied absolute path such as `~/.ssh` is accepted as a workspace root.
- A relative path such as `../../etc/passwd` reads outside the workspace.
- A symlink inside the workspace exposes a target outside the workspace.
- A sibling such as `/workspace-evil` passes by prefix-confusing `/workspace`.
- `.git` appears in any list, read, or search result.

## Data Dictionary

- **Workspace-relative path** — a path interpreted under one registered workspace root; never an
  absolute filesystem path.
- **Registered workspace** — a workspace previously accepted by session-registry and identified on
  the wire by opaque id.
