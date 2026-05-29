# agent-session — Design

Implements the [spec](spec.md). Lives in `server/src/claude.ts` (`runClaude`) and
`server/src/server.ts` (per-connection state + WS handler). Message flattening is in
`server/src/format.ts`.

## Run construction

`runClaude(opts)` calls the SDK `query()` with:

| Option                            | Value                     | Why                                                                              |
| --------------------------------- | ------------------------- | -------------------------------------------------------------------------------- |
| `prompt`                          | user prompt text          | the turn to run                                                                  |
| `cwd`                             | active workspace path     | where Claude reads/writes (AS-R1)                                                |
| `resume`                          | active session id \| omit | continue an existing session; omitted for a pending session's first run (AS-R10) |
| `settingSources`                  | `['user', 'project']`     | inherit user/project settings, hooks, allow rules, Skills — ADR 0005 / C-SEC-1   |
| `permissionMode`                  | active session's mode     | starting policy (AS-R3)                                                          |
| `allowDangerouslySkipPermissions` | `true`                    | permits switching into `bypassPermissions` at any point; c3 stays the UI (C-SEC) |
| `pathToClaudeCodeExecutable`      | resolved `claude` path    | only set when found (ADR 0003)                                                   |
| `canUseTool`                      | gateway callback          | gates sensitive tools (AS-R5)                                                    |

`onStart` hands a **Run Handle** (`{ setPermissionMode }`) back to the server so a mid-run
`set_mode` can call `q.setPermissionMode(mode)` (AS-R4). `onSessionId` reports the SDK session
id from the `init` message; the server binds a pending session to it and persists the mode
under that id (AS-R10, see [session-registry design](../session-registry/design.md)).

## Per-connection state (server.ts)

| Field             | Type                      | Lifetime                                      |
| ----------------- | ------------------------- | --------------------------------------------- |
| `activeWorkspace` | `string \| null`          | the cwd the next run uses (session-registry)  |
| `activeSession`   | `string \| null`          | real id, or `pending:<uuid>` before first run |
| `activeMode`      | `PermissionMode`          | active session's mode; the run's start policy |
| `runAbort`        | `AbortController \| null` | per run; `null` between runs                  |
| `runHandle`       | `RunHandle \| null`       | per run; `null` between runs                  |

On `user_prompt`: require an active session (else `error`), `runAbort?.abort()` (AS-R2),
create a fresh `AbortController`, derive `resume` (omitted for a pending session), call
`runClaude` with `onSessionId` to bind/persist. In `finally`, if the controller is still
current, clear `runAbort`/`runHandle` so a later prompt never aborts an already-closed query
(AS-R6), and refresh the workspace's session list.

## Abort / interrupt

```mermaid
sequenceDiagram
    participant UI
    participant WS as server.ts
    participant RUN as runClaude
    participant SDK as query()
    UI->>WS: user_prompt (while running)
    WS->>WS: runAbort.abort()
    WS->>RUN: signal aborted
    RUN->>SDK: q.interrupt()  (Promise; .catch swallows late rejection)
    WS->>RUN: start new run with new AbortController
```

`interrupt()` may reject asynchronously ("ProcessTransport is not ready for writing") when
the query already finished or hasn't streamed. The rejection is swallowed with `.catch(()
=> {})` so it never crashes the process (AS-R6, AVAIL-4).

## Message mapping (SDK → wire)

The `for await` loop over `query()` maps each SDK message (AS-R9):

| SDK message | Block                             | Wire event                                    |
| ----------- | --------------------------------- | --------------------------------------------- |
| `system`    | `init` (has `session_id`)         | `onSessionId(id)` — reported once (AS-R10)    |
| `assistant` | `text`                            | `assistant_text { text }`                     |
| `assistant` | `tool_use` (has `id`+`name`)      | `tool_use { toolUseId, toolName, input }`     |
| `user`      | `tool_result` (has `tool_use_id`) | `tool_result { toolUseId, content, isError }` |
| `result`    | —                                 | `session_end { reason: 'complete' }`          |

- `content` for tool results is flattened by `stringifyToolResult` (string as-is; array →
  text blocks joined by newline, non-text JSON-stringified; else JSON-stringified).
- An exception in the loop, when `!signal.aborted`, sends `session_end { reason: 'error',
error }` (AS-R7). When aborted, no terminal event is sent for the abandoned run.
- The loop checks `signal.aborted` each iteration and breaks.

## claude executable lookup

`findClaudeExecutable()` (memoized): `$CLAUDE_PATH` if set, else `command -v claude` via
`spawnSync`. Returns `undefined` if not found, in which case the option is omitted and the
SDK falls back to its own lookup. Rationale and the single-binary context are in ADR 0003.

## Technology choices

- **Hono + `@hono/node-ws`** for HTTP and WebSocket upgrade.
- **`AbortController`** as the abort signal bridged to `interrupt()`.
- **Discriminated-union narrowing** on `type` for both SDK blocks and wire messages; no
  `as`-laundering beyond the minimal structural casts at the untyped SDK boundary (the SDK
  block shapes are `unknown` until narrowed).

## Non-functional considerations

- **Single in-flight run** per connection (PERF-5, AS-R2).
- **Error surfacing** never silent (AVAIL-1, AS-R7).
- **No persistence of run/permission state** — in-memory per connection (SEC-2). Session
  continuity comes from the SDK transcript store via `resume`; the workspace/session registry
  is persisted by [session-registry](../session-registry/design.md) (ADR 0004).

## Dependencies

- **`@anthropic-ai/claude-agent-sdk`** — `query()`, `setPermissionMode`, `interrupt`.
- **host `claude` CLI** — required at runtime; absence surfaces as a run error.
- **permission-gateway** — `waitForDecision`/`resolveDecision`.
