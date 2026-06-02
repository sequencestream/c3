# web-console — Design

Implements the [spec](spec.md). Vue 3 SPA. `web/src/App.vue` is a thin container (state +
WebSocket wiring) that composes presentational components under `web/src/components/`; shared
non-component modules live under `web/src/lib/`, including the WebSocket client `web/src/lib/ws.ts`.
Built with Vite; dev proxy in `web/vite.config.ts`.

## Components / structure

App owns all WebSocket state and `client.send`; child components are presentational, taking
props and emitting intent events (App performs every send). All styling is global
(`standard.css` + `style.css`), so components carry no scoped styles.

| Unit              | File                               | Role                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ----------------- | ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| App               | `App.vue`                          | Container: holds state, owns `client`, runs `handleMessage`, wires children                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| AppHeader         | `components/AppHeader.vue`         | Top bar: hosts WorkspaceSwitcher (far left), the **tab nav** (data-driven `tabs` → 「会话」/「需求」, active highlighted, disabled until a workspace exists; emits `select-tab`), settings entry, connection status. Carries no session title or permission-mode dropdown — those moved to SessionTitleBar (WC-R9)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| SessionTitleBar   | `components/SessionTitleBar.vue`   | Chat column's title row (top of `.content`): left session title + right permission-mode dropdown. App renders it only on the console tab with an active session (`activeTab === 'console' && hasActiveSession`); presentational, emits `set-mode` (App runs the optimistic `setMode`). WC-R9                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| WorkspaceSwitcher | `components/WorkspaceSwitcher.vue` | Top-bar current-workspace control: trigger shows the current workspace name + `+` (add via `window.prompt`) + `▾`; the popover lists every workspace (name + path), selects one, and removes one (second-confirm). Self-contained popover (pointerdown-capture close, like BaseDropdown); presentational, emits `add/select/remove-workspace`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| SessionList       | `components/SessionList.vue`       | The 「会话」tab's left column — the current workspace's session list (no workspace tree). Rendered only on the console tab (the requirement tab's left column is RequirementList; both share the right-side chat console). Owns session pagination + prompt/confirm UX, emits session CRUD intents. The header carries only ＋ New session; the requirement entry moved to the top-bar tab nav (AppHeader), so SessionList no longer renders the 「需求录入」💡 shortcut (WC-R18)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ChatMessages      | `components/ChatMessages.vue`      | Groups `messages` into render blocks (text / collapsible tool batch), owns expand state + autoscroll. Text blocks delegate rendering to MarkdownText; tool-use/result rows stay verbatim in `<pre class="tool-body">`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| MarkdownText      | `components/MarkdownText.vue`      | One text message's renderer. Props `{text, kind}`. **Only `kind === 'assistant'`** runs Markdown (module-level `MarkdownIt({html:false,linkify:true,breaks:true})` → `DOMPurify.sanitize` → `v-html` under `.md-body`, a `computed` caches the result); `user`/`system` fall through to escaped plain text. Two-line defense: `html:false` blocks raw HTML, DOMPurify strips anything that slips through. An `afterSanitizeAttributes` hook (registered once) forces external links to `target="_blank" rel="noopener noreferrer"` and drops `javascript:`/`data:` hrefs. Sanitizer allows `class`/`data-language` (Shiki-ready) but no inline style. After mount, code blocks get async Shiki highlighting (`lib/highlight.ts`): dynamic `import('shiki')`, per-language lazy grammar loading, custom css-vars style theme → strip inline style → token class→`--c-*` color mapping (driven by `[data-theme]`); unknown-lang / load fail keeps the original `<pre><code>` intact. Non-streaming (whole-message push) so no buffering / unclosed-tag handling needed |
| PermissionPrompt  | `components/PermissionPrompt.vue`  | One permission block. When `actionable`: AskUserQuestion answer panel or allow/deny prompt (owns local answer draft, emits `respond`/`submit-ask`). When undecided-but-not-actionable: a single static history line (no buttons, no verdict)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ConsensusBlock    | `components/ConsensusBlock.vue`    | Read-only render of an auto-resolved multi-agent consensus outcome                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| SessionStatusBar  | `components/SessionStatusBar.vue`  | Thin status line above the input: run-activity dot + spinner + label + refresh button; presentational, emits `refresh` (WC-R15)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| MessageInput      | `components/MessageInput.vue`      | Prompt textarea + slash-command autocomplete; owns input draft, emits `submit`/`enqueue`/`stop`/`list-commands`, exposes `prefill(text)`. The textarea is editable whenever a session is active (only `!hasActiveSession` disables it); during an ordinary in-flight turn Send/Enter **enqueues** instead of submitting (`composerAction`), and Stop shows alongside. Submit keys: `⌘/Ctrl+Enter`, or two bare `Enter`s within 400ms (skips IME compose & `Shift+Enter`). Hovering Send for 2s shows a send-hint tooltip                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| PendingQueue      | `components/PendingQueue.vue`      | Pending-send queue rendered between SessionStatusBar and MessageInput; lists queued items (text + ✎ edit / 🗑 delete), emits `edit`/`delete`. Presentational; App owns the queue state and flush                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| SettingsPanel     | `components/SettingsPanel.vue`     | System settings page: agent table + consensus toggle; owns editable draft seeded from server settings                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| BaseDropdown      | `components/BaseDropdown.vue`      | Standard custom dropdown (replaces native `<select>`): trigger + popover with icon rows, keyboard nav, click-outside close                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| RequirementList   | `components/RequirementList.vue`   | Requirement view left column: requirement list + status filter + row actions (refine/start-dev/dev-detail/set-status/set-automate). Receives full requirement list and automation-orchestrator status as props; emits intent events for App to send. Renders each item's lifecycle status badge plus the derived `runStatus` indicator (running green pulse / dangling amber) next to `in_progress` items. Panel is collapsible (narrow view hides secondary fields)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| WS client         | `lib/ws.ts`                        | Opens `ws(s)://<host>/ws`, dispatches parsed `ServerToClient` to a listener, exposes `send(ClientToServer)` + `close()`; heartbeat + auto-reconnect with `onReopen` view recovery                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

Shared modules: `lib/current-workspace.ts` (`resolveCurrentWorkspace(stored, workspaces)` — pure
current-workspace resolution: keep the persisted choice while it's still listed, else fall back to
the most-recent workspace; unit-tested in `current-workspace.test.ts`), `lib/chat-types.ts`
(`ChatBody`/`ChatMsg`/`Block`/`RunActivity` types), `lib/ask.ts`
(AskUserQuestion parsing + consensus pre-fill), `lib/format.ts` (`fmt`/`oneLine`),
`lib/pending-queue.ts` (pure send-queue logic: `mergeQueue`/`shouldFlush`/`composerAction`/
`appendItem`/`removeItem`/`mergeIntoDraft`, unit-tested in `pending-queue.test.ts`),
`lib/req-list-view.ts` (requirement-list pure presentation logic: `statusLabel`/`reqRunStatusLabel`/
`panelToggleLabel`/`rowVisibility`/`showRunStatus`/`compareByCompletion`, unit-tested in
`req-list-view.test.ts`; see _Requirement runStatus indicator_ below),
`lib/task-list.ts` (pure task-list inference: `TaskItem`/`TaskListModel` types +
`emptyTaskModel`/`applyTaskTool`, plus the panel selector `taskPanelView` and `isTaskTool`/
`TASK_TOOL_NAMES`, unit-tested in `task-list.test.ts`; see _Task-list inference_ below),
`lib/tab-view.ts` (`SessionRef` + `consoleEntryTarget(remembered, currentWorkspace, sessions)` —
pure console-tab entry decision: honor the remembered session, else the workspace's first, else
empty; unit-tested in `tab-view.test.ts`; see _Per-tab viewed session_ below).

## State (App.vue)

| Ref                   | Type                                     | Purpose                                                                                                                                                                                                                                                                                                |
| --------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `messages`            | `ChatMsg[]`                              | Ordered render list (WC-R1); passed to ChatMessages                                                                                                                                                                                                                                                    |
| `currentWorkspace`    | `string \| null`                         | The single global current workspace path (WC-R8); resolved via `resolveCurrentWorkspace`, persisted to `localStorage`, drives the console tab's session list (`currentSessions` = its `sessionsByWorkspace` slice). Decoupled from `activeWorkspace` (the viewed session's workspace)                  |
| `status`              | `connecting` \| `open` \| `closed`       | Connection indicator (WC-R6)                                                                                                                                                                                                                                                                           |
| `sessionStatus`       | `Record<sessionId, SessionStatus>`       | Per-session live status from `ready`/`session_status` (WC-R12)                                                                                                                                                                                                                                         |
| `running`             | computed boolean                         | Viewed session's status ≠ `idle`; shows Stop and switches Send to enqueue (input stays editable) (WC-R2/R14)                                                                                                                                                                                           |
| `pendingQueues`       | `Record<sessionId, PendingItem[]>`       | Per-session client-only send queue (ordinary sessions). Survives session switches; lost on reload. `currentQueue` is the viewed session's slice                                                                                                                                                        |
| `activity`            | `RunActivity`                            | Fine-grained run state of the viewed session, inferred from the stream; drives SessionStatusBar (WC-R15)                                                                                                                                                                                               |
| `mode`                | `PermissionMode`                         | Current mode; synced from `ready`/`mode_changed` (WC-R4)                                                                                                                                                                                                                                               |
| `actionablePermId`    | computed `string \| null`                | `requestId` of the one permission the user can still act on, or null; derived from `sessionStatus` + transcript (WC-R16)                                                                                                                                                                               |
| `requirements`        | `Record<projectPath, Requirement[]>`     | Per-project requirement lists; updated on `requirements` push or `list_requirements` reply                                                                                                                                                                                                             |
| `automation`          | `Record<projectPath, AutomationStatus>`  | Per-project automation-orchestrator status; updated on `automation_status` push                                                                                                                                                                                                                        |
| `activeTab`           | `TabKey` (`'console' \| 'requirements'`) | The explicit top-bar tab selection driving which page the content area renders (WC-R18). Backed by the data-driven `HEADER_TABS` list (extensible — a future 「讨论」tab is one more entry + one body branch). Persisted to `localStorage` (key `c3.viewMode`) so a hard refresh restores the tab      |
| `requirementsProject` | `string \| null`                         | The project path whose requirement page is currently open; persisted alongside `activeTab`                                                                                                                                                                                                             |
| `consoleSession`      | `{workspacePath,sessionId} \| null`      | The 「会话」tab's OWN last-viewed session pointer, independent of the requirement tab's comm session — so switching tabs never crosses chat content. Drives `switchToConsoleTab`'s re-bind. In-memory (survives WS reconnect, lost on reload, like the transcript). See _Per-tab viewed session_ below |

Component-local UI state (not in App): prompt draft + slash menu in MessageInput; tool/batch
expand sets in ChatMessages; per-question answer draft in PermissionPrompt; session-list pagination
in SessionList; editable settings draft in SettingsPanel.

`ChatMsg` is a discriminated union over `kind`: `user` · `assistant` · `tool-use` ·
`tool-result` · `permission` · `consensus` · `system`, each with a numeric `id`.

## Event handling (wire → UI)

`handleMessage(msg)` switches on `msg.type`:

| Wire event                 | UI effect                                                                                                                                          |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ready`                    | set `mode`; seed `sessionStatus` from `statuses`; resolve `currentWorkspace` (persisted → most-recent) and `list_sessions` for it (WC-R8)          |
| `workspaces`               | replace the workspace list; if `currentWorkspace` was removed, fall back via `resolveCurrentWorkspace` and load the new one's sessions (WC-R8)     |
| `session_status`           | replace `sessionStatus`; notify on background `awaiting_permission` (WC-R13)                                                                       |
| `mode_changed`             | set `mode`                                                                                                                                         |
| `session_selected`         | clear stream, render `history`, seed `sessionStatus[sessionId]` from `status` (locks composer at once); buffer tail follows as live events (WC-R9) |
| `user_text`                | append user message                                                                                                                                |
| `assistant_text`           | append assistant message                                                                                                                           |
| `tool_use` / `tool_result` | append tool-use / tool-result message                                                                                                              |
| `permission_request`       | append permission message with `decision: null` (live or replayed alike; actionability is derived, see below)                                      |
| `consensus_auto`           | append consensus message                                                                                                                           |
| `turn_end`                 | append a system note only on `error`; running unlocks via `session_status` (WC-R5)                                                                 |
| `requirements`             | replace `requirements[projectPath]` with the pushed list (WC-R10)                                                                                  |
| `automation_status`        | replace `automation[projectPath]` with the pushed orchestrator status (WC-R11)                                                                     |

## Requirement runStatus indicator

Each `Requirement` carries a derived `runStatus: 'running' | 'dangling' | 'idle'` field (see
[requirement-management design](../core/requirement-management/design.md)). The server computes it during
`reconcileInProgress` on `open_requirement_chat` entry, caches the result, and enriches every requirement
broadcast via `enrichRunStatus`:

- **`running`** — the dev session's process is alive in the runtime registry (`isRunning`). The UI renders a
  green pulsing dot + "运行中" badge next to the lifecycle status.
- **`dangling`** — the dev process is dead but the requirement is still `in_progress` (server restart / crash /
  normal exit where the completion judge found it not done). The UI renders an amber dot + "已中断" warning.
- **`idle`** — not `in_progress`, or auto-completed. No runStatus indicator is rendered.
- **Reconnect / hard refresh.** The `onReopen` callback re-sends `open_requirement_chat`, which triggers a
  fresh reconcile + `enrichRunStatus` pass. `maybeRestoreRequirements` recovers the persisted tab (and its
  project) from `localStorage`. Both paths restore the correct runStatus without user action.
- **Broadcast enrichment.** Every `broadcastRequirements` call applies `enrichRunStatus`, which checks live
  `isRunning` first, then falls back to the reconcile cache (see `server.ts`). So incremental status changes
  (a dev session completes, the orchestrator progresses) also reflect the correct runStatus on all connections.

The pure display logic lives in `lib/req-list-view.ts`:

| Function                   | Returns                    | Description                                      |
| -------------------------- | -------------------------- | ------------------------------------------------ |
| `statusLabel(s)`           | `string`                   | Lifecycle status (`draft`→`草稿` …)              |
| `reqRunStatusLabel(s)`     | `string`                   | Derived run-status label (`running`→`运行中` …)  |
| `showRunStatus(s)`         | `boolean`                  | `true` for non-`idle` run statuses               |
| `panelToggleLabel(coll)`   | `{icon,text}`              | Collapse button label reflecting target state    |
| `rowVisibility(coll)`      | `{showModule,showActions}` | Secondary-field visibility in collapsed mode     |
| `compareByCompletion(a,b)` | `number`                   | Done-items sort: completedAt desc, then priority |

The CSS utility class `status-pulse` (`animation`) is shared with the session-status dot in
`SessionStatusBar.vue` — `.req-run-status.running` reuses it for the green pulsing indicator.

## User actions (UI → wire)

| Action                                         | Guard                                                                                    | Sends                                                                                                                                                                                                                                                      |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `onSubmit(text)`                               | non-empty, client present; reached only when idle or team (WC-R2)                        | `user_prompt`; optimistically marks viewed session `running`                                                                                                                                                                                               |
| `onEnqueue(text)`                              | ordinary session running (`composerAction`)                                              | nothing — appends to `pendingQueues[viewed]` (client-only); clears the composer                                                                                                                                                                            |
| `onEditQueued(item)`                           | item in queue                                                                            | nothing — removes the item and folds its text back into the composer draft (`prefill`)                                                                                                                                                                     |
| `onDeleteQueued(id)`                           | item in queue                                                                            | nothing — removes the item from the queue                                                                                                                                                                                                                  |
| `flushIfReady()`                               | `shouldFlush(running, teamActive, len)` (edge watch + level re-check in `applyStatuses`) | merges the viewed session's queue (`\n\n`) → `onSubmit` → clears it                                                                                                                                                                                        |
| `stopRun()`                                    | viewed session running (WC-R14)                                                          | `stop_run`                                                                                                                                                                                                                                                 |
| `selectWorkspace(path)`                        | path ≠ current (`workspaceSwitchEffects`, WC-R8)                                         | sets `currentWorkspace` + persists; **force** `list_sessions` for the target (bypasses the `ensureSessions` cache — refreshes only that workspace's slice); then `switchToConsoleTab()` so the view lands on 「会话」and re-binds via `consoleEntryTarget` |
| `addWorkspace(path)` / `removeWorkspace(path)` | switcher `+` / row `✕` (second-confirm) (WC-R8)                                          | `add_workspace` / `remove_workspace`                                                                                                                                                                                                                       |
| `respond(m, decision)`                         | client present, prompt `actionable` (⇒ `m.decision` null) (WC-R3)                        | `permission_response`; sets `m.decision` locally                                                                                                                                                                                                           |
| `setMode(next)`                                | client present, value changed                                                            | optimistic `mode` update + `set_mode` (WC-R4); `next` from BaseDropdown `update:modelValue`                                                                                                                                                                |
| `onSelectTab(key)`                             | top-bar tab click (WC-R18)                                                               | nothing — `console`→`switchToConsoleTab()` (flip + re-bind console session); `requirements`→`openRequirements(currentWorkspace)` (no-op without a workspace)                                                                                               |
| `openRequirements(p)`                          | client present                                                                           | `open_requirement_chat` — server replies with comm `session_selected` + `requirements`                                                                                                                                                                     |
| `setRequirementFilter(s)`                      | `requirementsProject` set                                                                | `list_requirements` with optional status filter                                                                                                                                                                                                            |
| `refineRequirement(id)`                        | client present                                                                           | `refine_requirement`; launches a fresh seeded comm session                                                                                                                                                                                                 |
| `startDevelopment(id)`                         | client present                                                                           | `start_development` — background dev-skill launch, status flips to `in_progress`                                                                                                                                                                           |
| `setRequirementStatus(id,s)`                   | client present                                                                           | `update_requirement_status`; broadcast re-enriches runStatus                                                                                                                                                                                               |
| `setRequirementAutomate(id,bool)`              | client present                                                                           | `set_requirement_automate`; broadcast re-enriches runStatus                                                                                                                                                                                                |
| `startAutomation()`                            | `requirementsProject` set                                                                | `start_automation` — begins the per-project orchestrator loop                                                                                                                                                                                              |
| `stopAutomation()`                             | `requirementsProject` set                                                                | `stop_automation` — aborts the current orchestration run                                                                                                                                                                                                   |

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

## Discussion agenda progress (AgendaProgress.vue)

The discussion detail (the `activeTab === 'discussion'` branch of `.content`, between SessionTitleBar
and ChatMessages) renders the organizer engine's **explicit agenda** for the open discussion:
the ordered subtopic list, the current subtopic, and overall completion. It reads straight from
`activeDiscussion` (`Discussion.agenda: string[]` + `agendaIndex: number`); no new App state or wire
handling — see the [discussion design](../discussion/design.md) for the agenda model.

- **Pure selector** `agendaProgressView(discussion)` (`lib/discussion-view.ts`, DOM-free, unit-tested)
  folds the discussion into `{ visible, items, current, completed, total, percent, complete }`. The
  0-based `agendaIndex` is the single source of completion (items before it `done`, the item at it
  `current`, the rest `upcoming`); it is clamped to `[0, length]` so a stale/garbage index can never
  produce a negative percent or an out-of-range current. An empty agenda ⇒ `visible: false`; a complete
  agenda (`index === length`) ⇒ `current: null`, `percent: 100`, every item `done`.
- **Component** `AgendaProgress.vue` is the selector's `v-if` (renders nothing until the engine sets an
  agenda): a header (`completed/total (percent%)`) + a progress bar (`width: percent%`) + one row per
  subtopic with a status mark (✓ done / ▶ current / ○ upcoming), reusing the task-panel visual language
  (current highlighted, done struck-through/greyed). UI copy is English (`web/CLAUDE.md`).
- **Live update.** The agenda re-renders reactively as the prop changes: the engine fires
  `onStatusChange` on every `set_agenda`/`focus_subtopic` → `discussions` broadcast → App's
  `case 'discussions'` refreshes `activeDiscussion` (the `discussion_message` announcement carries no
  agenda fields, so the list push is what moves the bar). `discussion_detail` seeds the initial agenda.
- **Tests.** The selector is covered DOM-free in `discussion-view.test.ts` (hidden / partial / complete /
  index clamping); `AgendaProgress.test.ts` mounts the SFC (`@vue/test-utils`) and asserts the rows,
  marks, count/percent, bar width, visibility, and live re-render on `setProps` (index advancing).

## Per-tab viewed session (no cross-tab pollution)

The 「会话」(console) and 「需求」(requirements) tabs each maintain their **own** current
session; switching tabs renders the chat column from that tab's session, never the other's.
Previously a single global `activeSession`/`messages` served both: entering the requirement tab
selected its comm session into the global state, and switching back left the console tab showing
the comm session's chat (cross-talk).

- **Why re-select, not cache.** The server streams live events to only the connection's
  currently-viewed session, so a cached `messages` for the non-viewed tab would go stale. Switching
  back therefore re-`select_session`s (replaying `history` + buffered tail) — the same recovery the
  reconnect path uses. The requirement tab re-sends `open_requirement_chat`, which the server resolves
  to the project's `is_current` comm session; no client-side comm pointer is needed.
- **`consoleSession` pointer.** The console tab's own `{workspacePath, sessionId}` (or null). It is
  recorded in `session_selected` **only while `activeTab === 'console'`** — comm-session selections
  (open/new/refine requirement chat) always arrive while the requirement tab is active, so they never
  pollute it. The explicit selectors (`selectSession`/`openDevSession`) also pin it up front (covers
  `selectSession`'s already-viewing early-return). `deleteSession` clears it when the deleted session
  was the pointer, so the next entry falls back.
- **Tab-switch wiring.** The top-bar 「会话」click goes through `switchToConsoleTab()` (flip tab +
  re-bind), distinct from `enterConsole()` (flip only) used by the explicit selectors — re-binding
  there would double-select. A sidebar **workspace switch** (`selectWorkspace`) also routes through
  `switchToConsoleTab()` — switching the current workspace always lands the view on 「会话」(even
  from the requirement/discussion tab) and force-refreshes that workspace's session list, while
  the session re-bind stays with `consoleEntryTarget` (no new selection strategy). The
  `workspaceSwitchEffects(target, current)` pure decision (`tab-view.ts`) gates it: same workspace →
  no-op; otherwise refresh + enter console. `bindConsoleSession()` runs the pure `consoleEntryTarget(consoleSession,
currentWorkspace, currentSessions)`: re-select the remembered session, else the current workspace's
  first session, else `clearViewedSession()` (empty state — resets `activeSession`/`messages`/
  `taskModel`/… so the comm session never lingers). It skips the send when already viewing the target.
- **Reconnect.** `onReopen` is unchanged: it restores the **active** tab's view (console →
  `select_session`; requirement → `open_requirement_chat`). `consoleSession` is in-memory and survives
  a WS reconnect, so the console tab re-binds correctly when next entered.
- **Tests.** The entry decision is the pure, DOM-free `tab-view.test.ts` (remembered honored / fallback
  to first / empty when no workspace or empty list / remembered honored even if absent from the list);
  the same file covers `workspaceSwitchEffects` (same workspace → no-op / different / from-null →
  force refresh + enter console).

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
  entries are normal context, no longer editable/deletable. The flush is only safe because the server
  broadcasts `idle` **after** the run tears down (`rt.run` nulled), not from the in-run `turn_end`:
  otherwise the flushed `user_prompt` would race the teardown and be rejected with "a turn is already
  running", dropping the queue (session-registry design § `turn_end` → `idle` is held until teardown).
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
  `select_session` for the active workspace/session (or `open_requirement_chat` when the
  requirement view was active). The server's fresh connection re-attaches as a viewer, replays
  `history` + buffered live events, reconciles in_progress requirements (computing runStatus),
  and pushes the enriched requirements list — so both the normal console and the requirement
  view resume correctly without a reload.

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
