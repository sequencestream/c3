# web-console — Design

Implements the [spec](spec.md). Vue 3 SPA. `web/src/App.vue` is a thin container (state +
WebSocket wiring) that composes presentational components under `web/src/components/`; shared
non-component modules live under `web/src/lib/`, including the WebSocket client `web/src/lib/ws.ts`.
Built with Vite; dev proxy in `web/vite.config.ts`.

## Components / structure

App owns all WebSocket state and `client.send`; child components are presentational, taking
props and emitting intent events (App performs every send). All styling is global
(`standard.css` + `style.css`), so components carry no scoped styles.

| Unit             | File                              | Role                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ---------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| App              | `App.vue`                         | Container: holds state, owns `client`, runs `handleMessage`, wires children                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| AppHeader        | `components/AppHeader.vue`        | Breadcrumbs, permission-mode dropdown, settings entry, connection status                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| SessionSidebar   | `components/SessionSidebar.vue`   | Workspace / session tree; owns per-workspace pagination + prompt/confirm UX, emits CRUD intents                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ChatMessages     | `components/ChatMessages.vue`     | Groups `messages` into render blocks (text / collapsible tool batch), owns expand state + autoscroll                                                                                                                                                                                                                                                                                                                                                                                                                     |
| PermissionPrompt | `components/PermissionPrompt.vue` | One permission block. When `actionable`: AskUserQuestion answer panel or allow/deny prompt (owns local answer draft, emits `respond`/`submit-ask`). When undecided-but-not-actionable: a single static history line (no buttons, no verdict)                                                                                                                                                                                                                                                                             |
| ConsensusBlock   | `components/ConsensusBlock.vue`   | Read-only render of an auto-resolved multi-agent consensus outcome                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| SessionStatusBar | `components/SessionStatusBar.vue` | Thin status line above the input: run-activity dot + spinner + label + refresh button; presentational, emits `refresh` (WC-R15)                                                                                                                                                                                                                                                                                                                                                                                          |
| MessageInput     | `components/MessageInput.vue`     | Prompt textarea + slash-command autocomplete; owns input draft, emits `submit`/`enqueue`/`stop`/`list-commands`, exposes `prefill(text)`. The textarea is editable whenever a session is active (only `!hasActiveSession` disables it); during an ordinary in-flight turn Send/Enter **enqueues** instead of submitting (`composerAction`), and Stop shows alongside. Submit keys: `⌘/Ctrl+Enter`, or two bare `Enter`s within 400ms (skips IME compose & `Shift+Enter`). Hovering Send for 2s shows a send-hint tooltip |
| PendingQueue     | `components/PendingQueue.vue`     | Pending-send queue rendered between SessionStatusBar and MessageInput; lists queued items (text + ✎ edit / 🗑 delete), emits `edit`/`delete`. Presentational; App owns the queue state and flush                                                                                                                                                                                                                                                                                                                         |
| SettingsPanel    | `components/SettingsPanel.vue`    | System settings page: agent table + consensus toggle; owns editable draft seeded from server settings                                                                                                                                                                                                                                                                                                                                                                                                                    |
| BaseDropdown     | `components/BaseDropdown.vue`     | Standard custom dropdown (replaces native `<select>`): trigger + popover with icon rows, keyboard nav, click-outside close                                                                                                                                                                                                                                                                                                                                                                                               |
| WS client        | `lib/ws.ts`                       | Opens `ws(s)://<host>/ws`, dispatches parsed `ServerToClient` to a listener, exposes `send(ClientToServer)` + `close()`; heartbeat + auto-reconnect with `onReopen` view recovery                                                                                                                                                                                                                                                                                                                                        |

Shared modules: `lib/chat-types.ts` (`ChatBody`/`ChatMsg`/`Block`/`RunActivity` types), `lib/ask.ts`
(AskUserQuestion parsing + consensus pre-fill), `lib/format.ts` (`fmt`/`oneLine`),
`lib/pending-queue.ts` (pure send-queue logic: `mergeQueue`/`shouldFlush`/`composerAction`/
`appendItem`/`removeItem`/`mergeIntoDraft`, unit-tested in `pending-queue.test.ts`),
`lib/task-list.ts` (pure task-list inference: `TaskItem`/`TaskListModel` types +
`emptyTaskModel`/`applyTaskTool`, plus the panel selector `taskPanelView` and `isTaskTool`/
`TASK_TOOL_NAMES`, unit-tested in `task-list.test.ts`; see _Task-list inference_ below).

## State (App.vue)

| Ref                | Type                               | Purpose                                                                                                                                         |
| ------------------ | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `messages`         | `ChatMsg[]`                        | Ordered render list (WC-R1); passed to ChatMessages                                                                                             |
| `status`           | `connecting` \| `open` \| `closed` | Connection indicator (WC-R6)                                                                                                                    |
| `sessionStatus`    | `Record<sessionId, SessionStatus>` | Per-session live status from `ready`/`session_status` (WC-R12)                                                                                  |
| `running`          | computed boolean                   | Viewed session's status ≠ `idle`; shows Stop and switches Send to enqueue (input stays editable) (WC-R2/R14)                                    |
| `pendingQueues`    | `Record<sessionId, PendingItem[]>` | Per-session client-only send queue (ordinary sessions). Survives session switches; lost on reload. `currentQueue` is the viewed session's slice |
| `activity`         | `RunActivity`                      | Fine-grained run state of the viewed session, inferred from the stream; drives SessionStatusBar (WC-R15)                                        |
| `mode`             | `PermissionMode`                   | Current mode; synced from `ready`/`mode_changed` (WC-R4)                                                                                        |
| `actionablePermId` | computed `string \| null`          | `requestId` of the one permission the user can still act on, or null; derived from `sessionStatus` + transcript (WC-R16)                        |

Component-local UI state (not in App): prompt draft + slash menu in MessageInput; tool/batch
expand sets in ChatMessages; per-question answer draft in PermissionPrompt; sidebar pagination
in SessionSidebar; editable settings draft in SettingsPanel.

`ChatMsg` is a discriminated union over `kind`: `user` · `assistant` · `tool-use` ·
`tool-result` · `permission` · `consensus` · `system`, each with a numeric `id`.

## Event handling (wire → UI)

`handleMessage(msg)` switches on `msg.type`:

| Wire event                 | UI effect                                                                                                     |
| -------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `ready`                    | set `mode`; seed `sessionStatus` from `statuses`                                                              |
| `session_status`           | replace `sessionStatus`; notify on background `awaiting_permission` (WC-R13)                                  |
| `mode_changed`             | set `mode`                                                                                                    |
| `session_selected`         | clear stream, render `history`, set running from `running`; buffer tail follows as live events (WC-R9)        |
| `user_text`                | append user message                                                                                           |
| `assistant_text`           | append assistant message                                                                                      |
| `tool_use` / `tool_result` | append tool-use / tool-result message                                                                         |
| `permission_request`       | append permission message with `decision: null` (live or replayed alike; actionability is derived, see below) |
| `consensus_auto`           | append consensus message                                                                                      |
| `turn_end`                 | append a system note only on `error`; running unlocks via `session_status` (WC-R5)                            |

## User actions (UI → wire)

| Action                 | Guard                                                                                    | Sends                                                                                       |
| ---------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `onSubmit(text)`       | non-empty, client present; reached only when idle or team (WC-R2)                        | `user_prompt`; optimistically marks viewed session `running`                                |
| `onEnqueue(text)`      | ordinary session running (`composerAction`)                                              | nothing — appends to `pendingQueues[viewed]` (client-only); clears the composer             |
| `onEditQueued(item)`   | item in queue                                                                            | nothing — removes the item and folds its text back into the composer draft (`prefill`)      |
| `onDeleteQueued(id)`   | item in queue                                                                            | nothing — removes the item from the queue                                                   |
| `flushIfReady()`       | `shouldFlush(running, teamActive, len)` (edge watch + level re-check in `applyStatuses`) | merges the viewed session's queue (`\n\n`) → `onSubmit` → clears it                         |
| `stopRun()`            | viewed session running (WC-R14)                                                          | `stop_run`                                                                                  |
| `respond(m, decision)` | client present, prompt `actionable` (⇒ `m.decision` null) (WC-R3)                        | `permission_response`; sets `m.decision` locally                                            |
| `setMode(next)`        | client present, value changed                                                            | optimistic `mode` update + `set_mode` (WC-R4); `next` from BaseDropdown `update:modelValue` |

## Permission actionability (live vs. replayed)

The server does **not** persist permission decisions, and `session_selected` replays the
runtime `buffer` — including past `permission_request` events — as ordinary live events. So a
refresh or session switch rebuilds every historical permission with `decision: null`, identical
on the wire to a fresh request. To avoid re-offering resolved prompts as actionable cards, the
client derives actionability rather than trusting `decision: null` alone (WC-R16):

- `actionablePermId` (App.vue, pure `lib/permission.ts`) = the `requestId` of the **single**
  permission the user can still act on, or null. A permission is actionable **iff** the viewed
  session is `awaiting_permission` **and** it is the latest still-undecided permission in the
  transcript. The SDK blocks on one permission at a time, so that latest undecided one is the
  genuinely pending request; everything earlier (or anything replayed once the session moved on)
  is non-actionable.
- PermissionPrompt renders three states: **actionable** → interactive card (buttons);
  `decision !== null` → decision verdict (live feedback after the user answers this session);
  undecided-but-not-actionable → a single **static history line** (no buttons, no verdict).
- This keeps a genuinely-pending permission answerable after a refresh (it stays the latest
  undecided one while `awaiting_permission`), while resolved history degrades to a static record.
- ChatMessages forces a tool batch open only for the actionable permission, not for replayed
  static ones.

## Task-list inference (client-only)

A dev session calls the SDK task tools (`TaskCreate` / `TaskList` / `TaskUpdate` / `TaskGet`),
which arrive as ordinary `tool_use` + `tool_result` pairs. Like `RunActivity`, the console
**infers** a normalized "current task list" entirely on the client — **no wire/protocol change**.
The pure logic lives in `lib/task-list.ts` (unit-tested, DOM-free); App.vue drives it by correlating
each task `tool_use` with its `tool_result` (by `toolUseId`) and folding the pair into the model:

- `applyTaskTool(model, toolName, input, result?) → TaskListModel` is pure (returns a new model,
  same reference when nothing changed). `emptyTaskModel()` seeds it.
- **Snapshot vs. increment.** `TaskList` is a **full snapshot** → it replaces the whole list (old
  list never stacks); an unparseable snapshot keeps the current list rather than clearing it.
  `TaskGet` is a single-task snapshot → **upsert**. `TaskCreate` reads the new task's `id` from the
  **result** (its input has no id) and inserts it; if no id is recoverable it is skipped. `TaskUpdate`
  prefers the result, else applies the `input` (`taskId` + `status`/`subject`/…) incrementally; an
  update to an unknown id is ignored (tolerates out-of-order arrival — a later snapshot reconciles).
- **Ordering.** `TaskItem.order` is the original order: snapshot uses array index; an incremental
  insert takes `max(order)+1`; updates/upserts preserve the existing order.
- **Tolerance.** The result extractor accepts several serializations (JSON array / `{tasks:[…]}` /
  `{task:{…}}` / single object), normalizes `id` (number→string), defaults an invalid/missing
  `status` to `pending`, drops non-object / id-less rows, and never throws on dirty data — the SDK
  result serialization isn't pinned, so parsing is defensive by design.
- **Wiring.** App.vue holds the `taskModel` ref + a `toolUseId → {toolName, input}` pending map,
  reset on `session_selected`. Both history replay (the `msg.history` loop) and the live
  `tool_use`/`tool_result` cases feed the _same_ `feedTaskUse`/`feedTaskResult` helpers (gated by
  `isTaskTool`), so replay and the live stream converge on one model. Only task tools enter the
  model; their ordinary `tool_use`/`tool_result` chat rows are untouched (kept as history).

### Task panel (TaskPanel.vue)

A read-only, resident panel between ChatMessages and SessionStatusBar (`.content`) renders the
viewed session's live tasks. Display rules are a pure selector, `taskPanelView(model, recent=2)`:

- **Grouping & order.** Three groups, each ascending by `order`: `in_progress` on top
  (highlighted), `pending` in the middle, `completed` at the bottom (✓, struck-through / greyed).
- **Truncation.** `completed` keeps only the most recent `recent` (highest `order`) entries, still
  ascending; the rest are counted in `hiddenCompleted` and shown as a "+N 已完成" hint.
- **Visibility.** `visible` is true only when an `in_progress` or `pending` task exists; an
  all-completed or empty list hides the whole panel. The component is the selector's `v-if`.
- The user never edits tasks here — status is driven solely by the agent's tool calls.
- **Tests.** The selector is covered DOM-free in `task-list.test.ts`; `TaskPanel.vue` additionally
  has a mounted component test (`TaskPanel.test.ts`) via `@vue/test-utils` — see _Testing_ below.

## Pending send queue (ordinary sessions)

An ordinary session is single-turn: the server rejects a `user_prompt` while a turn is in
flight (agent-session). So the composer stays editable during a turn, but Send/Enter
**enqueues** the text instead of sending it (`composerAction`). This is a client-only affordance
— **no server or protocol change**. Team sessions are unaffected: their lead is alive across
turns, so the composer still feeds the live lead immediately (`composerAction` returns `send`).

- **Per-session, in-memory.** `pendingQueues` is keyed by `sessionId`, so switching sessions
  keeps each queue intact (switch away and back and it's still there). It is plain reactive
  state — a hard refresh or server restart loses it (consistent with "no persistence" above).
- **Queue UI.** PendingQueue renders the viewed session's items between the status bar and the
  composer. Each item is still _pending (not yet in context)_ and carries ✎ (edit) and 🗑
  (delete): delete drops it; edit drops it and folds its text back into the composer draft
  (`mergeIntoDraft` — single-newline append so an in-progress draft isn't lost) for re-editing.
- **Flush on ready (level-triggered).** When the viewed ordinary session is idle with a non-empty
  queue (`shouldFlush`), the items are merged in order, joined by a blank line (`\n\n`), into one
  prompt and submitted via the normal `onSubmit` → `user_prompt` path; the queue is then cleared.
  The trigger is **level**, not edge: besides the `watch` on `running`/`activeSession`/`activeIsTeam`
  (which catches the `running→idle` transition), `applyStatuses` calls `flushIfReady()` after every
  `session_status` broadcast/reconcile. So a queue still flushes even if that transition was missed
  (e.g. the broadcast arrives already-idle with no change for the `watch` to fire on) — the stuck
  queue would otherwise linger forever. The flush is idempotent: `shouldFlush` gates on idle + non-empty,
  and `onSubmit` optimistically marks the session running, so it can't re-fire before the server
  confirms. The merged prompt comes back as an ordinary `user_text` echo bubble — once flushed, those
  entries are normal context, no longer editable/deletable.
- **Routing constraint.** Because `user_prompt` routes to the connection's currently-viewed
  session, flush only fires for the viewed-and-idle session. An unviewed session's queue is
  retained until it is viewed again while idle, then flushed.
- The merge/flush-trigger/add-edit-delete logic is the pure module `lib/pending-queue.ts`,
  unit-tested in Node (no DOM).

## WS client behavior

- URL derived from `window.location`: `wss:` when the page is HTTPS, else `ws:`.
- `onmessage` parses JSON and forwards; parse errors are ignored. `pong` is swallowed in the
  client (transport-only) and never reaches the app listener.
- `send` drops the message with a console warning if the socket is not `OPEN`.
- **Heartbeat**: every 25s the client sends `ping`; the server replies `pong`. This keeps idle
  proxies/load-balancers from dropping the socket. If no `pong` returns within 10s the link is
  treated as half-open and force-closed, which triggers reconnect.
- **Auto-reconnect**: `onclose` (from a real drop, a failed heartbeat, or `onerror`) schedules a
  reconnect with exponential backoff (1s → ×2 → cap 30s) plus jitter; backoff resets on a
  successful open. `close()` sets a `stopped` flag that cancels heartbeat + reconnect for clean
  teardown.
- **View recovery**: a reconnect (not the first connect) fires `onReopen`, where App re-sends
  `select_session` for the active workspace/session. The server's fresh connection re-attaches as
  a viewer and replays `history` + buffered live events, so the stream resumes without a reload.

## Technology choices

- **Vue 3 `<script setup>` + refs** — minimal reactive state, no store needed for a
  single-view app.
- **Vite dev proxy** forwards `/ws` to the server (`:3000`) so the browser connects
  transparently in development (ADR 0002).
- **JSON-pretty rendering** (`fmt`) for tool inputs; multi-line collapse + CSS ellipsis for
  compact display.

## Non-functional considerations

- **Render order = arrival order** (PERF-3 forwarded; the console adds no reordering).
- **No authority** — the console enforces nothing; the server is the decision authority
  (SEC-4, WC-R7).
- **No persistence** — reloading the page loses the transcript (consistent with SEC-2).

## Visual style

The console's look and feel follows the project style guide at
[`specs/style/style-spec.md`](../../../style/style-spec.md) (immersive dark base,
translucent materials, restrained accent color, low information density). Component styling
should conform to it rather than restating its rules here.

## Testing

- A single root `vitest.config.ts` runs every package's colocated `*.test.ts`. The default
  environment is `node`; only `web/src/components/**` runs in **happy-dom** (`environmentMatchGlobs`),
  and the `vue()` plugin lets those tests mount `.vue` SFCs.
- **Pure logic** (reducers, selectors, view models in `lib/`) is tested DOM-free in Node — the bulk
  of coverage, fast and free of a mounted DOM.
- **Component tests** mount the SFC with `@vue/test-utils` and assert on rendered DOM / prop-driven
  re-render — used where behavior is the rendering itself (e.g. `TaskPanel.test.ts`: grouping order,
  completed-truncation, visibility, per-status markup, live switch on `setProps`).

## Dependencies

- **`@ccc/shared`** — protocol types (the only cross-package import).
- **agent-session** — the WebSocket backend.
- **Dev/test** — `@vue/test-utils` + `happy-dom` + `@vitejs/plugin-vue` (component tests only;
  pure-logic suites need none of them).
