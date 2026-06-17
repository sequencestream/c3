# web-console — Design

Implements the [spec](web-console-spec.md). A Vue 3 single-page app. One thin container holds all client
state and the WebSocket wiring and composes a set of presentational components; shared
non-component helper modules (pure view logic, the WebSocket client) live alongside them. Built
with Vite, whose dev server proxies the WebSocket to the running server.

> **Note (terminology).** The console's **Intent (意图)** page + list is the domain work-unit
> entity, renamed from **Requirement (需求)** in the requirements→intents rename (PR-2). This is
> distinct from the lowercase _intent events_ that child components emit (a user-action signal,
> see below): same word, different context. The two are unrelated; only the domain entity was
> renamed.

## Components / structure

The container owns all WebSocket state and the single send path; child components are
presentational, taking props and emitting user-action events (the container performs every
send). Styling is global, so components carry no scoped styles.

| Unit                   | Role                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| App container          | Holds state, owns the WebSocket client, dispatches every inbound wire event, and wires children                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| App header             | Top bar: hosts the workspace switcher (far left), the **project config entry** button (right after the switcher, opens project-level config for the current workspace, disabled when no workspace is selected), the **tab nav** (data-driven 「会话」/「需求」, active highlighted, disabled until a workspace exists), the settings entry, and the connection status. Carries no session title or permission-mode dropdown — those moved to the session title bar (WC-R9)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Session title bar      | Chat column's title row: left session title (+ vendor dot), right an optional **same-vendor agent switcher** (only when switch candidates are present — WC-R22/AS-R23, with an inline 「current agent unavailable」 banner when the current agent is unavailable) then the permission-mode dropdown. Shown only on the console tab with an active session; presentational, signalling mode change / agent switch (the container runs the optimistic mode change; an agent switch sends `set_session_agent` and waits for `session_agent_changed`). WC-R9/WC-R22                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Workspace switcher     | Top-bar current-workspace control: trigger shows the current workspace name + add + open-list affordances; the popover lists every workspace (name + path), selects one, and removes one (second-confirm). Self-contained popover (pointer-capture close); presentational, signalling add/select/remove workspace                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Session list           | The 「会话」tab's left column — the current workspace's session list (no workspace tree). Rendered only on the console tab (the intent tab's left column is the intent list; both share the right-side chat console). Owns session pagination + prompt/confirm UX, signalling session create/rename/delete. The header carries only ＋ New session; the intent entry moved to the top-bar tab nav, so the session list no longer renders the 「需求录入」💡 shortcut (WC-R18)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Chat messages          | Groups the rendered stream into render blocks (text / collapsible tool batch), owns expand state + autoscroll. Text blocks delegate to the Markdown text renderer; tool-use/result rows stay verbatim, with code/tool bodies constrained to local horizontal scrolling so narrow screens never widen the chat column. A collapsed batch header shows the name + count summary plus a one-line preview of the batch's first tool-use, sharing the summary's nowrap + ellipsis so overflow truncates. The preview is **collapsed-only** (an open body already renders each input in full) and is omitted when the batch has no tool-use (e.g. permission-only) — the header then degrades to the bare summary                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Markdown text          | One text message's renderer. Only **assistant** text is rendered as Markdown (sanitized, no raw HTML — the parser disables raw HTML and a sanitizer strips anything that slips through); user/system text falls through to escaped plain text. A sanitizer hook forces external links to open in a new tab with `noopener noreferrer` and drops `javascript:`/`data:` hrefs. The sanitizer allows the class/language attributes needed for highlighting but no inline style. Markdown tables are wrapped so wide tables scroll locally instead of expanding the message. After mount, code blocks get async syntax highlighting using a regex-engine highlighter (no WASM), with grammars loaded lazily from a curated common-language allowlist (~29 langs) and theme colors mapped to design tokens driven by the active theme; an excluded/unknown lang or a load failure keeps the original code block intact. Curating the allowlist (vs. the full bundle) keeps the build small (~32 lazy chunks / ~2.8MB instead of ~300 chunks / ~10MB). Rendering is non-streaming (whole-message) so no buffering / unclosed-tag handling is needed |
| Permission prompt      | One permission block. When actionable: an AskUserQuestion answer panel or an allow/deny prompt (owns local answer draft, signalling respond / submit-ask). When undecided-but-not-actionable: a single static history line (no buttons, no verdict)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Consensus block        | Read-only render of an auto-resolved multi-agent consensus outcome                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Session status bar     | Thin status line above the input: a single unified status indicator rendered as icon + agent + status (a shared pure helper maps running + activity + reconnecting + side-effect-pending to a tone/icon/status-key/optional-agent; the agent prefix is dropped cleanly with no leftover separator when there is no resolved agent) + Stop button (red square) + refresh button; presentational, signalling refresh and stop. The Stop button is enabled while running or a team is active (its tooltip distinguishes stop-turn vs end-team) and routes to the stop-run action (WC-R14/R15)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Message input          | Prompt textarea + slash-command autocomplete; owns the input draft, signalling submit / enqueue / list-commands, and exposes a prefill capability. The textarea is editable whenever a session is active (only the no-active-session case disables it); during an ordinary in-flight turn Send/Enter **enqueues** instead of submitting, with the Send label fixed (the Stop/End-team control now lives in the status bar, WC-R14). Submit keys: `⌘/Ctrl+Enter`, or two bare `Enter`s within 400ms (skips IME compose & `Shift+Enter`). Hovering Send for 2s shows a send-hint tooltip. On narrow screens the footer is safe-area aware, keeps 48px+ touch targets, and tracks the visual viewport so the composer and slash menu stay above the soft keyboard/home indicator without changing desktop layout                                                                                                                                                                                                                                                                                                                                 |
| Pending queue          | Pending-send queue rendered between the status bar and the message input; lists queued items (text + ✎ edit / 🗑 delete), signalling edit/delete. Presentational; the container owns the queue state and flush                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Settings panel         | System settings page: the agent table; owns an editable draft seeded from server settings. The agent table's icon column is a manual text input paired with an emoji picker (both bound to the same icon draft field). Per-project controls (default mode, dev skill, rounds, speech chars, consensus) were removed from the settings panel and moved to the workspace-setting page                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Emoji picker           | Zero-dependency emoji picker for the agent icon field: trigger button + popover (search box + category grid). Self-maintained static emoji list with English keywords for search. Bound to the agent's icon string; click-outside / Esc close; keyboard-reachable native cells. A display-only input affordance — writes the picked emoji back to the same icon field, no protocol or persistence change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Workspace-setting page | Workspace-setting full-page overlay: edits 7 per-project controls (default mode, dev skill, max rounds per stage, max speech chars, consensus enabled/majority, git branch mode, default main branch). Owns an editable draft seeded from the `workspace_setting` server reply; a detected-main-branch value (the reply's server-probed default branch) pre-fills the default main branch when no saved value exists. Saving sends `save_workspace_setting`. Entered from the app header after the workspace switcher, disabled without a workspace. Follows the same draft-editing pattern as the settings panel.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Base dropdown          | Standard custom dropdown (replaces the native one): trigger + popover with icon rows, keyboard nav, click-outside close                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Intent list            | Intent view left column: intent list + status filter + row actions (refine / start-dev / dev-detail / set-status / set-automate). Receives the full intent list and the automation-orchestrator status as props; signalling intent actions for the container to send. Renders each item's lifecycle status badge plus the derived run-status indicator (running green pulse / dangling amber) next to in-progress items. The panel is collapsible (narrow view hides secondary fields)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| WebSocket client       | Opens the WebSocket to `/ws`, dispatches parsed server-to-client messages to a listener, exposes a send for client-to-server messages plus close; heartbeat + auto-reconnect with a reopen view-recovery callback                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

Shared helper modules provide pure, DOM-free, unit-tested logic for: current-workspace
resolution (keep the persisted choice while it's still listed, else fall back to the most-recent
workspace); the chat view-model types; AskUserQuestion parsing + consensus pre-fill; JSON-pretty
and one-line formatting of tool inputs; send-queue logic (merge / should-flush / composer-action /
append / remove / merge-into-draft); intent-list presentation logic (status labels, run-status
labels, panel-toggle label, row visibility, completion sort — see _Intent runStatus indicator_
below); the task-list model (re-exporting the shared task-model source of truth — types plus the
pure reducer and tool-name set — and adding the DOM-free panel display selector; the model is now
server-derived over the `task_*` wire path, see _Task-list (wire-driven)_ below); and the
console-tab entry decision (honor the remembered session, else the workspace's first, else empty —
see _Per-tab viewed session_ below).

## State (container)

| State                     | Purpose                                                                                                                                                                                                                                                                                    |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Rendered messages         | Ordered render list (WC-R1); passed to the chat messages view                                                                                                                                                                                                                              |
| Current workspace         | The single global current workspace path (WC-R8); resolved from the persisted choice or most-recent, persisted locally, drives the console tab's session list (its slice of the per-workspace sessions). Decoupled from the viewed session's workspace                                     |
| Connection status         | Connection indicator — connecting / open / closed (WC-R6)                                                                                                                                                                                                                                  |
| Per-session status        | Per-session live status from the `ready` / `session_status` events (WC-R12)                                                                                                                                                                                                                |
| Running (derived)         | Viewed session's status ≠ idle; enables the status-bar Stop button and switches Send to enqueue (input stays editable; Send copy is fixed) (WC-R2/R14)                                                                                                                                     |
| Pending queues            | Per-session client-only send queue (ordinary sessions). Survives session switches; lost on reload. The viewed session's slice is the current queue                                                                                                                                         |
| Run activity              | Fine-grained run state of the viewed session, inferred from the stream; drives the status bar (WC-R15)                                                                                                                                                                                     |
| Mode                      | Current vendor-native mode token; synced from session selection / `mode_changed` (WC-R4). Interpreted via the active session's vendor catalog                                                                                                                                              |
| Mode options (derived)    | Options for the mode dropdown, derived from the active session's vendor mode catalog (from `settings.vendorModes`). Falls back to the built-in Claude mode list when the vendor catalog is not yet loaded                                                                                  |
| Vendor modes              | Per-vendor mode catalogs (2026-06-07-012), seeded from `settings.vendorModes`. Drives per-vendor mode options in the picker                                                                                                                                                                |
| Actionable permission     | Request id of the one permission the user can still act on, or none; derived from per-session status + transcript (WC-R16)                                                                                                                                                                 |
| Intents                   | Per-project intent lists; updated on an `intents` push or a `list_intents` reply                                                                                                                                                                                                           |
| Automation                | Per-project automation-orchestrator status; updated on an `automation_status` push                                                                                                                                                                                                         |
| Active tab                | The explicit top-bar tab selection driving which page the content area renders (WC-R18). Backed by a data-driven tab list (extensible — a future 「讨论」tab is one more entry + one body branch). Persisted locally (key `c3.viewMode`) so a hard refresh restores the tab                |
| Intents project           | The project path whose intent page is currently open; persisted alongside the active tab                                                                                                                                                                                                   |
| Console session           | The 「会话」tab's OWN last-viewed session pointer, independent of the intent tab's comm session — so switching tabs never crosses chat content. Drives the console-tab re-bind. In-memory (survives WS reconnect, lost on reload, like the transcript). See _Per-tab viewed session_ below |
| Workspace-setting open    | Whether the workspace-setting overlay is open; toggled by the app-header workspace-setting button. Closed on workspace switch and WS reconnect                                                                                                                                             |
| Current workspace-setting | The last `workspace_setting` reply from the server, seeded into the workspace-setting draft. Cleared on workspace switch and WS reconnect                                                                                                                                                  |
| Detected main branch      | The server-probed default branch carried on the `workspace_setting` reply; passed to the workspace-setting page to pre-fill the default main branch when no saved value exists. Cleared on workspace switch and WS reconnect                                                               |

Component-local UI state (not in the container): prompt draft + slash menu in the message input;
tool/batch expand sets in the chat messages view; per-question answer draft in the permission
prompt; session-list pagination in the session list; editable settings draft in the settings
panel.

The message-input composer textarea **auto-grows** with its draft: a watch on the draft resizes it
after every text mutation (typing, voice append, send-queue prefill, slash-command apply, post-send
clear) to the content height, capped at 200px after which it scrolls internally; the CSS min-height
floors the single-line idle state. The geometry is a shared pure helper (also reused by the
discussion create-form textareas).

A rendered chat message is a discriminated union over its kind: user · assistant · tool-use ·
tool-result · permission · consensus · system, each with a numeric id.

## Event handling (wire → UI)

Inbound dispatch switches on the message type:

| Wire event                 | UI effect                                                                                                                                                   |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ready`                    | set mode; seed per-session status from `statuses`; resolve the current workspace (persisted → most-recent) and `list_sessions` for it (WC-R8)               |
| `workspaces`               | replace the workspace list; if the current workspace was removed, fall back to the most-recent and load the new one's sessions (WC-R8)                      |
| `session_status`           | replace per-session status; notify on background `awaiting_permission` (WC-R13)                                                                             |
| `mode_changed`             | set mode                                                                                                                                                    |
| `session_selected`         | clear stream, render `history`, seed the session's status from `status` (locks composer at once); buffer tail follows as live events (WC-R9)                |
| `user_text`                | append user message                                                                                                                                         |
| `assistant_text`           | append assistant message                                                                                                                                    |
| `tool_use` / `tool_result` | append tool-use / tool-result message                                                                                                                       |
| `permission_request`       | append permission message undecided (live or replayed alike; actionability is derived, see below)                                                           |
| `consensus_auto`           | append consensus message                                                                                                                                    |
| `turn_end`                 | append a system note only on `error`; running unlocks via `session_status` (WC-R5)                                                                          |
| `intents`                  | replace the project's intent list with the pushed list (WC-R10)                                                                                             |
| `automation_status`        | replace the project's automation-orchestrator status with the pushed status (WC-R11)                                                                        |
| `workspace_setting`        | set the current workspace-setting to the returned config and the detected main branch to the reply's probed branch; consumed by the workspace-setting draft |

## Intent runStatus indicator

Each intent carries a derived run-status field — running / dangling / idle (see
[intent-management design](../intent-management/intent-management-design.md)). The server computes it during the
in-progress reconcile on intent-chat entry, caches the result, and enriches every intent broadcast:

- **running** — the dev session's process is alive in the runtime registry. The UI renders a green
  pulsing dot + "运行中" badge next to the lifecycle status.
- **dangling** — the dev process is dead but the intent is still in_progress (server restart / crash /
  normal exit where the completion judge found it not done). The UI renders an amber dot + "已中断" warning.
- **idle** — not in_progress, or auto-completed. No run-status indicator is rendered.
- **Reconnect / hard refresh.** The reopen callback re-sends `open_intent_chat`, which triggers a
  fresh reconcile + enrichment pass, and the persisted tab (and its project) is recovered from local
  storage. Both paths restore the correct run-status without user action.
- **Broadcast enrichment.** Every intent broadcast applies the enrichment, which checks the live
  process first, then falls back to the reconcile cache. So incremental status changes (a dev session
  completes, the orchestrator progresses) also reflect the correct run-status on all connections.

The pure display logic provides: a lifecycle status label (`draft`→`草稿` …), a derived run-status
label (`running`→`运行中` …), a non-idle run-status predicate, the collapse button label reflecting
the target state, secondary-field visibility in collapsed mode, and a done-items completion sort
(completedAt desc, then priority).

A shared pulse animation is used by both the unified status indicator's pulsing icon (the status
bar and the discussion list row) and the green pulsing run-status indicator.

## User actions (UI → wire)

| Action                 | Guard                                                                                                             | Sends                                                                                                                                                                                                                   |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Submit                 | non-empty, connected; reached only when idle or team (WC-R2)                                                      | `user_prompt`; optimistically marks the viewed session running                                                                                                                                                          |
| Enqueue                | ordinary session running (composer action)                                                                        | nothing — appends to the viewed session's pending queue (client-only); clears the composer                                                                                                                              |
| Edit queued            | item in queue                                                                                                     | nothing — removes the item and folds its text back into the composer draft                                                                                                                                              |
| Delete queued          | item in queue                                                                                                     | nothing — removes the item from the queue                                                                                                                                                                               |
| Flush if ready         | should-flush (idle + non-empty; edge watch + level re-check on every status apply)                                | merges the viewed session's queue (blank-line joined) → submit → clears it                                                                                                                                              |
| Stop run               | triggered by the status-bar Stop button; enabled while the viewed session is running or a team is active (WC-R14) | `stop_run` (interrupts an ordinary turn, or ends the whole team)                                                                                                                                                        |
| Select workspace       | path ≠ current (WC-R8)                                                                                            | sets current workspace + persists; **force** `list_sessions` for the target (bypasses the sessions cache — refreshes only that workspace's slice); then switches to 「会话」and re-binds via the console-entry decision |
| Add / remove workspace | switcher add / row remove (second-confirm) (WC-R8)                                                                | `add_workspace` / `remove_workspace`                                                                                                                                                                                    |
| Respond                | connected, prompt actionable (⇒ undecided) (WC-R3)                                                                | `permission_response`; sets the decision locally                                                                                                                                                                        |
| Set mode               | connected, value changed                                                                                          | optimistic mode update + `set_mode` (WC-R4)                                                                                                                                                                             |
| Select tab             | top-bar tab click (WC-R18)                                                                                        | nothing — console → switch to 「会话」(flip + re-bind console session); intents → open the intent chat (no-op without a workspace)                                                                                      |
| Open intents           | connected                                                                                                         | `open_intent_chat` — server replies with comm `session_selected` + `intents`                                                                                                                                            |
| Set intent filter      | intents project set                                                                                               | `list_intents` with optional status filter                                                                                                                                                                              |
| Refine intent          | connected                                                                                                         | `refine_intent`; launches a fresh seeded comm session                                                                                                                                                                   |
| Start development      | connected                                                                                                         | `start_development` — background dev-skill launch, status flips to in_progress                                                                                                                                          |
| Set intent status      | connected                                                                                                         | `update_intent_status`; broadcast re-enriches run-status                                                                                                                                                                |
| Set intent automate    | connected                                                                                                         | `set_intent_automate`; broadcast re-enriches run-status                                                                                                                                                                 |
| Start automation       | intents project set                                                                                               | `start_automation` — begins the per-project orchestrator loop                                                                                                                                                           |
| Stop automation        | intents project set                                                                                               | `stop_automation` — aborts the current orchestration run                                                                                                                                                                |
| Open workspace setting | workspace selected                                                                                                | opens the workspace-setting overlay; sends `load_workspace_setting` for the current workspace                                                                                                                           |
| Save workspace setting | workspace selected                                                                                                | sends `save_workspace_setting` with the project path and edited config; closes the workspace-setting overlay                                                                                                            |

## Permission actionability (live vs. replayed)

The server does **not** persist permission decisions, and session selection replays the runtime
buffer — including past `permission_request` events — as ordinary live events. So a refresh or
session switch rebuilds every historical permission undecided, identical on the wire to a fresh
request. To avoid re-offering resolved prompts as actionable cards, the client derives
actionability rather than trusting the undecided state alone (WC-R16):

- The actionable permission is the single permission the user can still act on, or none. A permission
  is actionable **iff** the viewed session is `awaiting_permission` **and** it is the latest still-undecided
  permission in the transcript. The SDK blocks on one permission at a time, so that latest undecided one is
  the genuinely pending request; everything earlier (or anything replayed once the session moved on) is
  non-actionable. The decision lives in a pure helper.
- The permission prompt renders three states: **actionable** → interactive card (buttons); decided →
  decision verdict (live feedback after the user answers this session); undecided-but-not-actionable →
  a single **static history line** (no buttons, no verdict).
- This keeps a genuinely-pending permission answerable after a refresh (it stays the latest undecided
  one while `awaiting_permission`), while resolved history degrades to a static record.
- The chat messages view forces a tool batch open only for the actionable permission, not for replayed
  static ones.

## Task-list (wire-driven)

A dev session calls the SDK task tools (`TaskCreate` / `TaskList` / `TaskUpdate` / `TaskGet`). Since
2026-06-07-009 the **server** derives the normalized "current task list" and pushes it over an
**independent `task_*` wire path** — the console no longer re-parses tool-result content. The pure
reducer is the single source of truth in the shared task model (the reducer, the empty model, the
tool-name predicate and set, plus types); the client task-list module re-exports it and keeps only
the DOM-free display selector plus the client-side fold that applies one task event (all unit-tested
DOM-free).

- **Server derivation.** A task-observer hook on the event fan-out folds task-tool tool-use /
  tool-result (correlated by tool-use id) into a per-session task-list model and emits a `task_list`
  snapshot on change (Claude has no native task-push event, so the tool stream IS the source). Because
  the snapshot flows through the event path it lands in the session buffer ⇒ reconnect replays it for
  free. Cold history replay derives from the baseline transcript and is sent right after session
  selection, before the live buffer tail. The reducer rules (snapshot-vs-increment, ordering, tolerance)
  live in the shared task model: `TaskList` replaces the whole list (unparseable snapshot keeps current),
  `TaskGet`/`TaskCreate` upsert, `TaskUpdate` prefers result else applies the input incrementally; order =
  snapshot index / max+1 for inserts / preserved on update; the extractor tolerates several serializations
  and never throws.
- **Client consumption.** The container holds the task model, reset on session selection, and folds
  every `task_*` message through the pure fold (one switch, no inline upsert): `task_list` replaces the
  list wholesale; `task_created`/`task_updated` upsert by id (preserving an existing entry's order,
  appending unknown ids at max+1); `task_deleted` removes by id. Ordinary tool-use/tool-result chat rows
  are untouched (kept as history); the task panel reads the task model via the display selector.
- **Per-task variants.** `task_created`/`task_updated`/`task_deleted` exist for vendors that push
  per-task deltas; the Claude path uses `task_list` snapshots only.
- **Capability gating (2026-06-07-010).** The `settings` message carries an optional
  `vendorCapabilities` (the kernel's per-vendor binary capability ledger). The container derives a
  task-store-available flag from the active vendor's task-store capability and passes it to the task
  panel; the panel renders only when the task store is available and the panel view is visible. Unknown
  capabilities (older server with no capability ledger, comm/pending session with no vendor, or a vendor
  missing from the ledger) **default open** — never wrongly suppressed. All three shipping vendors report
  task-store support; the gate exists for future vendors without a native task API.

### Task panel

A read-only, resident panel between the chat messages and the status bar renders the viewed
session's live tasks. Display rules are a pure selector (current list, recent-completed count):

- **Grouping & order.** Three groups, each ascending by order: in_progress on top (highlighted),
  pending in the middle, completed at the bottom (✓, struck-through / greyed).
- **Truncation.** Completed keeps only the most recent N (highest-order) entries, still ascending; the
  rest are counted and shown as a "+N 已完成" hint.
- **Visibility.** Visible is true only when an in_progress or pending task exists; an all-completed or
  empty list hides the whole panel. The component is the selector's conditional render.
- The user never edits tasks here — status is driven solely by the agent's tool calls.
- **Tests.** The selector is covered DOM-free; the panel additionally has a mounted component test —
  see _Testing_ below.

## Discussion agenda progress

The discussion detail (the discussion branch of the content area, between the session title bar and
the chat messages) renders the organizer engine's **explicit agenda** for the open discussion: the
ordered subtopic list, the current subtopic, and overall completion. It reads straight from the
active discussion (its agenda list + agenda index); no new container state or wire handling — see the
[discussion design](../discussion/discussion-design.md) for the agenda model.

- **Pure selector.** A DOM-free, unit-tested selector folds the discussion into visibility, items,
  current, completed, total, percent, and complete. The 0-based agenda index is the single source of
  completion (items before it done, the item at it current, the rest upcoming); it is clamped to the
  valid range so a stale/garbage index can never produce a negative percent or an out-of-range current.
  An empty agenda ⇒ not visible; a complete agenda (index === length) ⇒ no current, 100%, every item done.
- **Component.** The agenda progress is the selector's conditional render (renders nothing until the
  engine sets an agenda): a header (completed/total + percent) + a progress bar + one row per subtopic
  with a status mark (✓ done / ▶ current / ○ upcoming), reusing the task-panel visual language (current
  highlighted, done struck-through/greyed). UI copy is English.
- **Live update.** The agenda re-renders reactively as the prop changes: the engine fires its
  status-change hook on every `set_agenda`/`focus_subtopic` → `discussions` broadcast → the container's
  discussions handler refreshes the active discussion (the per-message announcement carries no agenda
  fields, so the list push is what moves the bar). The discussion detail seeds the initial agenda.
- **Tests.** The selector is covered DOM-free (hidden / partial / complete / index clamping); a mounted
  component test asserts the rows, marks, count/percent, bar width, visibility, and live re-render on
  index advancing.

## Discussion dispatch status (in-flight / failed)

The discussion chat tail (between the chat messages and the composer) renders the **transient
in-flight status** of the agents the organizer just dispatched, so a viewer sees who is replying
before anything lands in the transcript — and any reply failure that would otherwise be invisible.
Runtime-only: never persisted, never a chat message; the same transient paradigm as the discussion
run status. See the [discussion design](../discussion/discussion-design.md) for the engine/wire side.

- **Pure reducers** (DOM-free, unit-tested): one folds a `discussion_dispatch_status` event into a
  per-discussion dispatch view (pending agents + errors) — pending appends the agents (de-duped by id,
  arrival order, clearing their stale errors), cleared removes them, failed removes the agent and
  records a de-duped error; another drops one agent on its reply message (the snappy primary clear,
  idempotent).
- **Container state.** A per-discussion dispatch view is keyed off the event; the `discussion_message`
  handler also clears the speaking agent; the entry is dropped on a discussion run-status of ended and
  on opening (switching) a discussion. The open discussion's view feeds the renderer. Not reconciled on
  reconnect — it starts empty and self-heals, so no stuck pending.
- **Component.** When a discussion is open and the view is non-empty, renders "<name> is replying…" per
  pending agent (a broadcast shows several) and "⚠ <name> failed to reply: <error>" per error. UI copy
  is English.
- **Tests.** Reducers are covered DOM-free (pending/cleared/failed, dedup, re-dispatch clearing errors,
  immutability, message-clear idempotency); a mounted component test asserts the per-agent replying
  lines, the failure line, and that nothing renders when empty / no discussion is open.

## Discussion speaker rendering (multi-speaker chat header)

The discussion right pane reuses the chat messages view to render the persisted transcript, so each
discussion message is normalized into a chat body. The session path maps `user_text` → user and
`assistant_text` → assistant and never sets any extra meta; the discussion path attaches a small
「icon + name」 line above each body so the multi-agent discussion reads as a real chat — and crucially
the session path keeps its single-speaker layout bit-for-bit.

- **Wire model.** A discussion message carries a speaker kind ∈ {organizer, agent, human}, the
  participating agent's id (nullable), and the server-resolved display name (nullable). An agent's icon
  is the optional emoji/text set by the operator in the system settings. The web client reads them
  read-only and never pushes back; the source of truth is the server-side appender.

- **Speaker on the chat body.** An optional speaker (icon + name) is carried on the user and assistant
  chat-body variants. It is set by the discussion path (so the renderer draws the small line) and never
  by the session path. The field is optional and absent on the system variant, which the discussion path
  never produces.

- **Pure resolver** (DOM-free, unit-tested) returns icon + name per the rules:
  - human → fixed icon 🙋 + the localized "You" label. Humans have no agent profile, so there is nothing
    to look up.
  - organizer → look up the default agent (the server-side organizer agent). Hit: the agent's icon (or 🤖
    fallback) + the agent's name. Miss / empty icon / null id: 🤖 + the localized organizer label.
  - agent → look up the message's agent id. Hit: the agent's icon (or 🤖 fallback) + the message's speaker
    name or the agent's name. Miss / empty icon: 🤖 + the message's speaker name or the localized agent
    label (defensive — the server should always set a name for an agent turn).

  The two fallback icons are module-private constants. Whitespace-only icons (operator typo) are trimmed
  and treated as empty. The resolver never throws and never returns an empty icon, so a fresh,
  no-settings-yet first paint degrades to the generic icons + localized role labels without rendering
  errors.

- **Mapper change.** The single-message and batched discussion-to-chat mappers take the agent roster and
  default id (plus the typed localizer) and attach the resolved speaker to the returned chat body. The
  body text is **never** prefixed with the speaker name — the name lives on the speaker line, so the body
  is verbatim content. Both call sites in the container (the discussion-detail snapshot path and the
  live-append path) pass the current agent roster and default agent id; the resolver handles the
  no-settings and early-paint window without special casing.

- **Renderer.** The chat messages view renders, in the text block, a speaker line (icon + name) above
  the existing body **only when a speaker is set**. The template re-narrows to user/assistant first so the
  speaker access is type-safe; the system variant is left header-less. The styling uses the muted-text and
  caption-size design tokens for a small muted row; session bubbles are untouched.

- **Tests.** The pure resolver is covered DOM-free (human, organizer hit, organizer miss, organizer
  default-id null, agent hit, agent hit with blank icon, agent miss, agent miss with null name, blank-icon
  trim). The mapper cases assert: body text is verbatim (no name prefix), speaker is set with the right
  icon/name per speaker kind, and the batched mapper preserves order. The five-branch coverage matches the
  spec acceptance criteria (organizer/agent/human all show their own row; agent without icon → default
  icon, no error; body never carries a name prefix).

## Per-tab viewed session (no cross-tab pollution)

The 「会话」(console) and 「需求」(intents) tabs each maintain their **own** current session;
switching tabs renders the chat column from that tab's session, never the other's. Previously a single
global viewed-session / message stream served both: entering the intent tab selected its comm session
into the global state, and switching back left the console tab showing the comm session's chat
(cross-talk).

- **Why re-select, not cache.** The server streams live events to only the connection's
  currently-viewed session, so a cached message stream for the non-viewed tab would go stale. Switching
  back therefore re-selects the session (replaying history + buffered tail) — the same recovery the
  reconnect path uses. The intent tab re-sends `open_intent_chat`, which the server resolves to the
  project's current comm session; no client-side comm pointer is needed.
- **Console-session pointer.** The console tab's own workspace + session (or none). It is recorded on
  session selection **only while the console tab is active** — comm-session selections (open/new/refine
  intent chat) always arrive while the intent tab is active, so they never pollute it. The explicit
  selectors also pin it up front (covering the already-viewing early-return). Deleting the session clears
  it when the deleted session was the pointer, so the next entry falls back.
- **Tab-switch wiring.** The top-bar 「会话」click goes through a switch-to-console path (flip tab +
  re-bind), distinct from the flip-only path used by the explicit selectors — re-binding there would
  double-select. A sidebar **workspace switch** also routes through the switch-to-console path — switching
  the current workspace always lands the view on 「会话」(even from the intent/discussion tab) and
  force-refreshes that workspace's session list, while the session re-bind stays with the console-entry
  decision (no new selection strategy). A pure workspace-switch-effects decision gates it: same workspace →
  no-op; otherwise refresh + enter console. The console re-bind runs the pure console-entry decision:
  re-select the remembered session, else the current workspace's first session, else clear the viewed
  session (empty state — resets the viewed session / messages / task model / … so the comm session never
  lingers). It skips the send when already viewing the target.
- **Reconnect.** The reopen path is unchanged: it restores the **active** tab's view (console →
  re-select session; intent → re-open intent chat). The console-session pointer is in-memory and survives
  a WS reconnect, so the console tab re-binds correctly when next entered.
- **Tests.** The entry decision is the pure, DOM-free console-entry test (remembered honored / fallback
  to first / empty when no workspace or empty list / remembered honored even if absent from the list); the
  same suite covers the workspace-switch effects (same workspace → no-op / different / from-null → force
  refresh + enter console).

## Pending send queue (ordinary sessions)

An ordinary session is single-turn: the server rejects a `user_prompt` while a turn is in flight
(agent-session). So the composer stays editable during a turn, but Send/Enter **enqueues** the text
instead of sending it. This is a client-only affordance — **no server or protocol change**. Team
sessions are unaffected: their lead is alive across turns, so the composer still feeds the live lead
immediately (the composer action returns send).

- **Per-session, in-memory.** The pending queues are keyed by session, so switching sessions keeps each
  queue intact (switch away and back and it's still there). It is plain reactive state — a hard refresh or
  server restart loses it (consistent with "no persistence" above).
- **Queue UI.** The pending queue renders the viewed session's items between the status bar and the
  composer. Each item is still _pending (not yet in context)_ and carries ✎ (edit) and 🗑 (delete): delete
  drops it; edit drops it and folds its text back into the composer draft (single-newline append so an
  in-progress draft isn't lost) for re-editing.
- **Flush on ready (level-triggered).** When the viewed ordinary session is idle with a non-empty queue,
  the items are merged in order, joined by a blank line, into one prompt and submitted via the normal
  submit → `user_prompt` path; the queue is then cleared. The trigger is **level**, not edge: besides the
  watch on running / viewed session / team-active (which catches the running→idle transition), the
  status-apply path re-checks the flush after every `session_status` broadcast/reconcile. So a queue still
  flushes even if that transition was missed (e.g. the broadcast arrives already-idle with no change for
  the watch to fire on) — the stuck queue would otherwise linger forever. The flush is idempotent: it gates
  on idle + non-empty, and submit optimistically marks the session running, so it can't re-fire before the
  server confirms. The merged prompt comes back as an ordinary `user_text` echo bubble — once flushed,
  those entries are normal context, no longer editable/deletable. The flush is only safe because the server
  broadcasts idle **after** the run tears down, not from the in-run `turn_end`: otherwise the flushed
  `user_prompt` would race the teardown and be rejected with "a turn is already running", dropping the
  queue (session-registry design § `turn_end` → idle is held until teardown).
- **Routing constraint.** Because `user_prompt` routes to the connection's currently-viewed session,
  flush only fires for the viewed-and-idle session. An unviewed session's queue is retained until it is
  viewed again while idle, then flushed.
- The merge / flush-trigger / add-edit-delete logic is a pure module, unit-tested in Node (no DOM).

## WS client behavior

- URL derived from the page location: secure WebSocket when the page is HTTPS, else plain.
- Inbound messages are parsed from JSON and forwarded; parse errors are ignored. The heartbeat pong is
  swallowed in the client (transport-only) and never reaches the app listener.
- Send drops the message with a console warning if the socket is not open.
- **Heartbeat**: every 25s the client sends a ping; the server replies with a pong. This keeps idle
  proxies/load-balancers from dropping the socket. If no pong returns within 10s the link is treated as
  half-open and force-closed, which triggers reconnect.
- **Auto-reconnect**: a close (from a real drop, a failed heartbeat, or an error) schedules a reconnect
  with exponential backoff (1s → ×2 → cap 30s) plus jitter; backoff resets on a successful open. Closing
  sets a stopped flag that cancels heartbeat + reconnect for clean teardown.
- **View recovery**: a reconnect (not the first connect) fires the reopen callback, where the container
  re-sends a session selection for the active workspace/session (or re-opens the intent chat when the
  intent view was active). The server's fresh connection re-attaches as a viewer, replays history +
  buffered live events, reconciles in_progress intents (computing run-status), and pushes the enriched
  intents list — so both the normal console and the intent view resume correctly without a reload.

## Technology choices

- **Vue 3 single-file components + refs** — minimal reactive state, no store needed for a single-view app.
- **Vite dev proxy** forwards the WebSocket to the server so the browser connects transparently in
  development (ADR 0002).
- **JSON-pretty rendering** for tool inputs; multi-line collapse + CSS ellipsis for compact display.

## Non-functional considerations

- **Render order = arrival order** (PERF-3 forwarded; the console adds no reordering).
- **No authority** — the console enforces nothing; the server is the decision authority (SEC-4, WC-R7).
- **No persistence** — reloading the page loses the transcript (consistent with SEC-2).

## Visual style

The console's look and feel follows the project style guide at
[`specs/style/style-spec.md`](../../../style/style-spec.md) (immersive dark base, translucent
materials, restrained accent color, low information density). Component styling should conform to it
rather than restating its rules here.

## Testing

- A single root test runner runs every package's colocated tests. The default environment is Node;
  only the web components run in a DOM-emulation environment, and the Vue plugin lets those tests mount
  single-file components.
- **Pure logic** (reducers, selectors, view models) is tested DOM-free in Node — the bulk of coverage,
  fast and free of a mounted DOM.
- **Component tests** mount the component with the Vue test utilities and assert on rendered DOM /
  prop-driven re-render — used where behavior is the rendering itself (e.g. the task panel: grouping
  order, completed-truncation, visibility, per-status markup, live switch on prop change).

## Dependencies

- **Shared protocol types** — the only cross-package import.
- **agent-session** — the WebSocket backend.
- **Dev/test** — the Vue test utilities + a DOM emulation + the Vite Vue plugin (component tests only;
  pure-logic suites need none of them).
