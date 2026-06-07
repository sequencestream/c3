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

## Task list (server-derived, wire path)

A normalized "current task list" of the dev session's task tool calls (`TaskCreate` / `TaskList` /
`TaskUpdate` / `TaskGet`). Since 2026-06-07-009 it travels its **own wire path** (`task_list` +
`task_created`/`task_updated`/`task_deleted`): the **server** derives the model and the client just
fills `taskModel` from those typed messages — no longer re-parsing `tool_result.content`. The pure
reducer is the single SoT in `@ccc/shared/task-model`; `lib/task-list.ts` re-exports it and adds two
DOM-free pure helpers of its own — the display selector `taskPanelView` and the client fold
`applyTaskEvent(model, msg)` that applies one `task_*` delta (snapshot replace / id upsert / delete).
Server derivation + replay rules are in `specs/shared/api-conventions/websocket-protocol.md`
(`task_*`) and the server task-tracker; client consumption is in [design.md](design.md)
_Task-list (wire-driven)_.

| Entity          | Attributes                                                                            | Source                                                   |
| --------------- | ------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `TaskItem`      | `id`, `subject`, `description?`, `status`, `order`, `blockedBy?`, `blocks?`, `owner?` | carried by `task_*` wire messages (shared `TaskItem`)    |
| `TaskListModel` | `tasks: TaskItem[]` (sorted by `order`; only one current list at a time)              | server-side fold via `applyTaskTool`, pushed as snapshot |
| `TaskPanelView` | `visible`, `inProgress`, `pending`, `completed` (recent N), `hiddenCompleted`         | derived via `taskPanelView` (display selector)           |

`status` is `pending \| in_progress \| completed`. `order` is the original ordering (snapshot
index, or append for incremental inserts). `blockedBy` / `blocks` / `owner` are kept only when the
SDK result includes them. `TaskPanelView` is the read-only display projection consumed by
`TaskPanel.vue` (grouping / completed-truncation / visibility — see [design.md](design.md)
_Task panel_). Since 2026-06-07-010 the panel is **additionally gated by capability**: the `settings`
message carries `vendorCapabilities` (each vendor's binary `AdapterCapability` ledger), App.vue
derives the active vendor's `taskStore` into `taskStoreAvailable`, and `TaskPanel` hides whenever the
vendor lacks `taskStore` (unknown capability ⇒ defaults open, old-session safe).

## Notes

- Chat view models are ephemeral; reloading the page clears them and re-fetches from the
  server (the registry itself is persisted server-side, ADR 0004).
- `input` and `content` are rendered verbatim for the human; the console interprets `content` only
  for the client-only `RunActivity` inference, never as authoritative state. The task list is no
  longer inferred from `tool_result` text — it arrives server-derived on the `task_*` wire path.
