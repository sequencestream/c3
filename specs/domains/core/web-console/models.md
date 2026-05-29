# web-console — Models

View-model definitions for the console. These are presentation entities, not domain
entities — they exist only in the browser. Physical wiring in [design.md](design.md).

## Chat Message

One item in the rendered stream. A discriminated union over `kind`; every variant carries a
numeric `id` for keying.

| kind          | Attributes                                                              | Source event                 |
| ------------- | ----------------------------------------------------------------------- | ---------------------------- |
| `user`        | `text`                                                                  | local submit                 |
| `assistant`   | `text`                                                                  | `assistant_text`             |
| `tool-use`    | `toolName`, `input`                                                     | `tool_use`                   |
| `tool-result` | `content`, `isError`                                                    | `tool_result`                |
| `permission`  | `requestId`, `toolName`, `input`, `decision: 'allow' \| 'deny' \| null` | `permission_request`         |
| `system`      | `text`                                                                  | `session_end` / `error` note |

Relationships:

- A `permission` message correlates to a server Permission Request by `requestId`; its
  `decision` starts `null` and is set once (WC-R3).
- Messages are append-only and rendered in arrival order (WC-R1). Selecting a session replaces
  the whole stream with the replayed history (WC-R9).

## Sidebar view models

Mirror the server's `WorkspaceInfo` / `SessionInfo` (shared protocol); the console renders
them and tracks only which workspaces are expanded and which session is active.

| View model     | Attributes                                                | Source event                           |
| -------------- | --------------------------------------------------------- | -------------------------------------- |
| Workspace row  | `path`, `name`, `lastAccessed`                            | `ready` / `workspaces`                 |
| Session row    | `sessionId`, `title`, `lastModified`, `mode`              | `sessions`                             |
| Active session | `activeWorkspace`, `activeSession`, `activeTitle`, `mode` | `session_selected` / `session_started` |

## Notes

- Chat view models are ephemeral; reloading the page clears them and re-fetches from the
  server (the registry itself is persisted server-side, ADR 0004).
- `input` and `content` are rendered for the human; the console never interprets them.
