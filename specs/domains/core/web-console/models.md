# web-console — Models

View-model definitions for the console. These are presentation entities, not domain
entities — they exist only in the browser. Physical wiring in [design.md](design.md).

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

Mirror the server's `WorkspaceInfo` / `SessionInfo` (shared protocol); the console renders
them and tracks which workspaces are expanded, which session is viewed, and each session's live
status.

| View model     | Attributes                                                                      | Source event                           |
| -------------- | ------------------------------------------------------------------------------- | -------------------------------------- |
| Workspace row  | `path`, `name`, `lastAccessed`                                                  | `ready` / `workspaces`                 |
| Session row    | `sessionId`, `title`, `lastModified`, `mode`; status badge from `sessionStatus` | `sessions` / `session_status`          |
| Viewed session | `activeWorkspace`, `activeSession`, `activeTitle`, `mode`                       | `session_selected` / `session_started` |

## Task list (inferred)

A normalized "current task list" inferred entirely on the client from the dev session's task
tool calls (`TaskCreate` / `TaskList` / `TaskUpdate` / `TaskGet`), like `RunActivity` — **no wire
event of its own**. Definitions and reducer live in `lib/task-list.ts`; inference rules (snapshot
vs. increment, ordering, tolerance) are in [design.md](design.md) _Task-list inference_.

| Entity          | Attributes                                                                            | Source                                         |
| --------------- | ------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `TaskItem`      | `id`, `subject`, `description?`, `status`, `order`, `blockedBy?`, `blocks?`, `owner?` | task `tool_use` + matching `tool_result`       |
| `TaskListModel` | `tasks: TaskItem[]` (sorted by `order`; only one current list at a time)              | folded via `applyTaskTool`                     |
| `TaskPanelView` | `visible`, `inProgress`, `pending`, `completed` (recent N), `hiddenCompleted`         | derived via `taskPanelView` (display selector) |

`status` is `pending \| in_progress \| completed`. `order` is the original ordering (snapshot
index, or append for incremental inserts). `blockedBy` / `blocks` / `owner` are kept only when the
SDK result includes them. `TaskPanelView` is the read-only display projection consumed by
`TaskPanel.vue` (grouping / completed-truncation / visibility — see [design.md](design.md)
_Task panel_).

## Notes

- Chat view models are ephemeral; reloading the page clears them and re-fetches from the
  server (the registry itself is persisted server-side, ADR 0004).
- `input` and `content` are rendered verbatim for the human; the console interprets them only for
  the client-only inferences noted above (`RunActivity`, task list), never as authoritative state.
