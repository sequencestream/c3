# agent-session — Design

Implements the [spec](spec.md). Lives in `server/src/claude.ts` (`runClaude`),
`server/src/runs.ts` (the session-runtime registry), and `server/src/server.ts` (per-connection
view + WS handler). Message flattening is in `server/src/format.ts`.

## Run construction

`runClaude(opts)` calls the SDK `query()` with:

| Option                            | Value                                       | Why                                                                                                                                                                                              |
| --------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `prompt`                          | an `InputStream` (async-iterable)           | streaming-input mode (AS-R13, ADR 0008): the user's first turn is `push`ed in; keeps the SDK control channel live and lets a team lead outlive a `result`. Not a one-shot string.                |
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

`onStart` hands a **Run Handle** (`{ setPermissionMode, pushInput }`) back so a mid-run
`set_mode` can call `q.setPermissionMode(mode)` (AS-R4) and a team session's next turn can call
`input.push(text)` (AS-R17). `onSessionId` reports the SDK session id from the `init` message;
the server re-keys the runtime pending→real and persists the mode under that id (AS-R10, see
[session-registry design](../session-registry/design.md)). `onTeam` fires once when the first
team tool is seen — the server marks the runtime `team` and emits `team_upgraded` (see § Team
sessions). The run's `send` callback is `(m) => emit(runId, m)` — every event flows into the
runtime's buffer + viewers, never straight to a socket (AS-R11).

### Driver-path remote MCP (`DriverStartOptions.mcpServers`, 2026-06-12-005)

The claude path attaches MCP via in-process SDK servers (`createSdkMcpServer`). Driver-path vendors
(`inProcessMcp: false`) can't load those, so `DriverStartOptions` carries a neutral
`mcpServers?: Record<string, RemoteMcpServer>` (`{ type:'http', url, bearerTokenEnvVar? }`) that
each driver translates to its native config — the codex driver → `config.mcp_servers.<name> =
{ url }` (the streamable-HTTP form `codex mcp add --url` writes). c3's only producer today is the
intent comm-agent: `runViaDriver` binds a per-run localhost HTTP MCP route carrying the three intent
[intent-management design § Intent tools over localhost HTTP MCP](../intent-management/design.md).
Codex is launched by c3's own minimal `codex exec --experimental-json` wrapper, not the
`@openai/codex-sdk` runtime wrapper; the SDK package remains only the event/type reference inside
the Codex adapter.

### InputStream — the streaming-input prompt

`InputStream` (in `claude.ts`) is a controlled async-iterable of `SDKUserMessage` that backs the
`prompt` option (AS-R13). Unlike a plain string prompt — which ends the query the moment a
`result` arrives — it keeps the query (and the underlying Claude Code process) alive until
`close()`:

- `push(text, images?)` enqueues another user turn into the **same** live session (no `resume`, no
  new process); a parked iterator is resolved immediately, else it queues.
- `close()` ends the stream so the `for await` returns and the query terminates normally.
- The constructor flow `push`es the original prompt (with its `images`, if any), then the loop runs.

**Prompt images (2026-06-16):** when the first turn carries images, `push` builds the
`SDKUserMessage` `content` as a block array — a leading `{ type: 'text' }` plus one
`{ type: 'image', source: { type: 'base64', media_type, data } }` per attachment — instead of a
plain string (the Anthropic Messages content shape the CLI forwards verbatim). A text-only turn
stays a string (unchanged). Team-lead `pushInput` turns remain text-only. Images arrive on the
neutral `DriverStartOptions.images` / `RunOptions.images` field; the Codex path encodes the same
field differently (temp-file `--image` paths — see [codex-sdk-guide](../../../architecture/codex-sdk-guide.md)).

Two payoffs beyond teams: SDK control requests (`setPermissionMode` / `interrupt`) take effect
**only** in streaming-input mode — under a string prompt they were silently swallowed (ADR 0008).

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

On `user_prompt`: resolve `viewing`'s runtime (else `error`). **Attachment guard (2026-06-16):**
the message may carry `images: PromptImage[]` (base64 + media type); the handler rejects the whole
turn with `error { code: 'prompt.unsupportedFile' }` on the first non-image `mediaType`
(`isImageMediaType`) — c3 forwards images only, no generic files. Validated images flow as the
optional 3rd `launchRun` arg to whichever vendor path the run forks to. If the runtime is `team` and
has a live `run.handle`, do **not** launch a second run — `emit` the `user_text` echo, `setStatus('running')`,
and `handle.pushInput(text)` (AS-R17). Otherwise, if it already has a `run`, reject with `error`
(serial, AS-R2). The server stays strictly single-turn here; the web console hides this rejection
from the user by **client-side queuing** — for an ordinary running session it withholds the
`user_prompt`, queues the text locally, and only sends it (merged into one prompt) once the
session returns to idle (see [web-console design](../web-console/design.md), WC-R17). The server
sees just one ordinary turn at a time and is unaware of the queue. Otherwise create a fresh
`AbortController`, set `rt.run`, `emit` the `user_text`
echo, `setStatus('running')`, derive `resume`, and call `runClaude` with
`send: (m) => emit(runId, m)` and the `onTeam` hook. `runId` is mutable: `onSessionId` calls `bindPending` and updates
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
    RUN->>SDK: input.close()  (ends the streaming prompt → query loop terminates)
    RUN->>SDK: q.interrupt()  (Promise; .catch swallows late rejection)
    Note over WS: finally emits turn_end(complete); status → idle
```

The abort listener does two things: `input.close()` ends the streaming-input prompt — this is
the **only** way a team session stops, since its input never auto-closes (AS-R16) — then
`q.interrupt()` cuts the in-flight turn. `interrupt()` may reject asynchronously ("ProcessTransport
is not ready for writing") when the query already finished or hasn't streamed; the rejection is
swallowed with `.catch(() => {})` so it never crashes the process (AS-R6, AVAIL-4). Switching the
view or closing the socket never reaches this path.

## Message mapping (SDK → wire)

The `for await` loop over `query()` maps each SDK message (AS-R9):

| SDK message | Block                             | Wire event                                                                                                                                                               |
| ----------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `system`    | `init` (has `session_id`)         | `onSessionId(id)` — reported once (AS-R10)                                                                                                                               |
| `assistant` | `text`                            | `assistant_text { text }`                                                                                                                                                |
| `assistant` | `tool_use` (has `id`+`name`)      | `tool_use { toolUseId, toolName, input }`; if `isTeamTool` ⇒ `onTeam()` once first (AS-R14)                                                                              |
| `user`      | `tool_result` (has `tool_use_id`) | `tool_result { toolUseId, content, isError }`                                                                                                                            |
| `result`    | —                                 | if the turn emitted no visible block ⇒ `notice { text }` first, then `turn_end { reason: 'complete' }`, then fork: non-team `input.close()`; team keeps it open (AS-R15) |

- The user prompt is echoed once as `user_text { text }` before the run starts (AS-R1), so a
  switch-back replay shows it (it is not in the on-disk `baseline` captured earlier).
- A turn that produces only a `thinking` block (the model thought, then ended with no `text`
  or `tool_use`) is tracked per turn; the `result` branch then emits `notice { text }` before
  `turn_end` so the turn renders a muted line instead of a silent gap (an empty turn is
  otherwise indistinguishable from a hang). The flag resets per turn (a team lead reuses one
  process across turns). On-disk replay (`flattenMessages`) mirrors this per **turn**, not per
  message: the transcript splits one turn into several single-block messages (a `thinking`
  message, a `text` message, a `tool_use` message…), so a lone `thinking` message is usually
  just the lead-in to a turn that continues — the notice is added only when a whole turn (up
  to the next real user prompt) thought but produced no assistant text and no tool call.
- `content` for tool results is flattened by `stringifyToolResult` (string as-is; array →
  text blocks joined by newline, non-text JSON-stringified; else JSON-stringified).
- An exception in the loop, when `!signal.aborted`, sends `turn_end { reason: 'error', error }`
  (AS-R7). When stopped (`signal.aborted`), the run loop sends no terminal event; the server's
  `finally` emits a synthetic `turn_end { reason: 'complete' }` so the viewing input unlocks.
- The loop checks `signal.aborted` each iteration and breaks.

### Socket-disconnect auto-resume (AS-R18 / AS-R19, AVAIL-7)

The catch block classifies the error in a fixed order so the two paths never cross:

1. **`isSocketDisconnect(msg)`** (a narrow, single-phrase matcher for `socket connection was
closed unexpectedly`, deliberately disjoint from `isDegradableError`) — if an
   `onSocketDisconnect` callback is wired, the run defers (no `turn_end`) and reports
   `{ error, sideEffectPending }`. `sideEffectPending` comes from a live `Set` mirroring
   `computeSideEffectPending`: a **side-effect-class** `tool_use` opens an entry, its
   `tool_result` closes it; a non-empty set at disconnect time means a write may be half-applied
   (AS-R19). The allowlist of side-effect-**free** tools is conservative — anything not in it
   (incl. `Bash` and unknown/MCP tools) counts as a side effect.
2. **`isDegradableError(msg)`** — the existing degradation-chain bypass (`onDegradableError`).
3. Otherwise — a terminal `turn_end { reason: 'error' }`.

The server's `launchRun` owns the bounded retry guard. On `onSocketDisconnect`, `decideSocketResume`
(pure) returns `auto-resume` only when the conjunction holds (`socketAutoResume` on, gate clear,
single retry unspent, a real `runId`, not a team, not aborted). On `auto-resume`: mark the retry
spent, `setStatus('reconnecting')`, await a 3–5s abortable backoff, then re-invoke `runClaude`
with `resume: runId` + `reconnectAttempt: true` (same SDK session ⇒ full context). The resumed run
re-pushes the original prompt as the continuation turn; this is safe _because_ the gate already
guaranteed no unclosed **write** `tool_use` (AS-R19) — at worst a read is repeated, never a write
duplicated. The successful resume emits its own `turn_end { reason: 'complete', reconnect_attempted: true, retry_count: 1 }`.
Otherwise `decideSocketResume` returns `manual-error`, whose `turn_end { reason: 'error',
side_effect_pending, original_error, … }` the server emits before settling to `idle`. A socket
disconnect is **never** degradable — it leaves the `agentsToTry` loop rather than trying the next
agent — and is bounded to **one** resume per turn. Because the resume reuses the same `runId`
(single live runtime instance, `rt.run` never null across the backoff), it cannot race
`reconcileLiveness` zombie cleanup.

## Team sessions (persistent agent teams)

A run becomes a persistent **agent team** when the lead delegates work that must outlive the
current turn — without keeping the lead process alive, the lead's `result` would close a string
prompt's query, exiting the process and orphaning/killing background teammates before their
results return (the motivating bug; ADR 0008).

**Detection — `isTeamTool(name, input)`** (in `claude.ts`), evaluated on each `tool_use` block
before that turn's `result`, firing `onTeam()` exactly once:

| Tool                                      | Team? | Why                                                  |
| ----------------------------------------- | ----- | ---------------------------------------------------- |
| `TeamCreate`                              | yes   | only exists in team mode                             |
| `SendMessage`                             | yes   | only exists in team mode                             |
| `Agent` with `run_in_background === true` | yes   | a detached teammate that reports back asynchronously |
| `Agent` (foreground)                      | no    | a sub-agent that completes within the turn           |

**Lifecycle:**

1. `onTeam()` → server sets `rt.team = true`, `emit(runId, { type: 'team_upgraded' })` (recorded
   in the buffer, so reconnect replay shows it), `setStatus(runId, 'team')`.
2. On `result`, the team run keeps `input` open (vs. non-team `input.close()`); the lead process
   stays alive and the SDK re-wakes it on the next turn (a teammate notification or a pushed user
   prompt). The runtime stays `team` because `emit`'s `turn_end` would imply `idle`, but the
   `team` override holds it (see [session-registry design](../session-registry/design.md)).
3. Next user turn: the server feeds it via `handle.pushInput(text)` into the live session — no
   second `runClaude`, no `resume` — after echoing `user_text` and setting `running` (AS-R17).
4. End: only on user stop. The abort listener `input.close()`s the never-auto-closing stream
   (plus `interrupt()`); the run's `finally` resets `rt.team = false` and falls back to `idle`
   (AS-R16). There is no automatic "team disbanded" detection.

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

- **`@anthropic-ai/claude-agent-sdk`** — `query()` (streaming-input prompt), `setPermissionMode`,
  `interrupt`; agent-team tools (`TeamCreate` / `SendMessage` / background `Agent`).
- **host `claude` CLI** — required at runtime; absence surfaces as a run error.
- **permission-gateway** — `waitForDecision`/`resolveDecision`.
- **agent-config** — `resolveSessionLaunch(sessionId)` supplies the run's `env` overrides and
  `model` (the bound or default agent's Claude config).
