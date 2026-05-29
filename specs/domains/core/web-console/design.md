# web-console — Design

Implements the [spec](spec.md). Vue 3 SPA. Lives in `web/src/App.vue` (UI + state) and
`web/src/lib/ws.ts` (WebSocket client). Built with Vite; dev proxy in `web/vite.config.ts`.

## Components / structure

| Unit      | File        | Role                                                                                                        |
| --------- | ----------- | ----------------------------------------------------------------------------------------------------------- |
| App       | `App.vue`   | Chat view, prompt input, permission dialog, mode `<select>`, status indicator                               |
| WS client | `lib/ws.ts` | Opens `ws(s)://<host>/ws`, dispatches parsed `ServerToClient` to a listener, exposes `send(ClientToServer)` |

## State (App.vue)

| Ref        | Type                               | Purpose                                                  |
| ---------- | ---------------------------------- | -------------------------------------------------------- |
| `messages` | `ChatMsg[]`                        | Ordered render list (WC-R1)                              |
| `input`    | string                             | Prompt draft                                             |
| `status`   | `connecting` \| `open` \| `closed` | Connection indicator (WC-R6)                             |
| `running`  | boolean                            | True between submit and `session_end` (WC-R2, WC-R5)     |
| `mode`     | `PermissionMode`                   | Current mode; synced from `ready`/`mode_changed` (WC-R4) |
| `expanded` | `Set<number>`                      | Which tool/permission entries are expanded               |

`ChatMsg` is a discriminated union over `kind`: `user` · `assistant` · `tool-use` ·
`tool-result` · `permission` · `system`, each with a numeric `id`.

## Event handling (wire → UI)

`handleMessage(msg)` switches on `msg.type`:

| Wire event               | UI effect                                                |
| ------------------------ | -------------------------------------------------------- |
| `ready` / `mode_changed` | set `mode`                                               |
| `assistant_text`         | append assistant message                                 |
| `tool_use`               | append tool-use message                                  |
| `tool_result`            | append tool-result message                               |
| `permission_request`     | append permission message with `decision: null`          |
| `session_end`            | `running = false`; append system note (complete / error) |

## User actions (UI → wire)

| Action                 | Guard                                           | Sends                                            |
| ---------------------- | ----------------------------------------------- | ------------------------------------------------ |
| `submit()`             | non-empty, client present, `!running` (WC-R2)   | `user_prompt`; then `running = true`             |
| `respond(m, decision)` | client present, `m.decision` still null (WC-R3) | `permission_response`; sets `m.decision` locally |
| `onModeChange(e)`      | client present, value changed                   | optimistic `mode` update + `set_mode` (WC-R4)    |

## WS client behavior

- URL derived from `window.location`: `wss:` when the page is HTTPS, else `ws:`.
- `onmessage` parses JSON and forwards; parse errors are ignored.
- `send` drops the message with a console warning if the socket is not `OPEN`.
- `onclose`/`onerror` set status `closed`. **No auto-reconnect** today — the user reloads
  (documented gap, AVAIL § Known gaps).

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
