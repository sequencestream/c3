# codes — Design

Implements the [spec](spec.md). The server feature lives under `server/src/features/codes/` and
uses the shared WebSocket protocol as its only API.

## Data Model

| Model         | Shape                                                                                   | Notes                                                          |
| ------------- | --------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `CodeDirItem` | `name`, `path`, `type`                                                                  | `path` is workspace-relative; `type` is `file` or `directory`. |
| `CodeFile`    | `path`, `size`, `binary`, optional `content`                                            | `content` is present only for text files under the size limit. |
| `CodeHit`     | `path`, optional `line`, optional `lineText`, optional `match`, `truncated` information | Content hits include line context; filename hits do not.       |

## API Design

All requests carry `workspaceId`, never a root path.

| Request        | Response         | Behavior                                                                                                                                    |
| -------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `list_dir`     | `dir_listed`     | Lists one directory's immediate children, excluding `.git`.                                                                                 |
| `read_file`    | `file_read`      | Reads metadata and, when safe, text content for one file.                                                                                   |
| `search_codes` | `codes_searched` | Searches by filename or text content with a result limit and timeout. An optional `pattern` glob filters which file basenames are searched. |

Failures use the existing `error` wire message. Path and workspace rejection errors are safe to
display and must not echo absolute filesystem paths.

## Path Guard

The guard is applied before every filesystem operation and again to every path returned from a
filesystem walk:

1. Resolve `workspaceId` through the server registry. Unknown ids are rejected.
2. Resolve the registered workspace path to its real filesystem root.
3. Reject requested paths containing null bytes, absolute paths, or `..` segments.
4. Resolve the candidate under the real root and realpath the target.
5. Accept only the real root itself or paths with the real root plus path separator as prefix.

This prevents symlink escape and sibling-prefix confusion (`/workspace` versus
`/workspace-evil`). `.git` is excluded before descent and before response emission.

## Limits

- File content limit: 1 MiB. Larger files return metadata only.
- Binary detection: a null byte in the inspected prefix marks the file as binary.
- Search result limit: 100 hits per request.
- Search runtime limit: 1500 ms per request.
- Content search reads only files that pass the same read eligibility rules.
- Glob filter: `pattern` is compiled to case-insensitive basename matchers (`*` → any run, `?` → one
  char); comma/space-separated globs union. `*`/empty disables the filter. Directories are always
  traversed regardless of the filter; only file basenames are tested against it.

## Non-Functional Considerations

- **Security:** The guard implements [SEC-11](../../../non-functional/security.md). The accepted
  `.env` risk is documented in CODE-R8.
- **Performance:** Directory walking is lazy for `list_dir`; content search is bounded by both
  result count and elapsed time.
- **Availability:** Errors are per-request and do not affect agent sessions or other workspace
  operations.

## Dependencies

- `server/src/state.ts` for workspace id resolution.
- Node filesystem APIs for read-only inspection.
- Shared protocol types in `shared/src/protocol.ts`.
