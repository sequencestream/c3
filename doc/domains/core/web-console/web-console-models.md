# web-console — Models

View-model definitions for the console. These are presentation entities, not domain
entities — they exist only in the browser. Behavioral wiring in [web-console-design.md](web-console-design.md).

## Chat Message

One item in the rendered stream. A discriminated union over `kind`; every variant carries a
numeric `id` for keying.

| kind          | Attributes                                                                            | Source event                                                     |
| ------------- | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `user`        | `text`                                                                                | `user_text` (prompt echo)                                        |
| `assistant`   | `text`                                                                                | `assistant_text`                                                 |
| `tool-use`    | `toolName`, `input`                                                                   | `tool_use`                                                       |
| `tool-result` | `content`, `isError`                                                                  | `tool_result`                                                    |
| `permission`  | `requestId`, `toolName`, `input`, `decision: 'allow' \| 'deny' \| null`, `consensus?` | `permission_request`                                             |
| `consensus`   | `toolName`, `input`, `outcome`                                                        | `consensus_auto`                                                 |
| `system`      | `text`                                                                                | `turn_end{error}` / `error` / `notice` (thinking-only turn) note |

Relationships:

- A `permission` message correlates to a server Permission Request by `requestId`; its
  `decision` starts `null` and is set once (WC-R3).
- Messages are append-only and rendered in arrival order (WC-R1). Selecting a session replaces
  the whole stream with the replayed history (WC-R9).

## Sidebar view models

Mirror the server's workspace / session info (shared protocol); the console renders them and
tracks which workspaces are expanded, which session is viewed, and each session's live status.

| View model     | Attributes                                                                                                                       | Source event                                     |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| Workspace row  | path, name, last-accessed                                                                                                        | `ready` / `workspaces`                           |
| Session row    | session id, title, last-modified, mode, `sessionKind`, optional `ownerKind`/`ownerId`, `bound`; status badge from session status | `sessions` / `session_status` / `session_counts` |
| Viewed session | active workspace, active session, active title, mode                                                                             | `session_selected` / `session_started`           |

The Sessions page keeps a separate paginated cache per `(workspace, sessionKind)` and a
six-kind running-count map. Owner fields are presentation inputs only: the client resolves
jump-back targets with a pure rule and does not persist or mutate ownership.

## Task list (server-derived, wire path)

A normalized "current task list" of the dev session's task tool calls (`TaskCreate` / `TaskList` /
`TaskUpdate` / `TaskGet`). Since 2026-06-07-009 it travels its **own wire path** (`task_list` +
`task_created`/`task_updated`/`task_deleted`): the **server** derives the model and the client just
fills the task model from those typed messages — no longer re-parsing tool-result content. The pure
reducer is the single source of truth in the shared task model; the client task-list module re-exports
it and adds two DOM-free pure helpers of its own — the display selector and the client fold that
applies one `task_*` delta (snapshot replace / id upsert / delete). Server derivation + replay rules
are in [the WebSocket protocol](../../../shared/api-conventions/websocket-protocol.md) (the `task_*`
path); client consumption is in [web-console-design.md](web-console-design.md) _Task-list (wire-driven)_.

| Entity          | Attributes                                                             | Source                                               |
| --------------- | ---------------------------------------------------------------------- | ---------------------------------------------------- |
| Task item       | id, subject, description?, status, order, blocked-by?, blocks?, owner? | carried by `task_*` wire messages (shared task item) |
| Task-list model | the ordered tasks (sorted by order; only one current list at a time)   | server-side fold, pushed as snapshot                 |
| Task-panel view | visible, in-progress, pending, completed (recent N), hidden-completed  | derived via the display selector                     |

Status is pending / in*progress / completed. Order is the original ordering (snapshot index, or
append for incremental inserts). Blocked-by / blocks / owner are kept only when the SDK result
includes them. The task-panel view is the read-only display projection consumed by the task panel
(grouping / completed-truncation / visibility — see [web-console-design.md](web-console-design.md) \_Task panel*). Since
2026-06-07-010 the panel is **additionally gated by capability**: the `settings` message carries the
per-vendor binary capability ledger, the container derives the active vendor's task-store capability
into a task-store-available flag, and the panel hides whenever the vendor lacks the task store
(unknown capability ⇒ defaults open, old-session safe).

## Notes

- Chat view models are ephemeral; reloading the page clears them and re-fetches from the
  server (the registry itself is persisted server-side, ADR 0004).
- Tool inputs and results are rendered verbatim for the human; the console interprets result content
  only for the client-only run-activity inference, never as authoritative state. The task list is no
  longer inferred from tool-result text — it arrives server-derived on the `task_*` wire path.
