# web-console — Design

Implements the [spec](spec.md). Vue 3 SPA. `web/src/App.vue` is a thin container (state +
WebSocket wiring) that composes presentational components under `web/src/components/`; shared
non-component modules live under `web/src/lib/`, including the WebSocket client `web/src/lib/ws.ts`.
Built with Vite; dev proxy in `web/vite.config.ts`.

## Components / structure

App owns all WebSocket state and `client.send`; child components are presentational, taking
props and emitting intent events (App performs every send). All styling is global
(`standard.css` + `style.css`), so components carry no scoped styles.

| Unit             | File                              | Role                                                                                                                                                                                                                                                      |
| ---------------- | --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| App              | `App.vue`                         | Container: holds state, owns `client`, runs `handleMessage`, wires children                                                                                                                                                                               |
| AppHeader        | `components/AppHeader.vue`        | Breadcrumbs, permission-mode dropdown, settings entry, connection status                                                                                                                                                                                  |
| SessionSidebar   | `components/SessionSidebar.vue`   | Workspace / session tree; owns per-workspace pagination + prompt/confirm UX, emits CRUD intents                                                                                                                                                           |
| ChatMessages     | `components/ChatMessages.vue`     | Groups `messages` into render blocks (text / collapsible tool batch), owns expand state + autoscroll                                                                                                                                                      |
| PermissionPrompt | `components/PermissionPrompt.vue` | One permission block. When `actionable`: AskUserQuestion answer panel or allow/deny prompt (owns local answer draft, emits `respond`/`submit-ask`). When undecided-but-not-actionable: a single static history line (no buttons, no verdict)              |
| ConsensusBlock   | `components/ConsensusBlock.vue`   | Read-only render of an auto-resolved multi-agent consensus outcome                                                                                                                                                                                        |
| SessionStatusBar | `components/SessionStatusBar.vue` | Thin status line above the input: run-activity dot + spinner + label + refresh button; presentational, emits `refresh` (WC-R15)                                                                                                                           |
| MessageInput     | `components/MessageInput.vue`     | Prompt textarea + slash-command autocomplete; owns input draft, emits `submit`/`stop`/`list-commands`. Submit keys: `⌘/Ctrl+Enter`, or two bare `Enter`s within 400ms (skips IME compose & `Shift+Enter`). Hovering Send for 2s shows a send-hint tooltip |
| SettingsPanel    | `components/SettingsPanel.vue`    | System settings page: agent table + consensus toggle; owns editable draft seeded from server settings                                                                                                                                                     |
| BaseDropdown     | `components/BaseDropdown.vue`     | Standard custom dropdown (replaces native `<select>`): trigger + popover with icon rows, keyboard nav, click-outside close                                                                                                                                |
| WS client        | `lib/ws.ts`                       | Opens `ws(s)://<host>/ws`, dispatches parsed `ServerToClient` to a listener, exposes `send(ClientToServer)` + `close()`; heartbeat + auto-reconnect with `onReopen` view recovery                                                                         |

Shared modules: `lib/chat-types.ts` (`ChatBody`/`ChatMsg`/`Block`/`RunActivity` types), `lib/ask.ts`
(AskUserQuestion parsing + consensus pre-fill), `lib/format.ts` (`fmt`/`oneLine`).

## State (App.vue)

| Ref                | Type                               | Purpose                                                                                                                  |
| ------------------ | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `messages`         | `ChatMsg[]`                        | Ordered render list (WC-R1); passed to ChatMessages                                                                      |
| `status`           | `connecting` \| `open` \| `closed` | Connection indicator (WC-R6)                                                                                             |
| `sessionStatus`    | `Record<sessionId, SessionStatus>` | Per-session live status from `ready`/`session_status` (WC-R12)                                                           |
| `running`          | computed boolean                   | Viewed session's status ≠ `idle`; disables input, shows Stop (WC-R2/R14)                                                 |
| `activity`         | `RunActivity`                      | Fine-grained run state of the viewed session, inferred from the stream; drives SessionStatusBar (WC-R15)                 |
| `mode`             | `PermissionMode`                   | Current mode; synced from `ready`/`mode_changed` (WC-R4)                                                                 |
| `actionablePermId` | computed `string \| null`          | `requestId` of the one permission the user can still act on, or null; derived from `sessionStatus` + transcript (WC-R16) |

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

| Action                 | Guard                                                             | Sends                                                                                       |
| ---------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `onSubmit(text)`       | non-empty + `!running` (in MessageInput), client present (WC-R2)  | `user_prompt`; optimistically marks viewed session `running`                                |
| `stopRun()`            | viewed session running (WC-R14)                                   | `stop_run`                                                                                  |
| `respond(m, decision)` | client present, prompt `actionable` (⇒ `m.decision` null) (WC-R3) | `permission_response`; sets `m.decision` locally                                            |
| `setMode(next)`        | client present, value changed                                     | optimistic `mode` update + `set_mode` (WC-R4); `next` from BaseDropdown `update:modelValue` |

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

## Dependencies

- **`@ccc/shared`** — protocol types (the only cross-package import).
- **agent-session** — the WebSocket backend.
