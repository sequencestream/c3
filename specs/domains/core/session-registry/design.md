# session-registry — Design

Implements the [spec](spec.md). Lives in `server/src/state.ts` (persistence),
`server/src/sessions.ts` (SDK session API + transcript mapping), and the WS handler in
`server/src/server.ts` (per-connection active session + event dispatch).

## Module split

| Concern                    | File                     | Notes                                                           |
| -------------------------- | ------------------------ | --------------------------------------------------------------- |
| Persisted registry         | `server/src/state.ts`    | Module-level cache; atomic write (temp + rename); fail-soft     |
| SDK session enumeration/IO | `server/src/sessions.ts` | `listSessions` / `getSessionMessages` / `rename` / `delete`     |
| Viewed session + dispatch  | `server/src/server.ts`   | Per-connection `viewing`; per-session mode lives on the runtime |
| Session runtimes           | `server/src/runs.ts`     | Per-session run/buffer/status (agent-session, ADR 0006)         |

## Persistence (`state.ts`)

- Location: `${CLAUDE_CONFIG_DIR:-~/.claude}/c3/state.json`.
- Loaded lazily into a module cache; every mutation persists synchronously.
- **Atomic write:** write `…json.<pid>.tmp` then `renameSync` over the target.
- **Fail-soft:** a missing/corrupt file (or write error) falls back to empty state and logs;
  c3 must still boot (ADR 0004, AVAIL).
- `addWorkspace` validates the path is a directory (SR-R1) and is idempotent; `touchWorkspace`
  bumps `lastAccessed` (SR-R3); `listWorkspaces` returns a copy sorted by `lastAccessed` desc.

## Session IO (`sessions.ts`)

| Function                     | SDK call                          | Maps to                                          |
| ---------------------------- | --------------------------------- | ------------------------------------------------ |
| `listWorkspaceSessions(dir)` | `listSessions({ dir })`           | `SessionInfo[]` + per-session mode, newest first |
| `loadHistory(dir, id)`       | `getSessionMessages(id, { dir })` | `TranscriptItem[]` (see mapping)                 |
| `removeSession(dir, id)`     | `deleteSession(id, { dir })`      | —                                                |
| `renameWorkspaceSession(…)`  | `renameSession(id, title, …)`     | —                                                |

Transcript mapping mirrors the live mapping in agent-session so replayed history renders
identically: `assistant` text/`tool_use` → `assistant`/`tool_use` items; `user`
string/text/`tool_result` → `user`/`tool_result` items (`tool_result` content flattened by
`stringifyToolResult`).

## Per-connection state (`server.ts`)

| Field     | Type             | Lifetime                                                 |
| --------- | ---------------- | -------------------------------------------------------- |
| `viewing` | `string \| null` | the session this connection watches (real or `pending:`) |

The cwd and per-session mode are read from the viewed session's runtime, not connection fields.
`set_mode` updates the runtime's `mode`, persists it for a real session (pending persists on
bind), pushes it to the in-flight run if any, and confirms with `mode_changed` (SR-R5). The
persisted `activeSessionId` is updated on select/bind as a restart hint.

## Pending-session binding

```mermaid
sequenceDiagram
    participant UI
    participant WS as server.ts
    participant RUN as runClaude
    UI->>WS: create_session(ws)
    WS->>UI: session_selected (sessionId=pending:…, history=[])
    UI->>WS: user_prompt(text)
    WS->>RUN: runClaude(cwd, resume=undefined, mode=rt.mode, onSessionId)
    RUN-->>WS: onSessionId(realId)  (from init message)
    WS->>WS: bindPending(pending→realId); persist mode + activeSessionId; viewing=realId
    WS->>UI: session_started(clientId=pending:…, sessionId=realId)
    Note over WS,UI: on run end → sessions list refreshed (real title)
```

Binding re-keys the runtime (buffer/viewers/run move with it). A `select_session` of an
existing session passes `resume=sessionId`; `onSessionId` reports the same id, so no rebind
occurs (the guard is `runId !== sid`).

## Switching & concurrency

Switching is a **view** change, not a run change. `create_session` and `select_session`
`removeViewer(old)` / `addViewer(new)` and replay the new session's record; they **never** abort
a run (ADR 0006, AS-R8). Many sessions run concurrently; a single session is serial — a
`user_prompt` for a session with a turn already in flight returns an `error` (AS-R2).
`user_prompt` requires a viewed session; otherwise an `error` is returned.

## Non-functional considerations

- **Only metadata persisted** — never permission state (SR-R11, ADR 0001/0004).
- **Recent-access order** is the workspace sort; sessions sort by SDK `lastModified`.
- **Stale ids** in `sessionModes` are harmless and ignored on read.

## Dependencies

- **`@anthropic-ai/claude-agent-sdk`** — session enumeration, history, rename, delete.
- **agent-session** — receives `cwd` / `resume` / `mode`; returns the bound `sessionId`.
- **Node `fs`/`os`/`path`** — atomic JSON persistence under the config dir.
