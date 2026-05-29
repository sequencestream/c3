# agent-session — Design

Implements the [spec](spec.md). Lives in `server/src/claude.ts` (`runClaude`),
`server/src/runs.ts` (the session-runtime registry), and `server/src/server.ts` (per-connection
view + WS handler). Message flattening is in `server/src/format.ts`.

## Run construction

`runClaude(opts)` calls the SDK `query()` with:

| Option                            | Value                                       | Why                                                                                                                                                                                              |
| --------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `prompt`                          | user prompt text                            | the turn to run                                                                                                                                                                                  |
| `cwd`                             | session's workspace path                    | where Claude reads/writes (AS-R1)                                                                                                                                                                |
| `resume`                          | session id \| omit                          | continue an existing session; omitted for a pending session's first run (AS-R10)                                                                                                                 |
| `settingSources`                  | `['user', 'project']`                       | inherit user/project settings, hooks, allow rules, Skills — ADR 0005 / C-SEC-1                                                                                                                   |
| `systemPrompt`                    | `{ type: 'preset', preset: 'claude_code' }` | use Claude Code's full system prompt incl. dynamic sections (working dir, git status, CLAUDE.md/memory); without it the SDK 0.3.x default omits env context and the model never learns the `cwd` |
| `permissionMode`                  | session's mode (from its runtime)           | starting policy (AS-R3)                                                                                                                                                                          |
| `allowDangerouslySkipPermissions` | `true`                                      | permits switching into `bypassPermissions` at any point; c3 stays the UI (C-SEC)                                                                                                                 |
| `pathToClaudeCodeExecutable`      | resolved `claude` path                      | only set when found (ADR 0003)                                                                                                                                                                   |
| `env`                             | `{ ...process.env, ...overrides }` \| omit  | active agent's `ANTHROPIC_BASE_URL`/`ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN`; omitted for the system agent (agent-config AC-R4/R5)                                                             |
| `model`                           | active agent's model \| omit                | model override from the active agent; omitted ⇒ SDK default (agent-config AC-R5)                                                                                                                 |
| `canUseTool`                      | gateway callback                            | gates sensitive tools (AS-R5)                                                                                                                                                                    |

`onStart` hands a **Run Handle** (`{ setPermissionMode }`) back so a mid-run `set_mode` can call
`q.setPermissionMode(mode)` (AS-R4). `onSessionId` reports the SDK session id from the `init`
message; the server re-keys the runtime pending→real and persists the mode under that id
(AS-R10, see [session-registry design](../session-registry/design.md)). The run's `send`
callback is `(m) => emit(runId, m)` — every event flows into the runtime's buffer + viewers,
never straight to a socket (AS-R11).

## Session-runtime registry (`runs.ts`)

A module-level `Map<sessionId, SessionRuntime>` (see [models](models.md)), shared across
connections. Key operations:

| Function                                       | Role                                                                                         |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `ensureRuntime(id, cwd, mode, baseline)`       | Get-or-create; seeds `baseline` once (disk read happens once per session per process)        |
| `emit(id, event)`                              | Append to `buffer`, fan out to `viewers`, advance `status`, broadcast on change (AS-R11/R12) |
| `addViewer` / `removeViewer`                   | A connection subscribes/unsubscribes as it switches view                                     |
| `bindPending(pendingId, real)`                 | Re-key the runtime; buffer/viewers/run move with it (AS-R10)                                 |
| `stopRun(id)`                                  | Abort the in-flight run (AS-R6)                                                              |
| `removeRuntime` / `removeRuntimesForWorkspace` | Abort + drop on delete / workspace removal                                                   |
| `setOnStatusChange(cb)`                        | Server hook; fires `broadcastStatuses()` so all connections get `session_status`             |

## Per-connection state (server.ts)

The connection is a **view**, not a run owner:

| Field     | Type             | Lifetime                                                      |
| --------- | ---------------- | ------------------------------------------------------------- |
| `viewing` | `string \| null` | the session this connection currently watches (a runtime key) |
| `sock`    | socket \| null   | set on open, cleared on close; backs `deliver`                |
| `deliver` | callback         | sends a wire event to this socket (viewer + status broadcast) |

The module-level `connections: Set<deliver>` holds every live connection for `session_status`
broadcasts; `setOnStatusChange(broadcastStatuses)` wires runtime status changes to it.

On `user_prompt`: resolve `viewing`'s runtime (else `error`); if it already has a `run`, reject
with `error` (serial, AS-R2). Otherwise create a fresh `AbortController`, set `rt.run`, `emit`
the `user_text` echo, `setStatus('running')`, derive `resume`, and call `runClaude` with
`send: (m) => emit(runId, m)`. `runId` is mutable: `onSessionId` calls `bindPending` and updates
it so post-bind events target the real key. In `finally`: clear `rt.run` if still current, emit
a synthetic `turn_end` if the run was stopped (so a viewing input unlocks), `setStatus('idle')`,
and refresh the session list. **No abort of any other session.**

On `select_session` / `create_session`: `removeViewer(old)`, then either reuse the existing
runtime or seed a cold one from disk; send `session_selected` (history = `baseline`,
`running = rt.run != null`), replay `buffer` as live events, then `addViewer`. The replay block
has no `await`, so it is atomic against concurrent `emit`s. `stop_run` calls `stopRun(viewing)`.

## Stop / interrupt

```mermaid
sequenceDiagram
    participant UI
    participant WS as server.ts
    participant REG as runs.ts
    participant RUN as runClaude
    participant SDK as query()
    UI->>WS: stop_run (viewed session)
    WS->>REG: stopRun(viewing)
    REG->>RUN: run.abort.abort()
    RUN->>SDK: q.interrupt()  (Promise; .catch swallows late rejection)
    Note over WS: finally emits turn_end(complete); status → idle
```

`interrupt()` may reject asynchronously ("ProcessTransport is not ready for writing") when
the query already finished or hasn't streamed. The rejection is swallowed with `.catch(()
=> {})` so it never crashes the process (AS-R6, AVAIL-4). Switching the view or closing the
socket never reaches this path.

## Message mapping (SDK → wire)

The `for await` loop over `query()` maps each SDK message (AS-R9):

| SDK message | Block                             | Wire event                                    |
| ----------- | --------------------------------- | --------------------------------------------- |
| `system`    | `init` (has `session_id`)         | `onSessionId(id)` — reported once (AS-R10)    |
| `assistant` | `text`                            | `assistant_text { text }`                     |
| `assistant` | `tool_use` (has `id`+`name`)      | `tool_use { toolUseId, toolName, input }`     |
| `user`      | `tool_result` (has `tool_use_id`) | `tool_result { toolUseId, content, isError }` |
| `result`    | —                                 | `turn_end { reason: 'complete' }`             |

- The user prompt is echoed once as `user_text { text }` before the run starts (AS-R1), so a
  switch-back replay shows it (it is not in the on-disk `baseline` captured earlier).
- `content` for tool results is flattened by `stringifyToolResult` (string as-is; array →
  text blocks joined by newline, non-text JSON-stringified; else JSON-stringified).
- An exception in the loop, when `!signal.aborted`, sends `turn_end { reason: 'error', error }`
  (AS-R7). When stopped (`signal.aborted`), the run loop sends no terminal event; the server's
  `finally` emits a synthetic `turn_end { reason: 'complete' }` so the viewing input unlocks.
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

- **Single in-flight run per session** (serial, AS-R2); **many sessions concurrent**, no cap.
- **Runs survive disconnect** — they live in the module-level registry, not the socket (ADR
  0006, AS-R8); reconnect replays via `baseline + buffer`.
- **Error surfacing** never silent (AVAIL-1, AS-R7).
- **No persistence of run/permission state** — in-memory in the registry (SEC-2); buffers are
  not evicted (acceptable for a local single-user tool). Session continuity comes from the SDK
  transcript store via `resume`; the workspace/session registry is persisted by
  [session-registry](../session-registry/design.md) (ADR 0004).

## Dependencies

- **`@anthropic-ai/claude-agent-sdk`** — `query()`, `setPermissionMode`, `interrupt`.
- **host `claude` CLI** — required at runtime; absence surfaces as a run error.
- **permission-gateway** — `waitForDecision`/`resolveDecision`.
- **agent-config** — `resolveSessionLaunch(sessionId)` supplies the run's `env` overrides and
  `model` (the bound or default agent's Claude config).
