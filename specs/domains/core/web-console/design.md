# web-console — Design

Implements the [spec](spec.md). Vue 3 SPA. `web/src/App.vue` is a thin container (state +
WebSocket wiring) that composes presentational components under `web/src/components/`; shared
non-component modules live under `web/src/lib/`, including the WebSocket client `web/src/lib/ws.ts`.
Built with Vite; dev proxy in `web/vite.config.ts`.

> **Note (terminology).** The console's **Intent (意图)** page + list — under `web/src/pages/intents/`
> with `IntentList` — is the domain work-unit entity, renamed from **Requirement (需求)** in the
> requirements→intents rename (PR-2). This is distinct from the lowercase _intent events_ that child
> components emit (a user-action signal, see below): same word, different context. The two are
> unrelated; only the domain entity was renamed.

## Components / structure

App owns all WebSocket state and `client.send`; child components are presentational, taking
props and emitting intent events (App performs every send). All styling is global
(`standard.css` + `style.css`), so components carry no scoped styles.

| Unit              | File                                       | Role                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ----------------- | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| App               | `App.vue`                                  | Container: holds state, owns `client`, runs `handleMessage`, wires children                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| AppHeader         | `components/AppHeader.vue`                 | Top bar: hosts WorkspaceSwitcher (far left), the **project config entry** button (right after WorkspaceSwitcher, opens project-level config for the current workspace, disabled when no workspace is selected), the **tab nav** (data-driven `tabs` → 「会话」/「需求」, active highlighted, disabled until a workspace exists; emits `select-tab`), settings entry, connection status. Carries no session title or permission-mode dropdown — those moved to SessionTitleBar (WC-R9)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| SessionTitleBar   | `components/SessionTitleBar.vue`           | Chat column's title row (top of `.content`): left session title (+ vendor dot), right an optional **same-vendor agent switcher** (BaseDropdown, only when `agentSwitch` is present — WC-R22/AS-R23; emits `set-session-agent`, with an inline 「current agent unavailable」 banner when `agentSwitch.currentUnavailable`) then the permission-mode dropdown. App renders it only on the console tab with an active session (`activeTab === 'console' && hasActiveSession`); presentational, emits `set-mode` / `set-session-agent` (App runs the optimistic `setMode`; `onSetSessionAgent` sends `set_session_agent` and waits for `session_agent_changed`). WC-R9/WC-R22                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| WorkspaceSwitcher | `components/WorkspaceSwitcher.vue`         | Top-bar current-workspace control: trigger shows the current workspace name + `+` (add via `window.prompt`) + `▾`; the popover lists every workspace (name + path), selects one, and removes one (second-confirm). Self-contained popover (pointerdown-capture close, like BaseDropdown); presentational, emits `add/select/remove-workspace`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| SessionList       | `components/SessionList.vue`               | The 「会话」tab's left column — the current workspace's session list (no workspace tree). Rendered only on the console tab (the intent tab's left column is IntentList; both share the right-side chat console). Owns session pagination + prompt/confirm UX, emits session CRUD intents. The header carries only ＋ New session; the intent entry moved to the top-bar tab nav (AppHeader), so SessionList no longer renders the 「需求录入」💡 shortcut (WC-R18)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ChatMessages      | `components/ChatMessages.vue`              | Groups `messages` into render blocks (text / collapsible tool batch), owns expand state + autoscroll. Text blocks delegate rendering to MarkdownText; tool-use/result rows stay verbatim in `<pre class="tool-body">`. A collapsed batch header shows the `Name.count` summary plus a one-line `oneLine(fmt(input))` **preview of the batch's first tool-use** (`Block.preview`, muted `.batch-preview`); it shares `.batch-summary`'s nowrap + ellipsis so overflow truncates with `…`. The preview is **collapsed-only** (an open body already renders each input in full) and is `''` / omitted when the batch has no tool-use (e.g. permission-only) — the header then degrades to the bare summary                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| MarkdownText      | `components/MarkdownText.vue`              | One text message's renderer. Props `{text, kind}`. **Only `kind === 'assistant'`** runs Markdown (module-level `MarkdownIt({html:false,linkify:true,breaks:true})` → `DOMPurify.sanitize` → `v-html` under `.md-body`, a `computed` caches the result); `user`/`system` fall through to escaped plain text. Two-line defense: `html:false` blocks raw HTML, DOMPurify strips anything that slips through. An `afterSanitizeAttributes` hook (registered once) forces external links to `target="_blank" rel="noopener noreferrer"` and drops `javascript:`/`data:` hrefs. Sanitizer allows `class`/`data-language` (Shiki-ready) but no inline style. After mount, code blocks get async Shiki highlighting (`lib/highlight.ts`): built on `shiki/core` + the JavaScript regex engine (`shiki/engine/javascript`, no Oniguruma WASM), grammars loaded lazily from a curated common-language allowlist (`LANG_LOADERS` + aliases; ~29 langs), custom css-vars style theme → strip inline style → token class→`--c-*` color mapping (driven by `[data-theme]`); allowlist-excluded lang / unknown-lang / load fail keeps the original `<pre><code>` intact. Curating the allowlist (vs. the full `bundledLanguages`) keeps the build to ~32 lazy chunks / ~2.8MB instead of ~300 chunks / ~10MB. Non-streaming (whole-message push) so no buffering / unclosed-tag handling needed |
| PermissionPrompt  | `components/PermissionPrompt.vue`          | One permission block. When `actionable`: AskUserQuestion answer panel or allow/deny prompt (owns local answer draft, emits `respond`/`submit-ask`). When undecided-but-not-actionable: a single static history line (no buttons, no verdict)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ConsensusBlock    | `components/ConsensusBlock.vue`            | Read-only render of an auto-resolved multi-agent consensus outcome                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| SessionStatusBar  | `components/SessionStatusBar.vue`          | Thin status line above the input: a single unified status indicator rendered as `<icon> <agent>.<status>` (shared `web/src/lib/status-indicator.ts` — `sessionStatusIndicator` maps running + activity + reconnecting + sideEffectPending to a tone/icon/status-key/optional-agent; `statusIndicator.agentStatus` joins the prefix, dropped with no leftover dot when there's no resolved agent) + Stop button (red square) + refresh button; presentational, emits `refresh` and `stop`. The Stop button is enabled while `running \|\| teamActive` (its `title` distinguishes stop-turn vs end-team) and routes to `stopRun` (WC-R14/R15)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| MessageInput      | `components/MessageInput.vue`              | Prompt textarea + slash-command autocomplete; owns input draft, emits `submit`/`enqueue`/`list-commands`, exposes `prefill(text)`. The textarea is editable whenever a session is active (only `!hasActiveSession` disables it); during an ordinary in-flight turn Send/Enter **enqueues** instead of submitting (`composerAction`), with the Send label fixed (the Stop/End-team control now lives in the status bar, WC-R14). Submit keys: `⌘/Ctrl+Enter`, or two bare `Enter`s within 400ms (skips IME compose & `Shift+Enter`). Hovering Send for 2s shows a send-hint tooltip                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| PendingQueue      | `components/PendingQueue.vue`              | Pending-send queue rendered between SessionStatusBar and MessageInput; lists queued items (text + ✎ edit / 🗑 delete), emits `edit`/`delete`. Presentational; App owns the queue state and flush                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| SettingsPanel     | `components/SettingsPanel.vue`             | System settings page: agent table; owns editable draft seeded from server settings. The agent table's icon column is a manual text input paired with an `EmojiPicker` (both `v-model` the same `a.icon` draft field). Per-project controls (defaultMode, devSkill, rounds, speechChars, consensus) were removed from SettingsPanel and moved to ProjectConfigPage                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| EmojiPicker       | `components/SettingsPanel/EmojiPicker.vue` | Zero-dependency emoji picker for the agent icon field: trigger button + popover (search box + category grid). Self-maintained static emoji list with English keywords for search. `v-model:modelValue` (the agent's `icon` string); click-outside / Esc close; keyboard-reachable native `<button>` cells. Display-only input affordance — writes the picked emoji back to the same `icon` field, no protocol or persistence change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ProjectConfigPage | `pages/projectconfig/ProjectConfig.vue`    | Project settings full-page overlay: edits 5 per-project controls (defaultMode, devSkill, maxRoundsPerStage, maxSpeechChars, consensus{enabled,majority}). Owns editable draft seeded from the `project_config` server reply. Emits `save` → App sends `save_project_config`. Entry button in AppHeader after WorkspaceSwitcher, disabled without a workspace. Follows the same draft-editing pattern as SettingsPanel.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| BaseDropdown      | `components/BaseDropdown.vue`              | Standard custom dropdown (replaces native `<select>`): trigger + popover with icon rows, keyboard nav, click-outside close                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| IntentList        | `components/IntentList.vue`                | Intent view left column: intent list + status filter + row actions (refine/start-dev/dev-detail/set-status/set-automate). Receives full intent list and automation-orchestrator status as props; emits intent events for App to send. Renders each item's lifecycle status badge plus the derived `runStatus` indicator (running green pulse / dangling amber) next to `in_progress` items. Panel is collapsible (narrow view hides secondary fields)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| WS client         | `lib/ws.ts`                                | Opens `ws(s)://<host>/ws`, dispatches parsed `ServerToClient` to a listener, exposes `send(ClientToServer)` + `close()`; heartbeat + auto-reconnect with `onReopen` view recovery                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |

Shared modules: `lib/current-workspace.ts` (`resolveCurrentWorkspace(stored, workspaces)` — pure
current-workspace resolution: keep the persisted choice while it's still listed, else fall back to
the most-recent workspace; unit-tested in `current-workspace.test.ts`), `lib/chat-types.ts`
(`ChatBody`/`ChatMsg`/`Block`/`RunActivity` types), `lib/ask.ts`
(AskUserQuestion parsing + consensus pre-fill), `lib/format.ts` (`fmt`/`oneLine`),
`lib/pending-queue.ts` (pure send-queue logic: `mergeQueue`/`shouldFlush`/`composerAction`/
`appendItem`/`removeItem`/`mergeIntoDraft`, unit-tested in `pending-queue.test.ts`),
`lib/req-list-view.ts` (intent-list pure presentation logic: `statusLabel`/`reqRunStatusLabel`/
`panelToggleLabel`/`rowVisibility`/`showRunStatus`/`compareByCompletion`, unit-tested in
`req-list-view.test.ts`; see _Intent runStatus indicator_ below),
`lib/task-list.ts` (re-exports the task-list model SoT from `@ccc/shared/task-model` —
`TaskItem`/`TaskListModel` types + `emptyTaskModel`/`applyTaskTool`/`isTaskTool`/`TASK_TOOL_NAMES` —
and keeps the DOM-free panel selector `taskPanelView`, unit-tested in `task-list.test.ts`; the model
is now server-derived over the `task_*` wire path, see _Task-list (wire-driven)_ below),
`lib/tab-view.ts` (`SessionRef` + `consoleEntryTarget(remembered, currentWorkspace, sessions)` —
pure console-tab entry decision: honor the remembered session, else the workspace's first, else
empty; unit-tested in `tab-view.test.ts`; see _Per-tab viewed session_ below).

## State (App.vue)

| Ref                    | Type                                    | Purpose                                                                                                                                                                                                                                                                                           |
| ---------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `messages`             | `ChatMsg[]`                             | Ordered render list (WC-R1); passed to ChatMessages                                                                                                                                                                                                                                               |
| `currentWorkspace`     | `string \| null`                        | The single global current workspace path (WC-R8); resolved via `resolveCurrentWorkspace`, persisted to `localStorage`, drives the console tab's session list (`currentSessions` = its `sessionsByWorkspace` slice). Decoupled from `activeWorkspace` (the viewed session's workspace)             |
| `status`               | `connecting` \| `open` \| `closed`      | Connection indicator (WC-R6)                                                                                                                                                                                                                                                                      |
| `sessionStatus`        | `Record<sessionId, SessionStatus>`      | Per-session live status from `ready`/`session_status` (WC-R12)                                                                                                                                                                                                                                    |
| `running`              | computed boolean                        | Viewed session's status ≠ `idle`; enables the status-bar Stop button and switches Send to enqueue (input stays editable; Send copy is fixed) (WC-R2/R14)                                                                                                                                          |
| `pendingQueues`        | `Record<sessionId, PendingItem[]>`      | Per-session client-only send queue (ordinary sessions). Survives session switches; lost on reload. `currentQueue` is the viewed session's slice                                                                                                                                                   |
| `activity`             | `RunActivity`                           | Fine-grained run state of the viewed session, inferred from the stream; drives SessionStatusBar (WC-R15)                                                                                                                                                                                          |
| `mode`                 | `PermissionMode`                        | Current mode; synced from `ready`/`mode_changed` (WC-R4)                                                                                                                                                                                                                                          |
| `actionablePermId`     | computed `string \| null`               | `requestId` of the one permission the user can still act on, or null; derived from `sessionStatus` + transcript (WC-R16)                                                                                                                                                                          |
| `intents`              | `Record<projectPath, Intent[]>`         | Per-project intent lists; updated on `intents` push or `list_intents` reply                                                                                                                                                                                                                       |
| `automation`           | `Record<projectPath, AutomationStatus>` | Per-project automation-orchestrator status; updated on `automation_status` push                                                                                                                                                                                                                   |
| `activeTab`            | `TabKey` (`'console' \| 'intents'`)     | The explicit top-bar tab selection driving which page the content area renders (WC-R18). Backed by the data-driven `HEADER_TABS` list (extensible — a future 「讨论」tab is one more entry + one body branch). Persisted to `localStorage` (key `c3.viewMode`) so a hard refresh restores the tab |
| `intentsProject`       | `string \| null`                        | The project path whose intent page is currently open; persisted alongside `activeTab`                                                                                                                                                                                                             |
| `consoleSession`       | `{workspacePath,sessionId} \| null`     | The 「会话」tab's OWN last-viewed session pointer, independent of the intent tab's comm session — so switching tabs never crosses chat content. Drives `switchToConsoleTab`'s re-bind. In-memory (survives WS reconnect, lost on reload, like the transcript). See _Per-tab viewed session_ below |
| `projectConfigOpen`    | `boolean`                               | Whether the ProjectConfigPage overlay is open; toggled by the AppHeader project-config button. Closed on workspace switch and WS reconnect                                                                                                                                                        |
| `currentProjectConfig` | `ProjectConfig \| null`                 | The last `project_config` reply from the server, seeded into ProjectConfigPage's draft. Cleared on workspace switch and WS reconnect                                                                                                                                                              |

Component-local UI state (not in App): prompt draft + slash menu in MessageInput; tool/batch
expand sets in ChatMessages; per-question answer draft in PermissionPrompt; session-list pagination
in SessionList; editable settings draft in SettingsPanel.

The MessageInput composer textarea **auto-grows** with its draft: a single `watch(input)` resizes it
after every text mutation (typing, voice append, send-queue prefill, slash-command apply, post-send
clear) to the content height, capped at 200px after which it scrolls internally; the CSS `min-height`
floors the single-line idle state. The geometry is the shared pure helper `autoGrowHeight`
(`web/src/lib/textarea.ts`, reused by the discussion create-form textareas).

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
| `intents`                  | replace `intents[projectPath]` with the pushed list (WC-R10)                                                                                       |
| `automation_status`        | replace `automation[projectPath]` with the pushed orchestrator status (WC-R11)                                                                     |
| `project_config`           | set `currentProjectConfig` to the returned config; consumed by ProjectConfigPage's draft watcher                                                   |

## Intent runStatus indicator

Each `Intent` carries a derived `runStatus: 'running' | 'dangling' | 'idle'` field (see
[intent-management design](../core/intent-management/design.md)). The server computes it during
`reconcileInProgress` on `open_intent_chat` entry, caches the result, and enriches every intent
broadcast via `enrichRunStatus`:

- **`running`** — the dev session's process is alive in the runtime registry (`isRunning`). The UI renders a
  green pulsing dot + "运行中" badge next to the lifecycle status.
- **`dangling`** — the dev process is dead but the intent is still `in_progress` (server restart / crash /
  normal exit where the completion judge found it not done). The UI renders an amber dot + "已中断" warning.
- **`idle`** — not `in_progress`, or auto-completed. No runStatus indicator is rendered.
- **Reconnect / hard refresh.** The `onReopen` callback re-sends `open_intent_chat`, which triggers a
  fresh reconcile + `enrichRunStatus` pass. `maybeRestoreIntents` recovers the persisted tab (and its
  project) from `localStorage`. Both paths restore the correct runStatus without user action.
- **Broadcast enrichment.** Every `broadcastIntents` call applies `enrichRunStatus`, which checks live
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

The CSS utility class `status-pulse` (`animation`) is shared with the unified status indicator's
pulsing icon (`.status-icon.spin`, used by `SessionStatusBar.vue` and the DiscussionList row) —
`.req-run-status.running` reuses it for the green pulsing indicator.

## User actions (UI → wire)

| Action                                         | Guard                                                                                                 | Sends                                                                                                                                                                                                                                                      |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `onSubmit(text)`                               | non-empty, client present; reached only when idle or team (WC-R2)                                     | `user_prompt`; optimistically marks viewed session `running`                                                                                                                                                                                               |
| `onEnqueue(text)`                              | ordinary session running (`composerAction`)                                                           | nothing — appends to `pendingQueues[viewed]` (client-only); clears the composer                                                                                                                                                                            |
| `onEditQueued(item)`                           | item in queue                                                                                         | nothing — removes the item and folds its text back into the composer draft (`prefill`)                                                                                                                                                                     |
| `onDeleteQueued(id)`                           | item in queue                                                                                         | nothing — removes the item from the queue                                                                                                                                                                                                                  |
| `flushIfReady()`                               | `shouldFlush(running, teamActive, len)` (edge watch + level re-check in `applyStatuses`)              | merges the viewed session's queue (`\n\n`) → `onSubmit` → clears it                                                                                                                                                                                        |
| `stopRun()`                                    | triggered by the status-bar Stop button; enabled while viewed session running or team active (WC-R14) | `stop_run` (interrupts an ordinary turn, or ends the whole team)                                                                                                                                                                                           |
| `selectWorkspace(path)`                        | path ≠ current (`workspaceSwitchEffects`, WC-R8)                                                      | sets `currentWorkspace` + persists; **force** `list_sessions` for the target (bypasses the `ensureSessions` cache — refreshes only that workspace's slice); then `switchToConsoleTab()` so the view lands on 「会话」and re-binds via `consoleEntryTarget` |
| `addWorkspace(path)` / `removeWorkspace(path)` | switcher `+` / row `✕` (second-confirm) (WC-R8)                                                       | `add_workspace` / `remove_workspace`                                                                                                                                                                                                                       |
| `respond(m, decision)`                         | client present, prompt `actionable` (⇒ `m.decision` null) (WC-R3)                                     | `permission_response`; sets `m.decision` locally                                                                                                                                                                                                           |
| `setMode(next)`                                | client present, value changed                                                                         | optimistic `mode` update + `set_mode` (WC-R4); `next` from BaseDropdown `update:modelValue`                                                                                                                                                                |
| `onSelectTab(key)`                             | top-bar tab click (WC-R18)                                                                            | nothing — `console`→`switchToConsoleTab()` (flip + re-bind console session); `intents`→`openIntents(currentWorkspace)` (no-op without a workspace)                                                                                                         |
| `openIntents(p)`                               | client present                                                                                        | `open_intent_chat` — server replies with comm `session_selected` + `intents`                                                                                                                                                                               |
| `setIntentFilter(s)`                           | `intentsProject` set                                                                                  | `list_intents` with optional status filter                                                                                                                                                                                                                 |
| `refineIntent(id)`                             | client present                                                                                        | `refine_intent`; launches a fresh seeded comm session                                                                                                                                                                                                      |
| `startDevelopment(id)`                         | client present                                                                                        | `start_development` — background dev-skill launch, status flips to `in_progress`                                                                                                                                                                           |
| `setIntentStatus(id,s)`                        | client present                                                                                        | `update_intent_status`; broadcast re-enriches runStatus                                                                                                                                                                                                    |
| `setIntentAutomate(id,bool)`                   | client present                                                                                        | `set_intent_automate`; broadcast re-enriches runStatus                                                                                                                                                                                                     |
| `startAutomation()`                            | `intentsProject` set                                                                                  | `start_automation` — begins the per-project orchestrator loop                                                                                                                                                                                              |
| `stopAutomation()`                             | `intentsProject` set                                                                                  | `stop_automation` — aborts the current orchestration run                                                                                                                                                                                                   |
| `openProjectConfig()`                          | workspace selected                                                                                    | opens ProjectConfigPage overlay; sends `load_project_config` for the current workspace                                                                                                                                                                     |
| `saveProjectConfig(config)`                    | workspace selected                                                                                    | sends `save_project_config` with the project path and edited config; closes ProjectConfigPage                                                                                                                                                              |

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

## Task-list (wire-driven)

A dev session calls the SDK task tools (`TaskCreate` / `TaskList` / `TaskUpdate` / `TaskGet`). Since
2026-06-07-009 the **server** derives the normalized "current task list" and pushes it over an
**independent `task_*` wire path** — the console no longer re-parses `tool_result.content`. The pure
reducer is the single SoT in `@ccc/shared/task-model` (`applyTaskTool`/`emptyTaskModel`/`isTaskTool`/
`TASK_TOOL_NAMES` + types), re-exported by `lib/task-list.ts` which keeps only the DOM-free display
selector `taskPanelView` plus the client-side fold `applyTaskEvent` (both unit-tested in
`task-list.test.ts`).

- **Server derivation.** A `runs.setTaskObserver` hook on the `emit()` fan-out folds task-tool
  `tool_use`/`tool_result` (correlated by `toolUseId`) into a per-session `TaskListModel` and emits a
  `task_list` snapshot on change (Claude has no native task-push event, so the tool stream IS the
  source). Because the snapshot flows through `emit()` it lands in the session buffer ⇒ reconnect
  replays it for free. Cold history replay derives from the baseline transcript
  (`deriveTasksFromHistory`) and is sent right after `session_selected`, before the live buffer tail.
  The reducer rules (snapshot-vs-increment, ordering, tolerance) live in `@ccc/shared/task-model`:
  `TaskList` replaces the whole list (unparseable snapshot keeps current), `TaskGet`/`TaskCreate`
  upsert, `TaskUpdate` prefers result else applies `input` incrementally; `order` = snapshot index /
  `max(order)+1` for inserts / preserved on update; the extractor tolerates several serializations and
  never throws.
- **Client consumption.** App.vue holds the `taskModel` ref, reset on `session_selected`, and folds
  every `task_*` message through the pure `applyTaskEvent(model, msg)` (one `switch`, no inline
  upsert): `task_list` replaces the list wholesale; `task_created`/`task_updated` upsert by `id`
  (preserving an existing entry's `order`, appending unknown ids at `max(order)+1`); `task_deleted`
  removes by id. Ordinary `tool_use`/`tool_result` chat rows are untouched (kept as history); the task
  panel reads `taskModel` via `taskPanelView`.
- **Per-task variants.** `task_created`/`task_updated`/`task_deleted` exist for vendors that push
  single-task updates natively (Codex/OpenCode `onUpdate`, wired later per 2026-06-07-008 §6). The
  Claude path uses `task_list` snapshots only.
- **Capability gating (2026-06-07-010).** The `settings` message carries an optional
  `vendorCapabilities: Record<VendorId, Record<AdapterCapability, boolean>>` (the kernel's binary
  ledger mirrored from `VENDOR_CAPABILITIES`, `sessions` dropped). App.vue derives
  `taskStoreAvailable` from the active vendor's `taskStore` flag and passes it to `TaskPanel`
  (`hasTaskStore`, threaded via `Sessions.vue`/`Intents.vue`); the panel renders only when
  `hasTaskStore && view.visible`. Unknown capabilities (older server with no `vendorCapabilities`,
  comm/pending session with no vendor, or a vendor missing from the ledger) **default open** — never
  wrongly suppressed. All three shipping vendors report `taskStore: true`; the gate exists for future
  vendors without a native task API.

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

## Discussion dispatch status (in-flight / failed)

The discussion chat tail (between ChatMessages and the composer, in `Discussions.vue`) renders the
**transient in-flight status** of the agents the organizer just dispatched, so a viewer sees who is
replying before anything lands in the transcript — and any reply failure that would otherwise be
invisible. Runtime-only: never persisted, never a chat message; the same transient paradigm as
`discussion_run_status`. See the [discussion design](../discussion/design.md) for the engine/wire side.

- **Pure reducers** in `lib/discussion-view.ts` (DOM-free, unit-tested): `applyDispatchStatus(prev, ev)`
  folds a `discussion_dispatch_status` event into a per-discussion `DispatchView` (`{ pending, errors }`)
  — `pending` appends the agents (de-duped by id, arrival order, clearing their stale errors), `cleared`
  removes them, `failed` removes the agent and records a de-duped error. `clearDispatchAgent(prev, id)`
  drops one agent on its reply message (the snappy primary clear, idempotent).
- **App state.** `App.vue` keys `discussionDispatch: Record<id, DispatchView>` off the event; the
  `discussion_message` handler also calls `clearDispatchAgent` (by `speakerAgentId`); the entry is
  dropped on `discussion_run_status: 'ended'` and on `openDiscussion` (switch). `activeDiscussionDispatch`
  feeds the open discussion's view to `Discussions.vue`. Not reconciled on reconnect — it starts empty
  and self-heals, so no stuck pending.
- **Component.** `Discussions.vue` renders, when a discussion is open and the view is non-empty,
  `"<name> is replying…"` per pending agent (a `broadcast` shows several) and `"⚠ <name> failed to
reply: <error>"` per error. UI copy is English (`web/CLAUDE.md`).
- **Tests.** Reducers are covered DOM-free in `discussion-view.test.ts` (pending/cleared/failed, dedup,
  re-dispatch clearing errors, immutability, message-clear idempotency); `Discussions.test.ts` mounts
  the SFC (children stubbed) and asserts the per-agent replying lines, the failure line, and that
  nothing renders when empty / no discussion is open.

## Discussion speaker rendering (multi-speaker chat header)

The discussion right pane reuses `ChatMessages` to render the persisted transcript, so each
`DiscussionMessage` is normalized into a `ChatBody`. The session path maps `user_text` → `user` and
`assistant_text` → `assistant` and never sets any extra meta; the discussion path attaches a small
「icon + name」 line above each body so the multi-agent discussion reads as a real chat — and crucially
the session path keeps its single-speaker layout bit-for-bit.

- **Wire model.** `DiscussionMessage` (`shared/src/protocol.ts`) carries `speakerKind` ∈
  `{organizer, agent, human}`, the participating agent's id (`speakerAgentId`, nullable), and the
  server-resolved display name (`speakerName`, nullable). `AgentConfig.icon` (`shared/src/protocol.ts`)
  is the optional emoji/text set by the operator in the system settings. The web client reads them
  read-only and never pushes back; the SoT is the server-side appender.

- **`ChatBody.speaker`.** A new optional `speaker?: { icon: string; name: string }` field is added to
  the `user` and `assistant` variants of `ChatBody` (`web/src/lib/chat-types.ts`). It is set by the
  discussion path (so the renderer draws the small line) and never by the session path. The field is
  optional and absent on the `system` variant, which the discussion path never produces.

- **Pure resolver** `resolveDiscussionSpeaker(m, agents, defaultAgentId, t)` in
  `web/src/lib/discussion-view.ts` (DOM-free, unit-tested) returns `{ icon, name }` per the rules:
  - `human` → fixed icon `🙋` + i18n `discussion.speaker.you` (= "You"). Humans have no agent
    profile, so there is nothing to look up.
  - `organizer` → `agents.find(a => a.id === defaultAgentId)` (server-side `resolveAgent(null)`).
    Hit: `{ icon: agent.icon?.trim() || '🤖', name: agent.name }`. Miss / empty icon / null id:
    `{ icon: '🤖', name: t('discussion.speaker.organizer') }`.
  - `agent` → `agents.find(a => a.id === m.speakerAgentId)`. Hit: `{ icon: agent.icon?.trim() || '🤖',
name: m.speakerName ?? agent.name }`. Miss / empty icon: `{ icon: '🤖', name: m.speakerName ||
t('discussion.speaker.agent') }` (defensive — the server should always set a name for an agent
    turn).

  The two fallback icons are module-private constants (`HUMAN_FALLBACK_ICON`, `AGENT_FALLBACK_ICON`).
  Whitespace-only icons (operator typo) are trimmed and treated as empty. The resolver never throws
  and never returns an empty icon, so a fresh `serverSettings === null` on first paint degrades to the
  generic icons + i18n role labels without rendering errors.

- **Mapper change.** `discussionMessageToChat(m, agents, defaultAgentId, t)` and
  `discussionMessagesToChat(messages, agents, defaultAgentId, t)` now take the agent roster and
  default id (plus the typed `t`) and attach the resolved `speaker` to the returned `ChatBody`. The
  body text is **never** prefixed with `speakerName: ` — the name lives on the speaker line, so the
  body is verbatim content. Both call sites in `App.vue` (`discussion_detail` snapshot path and
  `discussion_message` live-append path) pass `serverSettings.value?.agents ?? []` and
  `serverSettings.value?.defaultAgentId ?? SYSTEM_AGENT_ID`; the resolver handles null and the
  early-paint window without special casing.

- **Renderer.** `ChatMessages.vue` renders, in the `text` block, a `<div class="speaker">` (icon +
  name) above the existing `<MarkdownText>` body **only when `b.msg.speaker` is set**. The template
  re-narrows `b.msg` to `user | assistant` first so the `speaker` access is type-safe; the `system`
  variant is left header-less. The scoped style uses `--c-text-muted` + `--fs-caption` (the project's
  caption token) for a small muted row; session bubbles are untouched.

- **Tests.** The pure resolver is covered DOM-free in `discussion-view.test.ts` (human, organizer
  hit, organizer miss, organizer default-id null, agent hit, agent hit with blank icon, agent
  miss, agent miss with null name, blank-icon trim). The `discussionMessageToChat` / `ToChat` cases
  assert: body text is verbatim (no `name: ` prefix), `speaker` is set with the right icon/name per
  speakerKind, and the batched mapper preserves order. The five-branch coverage matches the spec
  acceptance criteria (organizer/agent/human all show their own row; agent without icon → default
  icon, no error; body never carries a `name: ` prefix).

## Per-tab viewed session (no cross-tab pollution)

The 「会话」(console) and 「需求」(intents) tabs each maintain their **own** current
session; switching tabs renders the chat column from that tab's session, never the other's.
Previously a single global `activeSession`/`messages` served both: entering the intent tab
selected its comm session into the global state, and switching back left the console tab showing
the comm session's chat (cross-talk).

- **Why re-select, not cache.** The server streams live events to only the connection's
  currently-viewed session, so a cached `messages` for the non-viewed tab would go stale. Switching
  back therefore re-`select_session`s (replaying `history` + buffered tail) — the same recovery the
  reconnect path uses. The intent tab re-sends `open_intent_chat`, which the server resolves
  to the project's `is_current` comm session; no client-side comm pointer is needed.
- **`consoleSession` pointer.** The console tab's own `{workspacePath, sessionId}` (or null). It is
  recorded in `session_selected` **only while `activeTab === 'console'`** — comm-session selections
  (open/new/refine intent chat) always arrive while the intent tab is active, so they never
  pollute it. The explicit selectors (`selectSession`/`openDevSession`) also pin it up front (covers
  `selectSession`'s already-viewing early-return). `deleteSession` clears it when the deleted session
  was the pointer, so the next entry falls back.
- **Tab-switch wiring.** The top-bar 「会话」click goes through `switchToConsoleTab()` (flip tab +
  re-bind), distinct from `enterConsole()` (flip only) used by the explicit selectors — re-binding
  there would double-select. A sidebar **workspace switch** (`selectWorkspace`) also routes through
  `switchToConsoleTab()` — switching the current workspace always lands the view on 「会话」(even
  from the intent/discussion tab) and force-refreshes that workspace's session list, while
  the session re-bind stays with `consoleEntryTarget` (no new selection strategy). The
  `workspaceSwitchEffects(target, current)` pure decision (`tab-view.ts`) gates it: same workspace →
  no-op; otherwise refresh + enter console. `bindConsoleSession()` runs the pure `consoleEntryTarget(consoleSession,
currentWorkspace, currentSessions)`: re-select the remembered session, else the current workspace's
  first session, else `clearViewedSession()` (empty state — resets `activeSession`/`messages`/
  `taskModel`/… so the comm session never lingers). It skips the send when already viewing the target.
- **Reconnect.** `onReopen` is unchanged: it restores the **active** tab's view (console →
  `select_session`; intent → `open_intent_chat`). `consoleSession` is in-memory and survives
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
  `select_session` for the active workspace/session (or `open_intent_chat` when the
  intent view was active). The server's fresh connection re-attaches as a viewer, replays
  `history` + buffered live events, reconciles in_progress intents (computing runStatus),
  and pushes the enriched intents list — so both the normal console and the intent
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
