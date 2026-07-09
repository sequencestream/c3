# agent-session — Design

Implements the [spec](agent-session-spec.md). The run loop drives the SDK; a process-wide session-runtime
registry owns runs across connections; the WebSocket handler holds the per-connection view.
Inbound SDK messages are flattened into wire events.

## Run construction

The run calls the SDK `query()` with:

| Option                            | Value                                       | Why                                                                                                                                                                                              |
| --------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `prompt`                          | a streaming-input async-iterable            | streaming-input mode (AS-R13, ADR 0008): the user's first turn is pushed in; keeps the SDK control channel live and lets a team lead outlive a `result`. Not a one-shot string.                  |
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

A start callback hands a **Run Handle** (set permission mode, push input) back so a mid-run
`set_mode` can apply a new mode to the live query (AS-R4) and a team session's next turn can push
the next user turn (AS-R17). A session-id callback reports the SDK session id from the `init` message;
the server re-keys the runtime pending→real and persists the mode under that id (AS-R10, see
[session-registry design](../session-registry/session-registry-design.md)). A team callback fires once when the first
team tool is seen — the server marks the runtime `team` and emits `team_upgraded` (see § Team
sessions). The run's send callback routes every event into the runtime's buffer + viewers, never
straight to a socket (AS-R11).

### Driver-path remote MCP (2026-06-12-005)

The Claude path attaches MCP via in-process SDK servers (`createSdkMcpServer`). Driver-path vendors
can't load those, so the neutral driver-start options carry a neutral remote-MCP map (HTTP servers
identified by name, with a URL and optional bearer-token env var) that each driver translates to its
native config — the codex driver writes the streamable-HTTP server entry the codex CLI's
`codex mcp add --url` form produces. c3's only producer today is the intent comm-agent: the driver
path binds a per-run localhost HTTP MCP route carrying the three intent tools (see
[intent-management design § Intent tools over localhost HTTP MCP](../intent-management/intent-management-design.md)).
Codex is launched by c3's own minimal `codex exec --experimental-json` wrapper, not the
`@openai/codex-sdk` runtime wrapper; the SDK package remains only the event/type reference inside
the Codex adapter.

### Codex GitHub CLI credential injection

A codex session runs under codex's own seatbelt sandbox (and optionally a docker container), whose
subprocesses cannot read the host OS keyring — so `gh`, which stores its token there, fails auth inside
the session even on an authenticated host with network. `run-via-driver` resolves the host `gh`
credential once (after agent-launch env resolution, before building the sandbox env-file and calling
`driver.start`) and, when neither `GH_TOKEN` nor `GITHUB_TOKEN` is already set (following the
`buildChildEnv` precedence: agent overrides > shell > defaults), injects `GH_TOKEN` into the same
`envOverrides` — so the host codex process and the container wrapper's env-file get the same value.
Codex-only (the claude path has no seatbelt boundary); probe failure degrades silently and never blocks
startup; the token is never written to disk, logged, or surfaced in telemetry. See
[codex-sdk-guide § GitHub CLI 凭据桥接](../../../architecture/codex-sdk-guide.md).

### The streaming-input prompt

The streaming-input prompt is a controlled async-iterable of SDK user messages that backs the
`prompt` option (AS-R13). Unlike a plain string prompt — which ends the query the moment a `result`
arrives — it keeps the query (and the underlying Claude Code process) alive until it is closed:

- Pushing text (with optional images) enqueues another user turn into the **same** live session (no
  `resume`, no new process); a parked iterator is resolved immediately, else it queues.
- Closing ends the stream so the iteration returns and the query terminates normally.
- The construction flow pushes the original prompt (with its images, if any), then the loop runs.

**Prompt images (2026-06-16):** when the first turn carries images, the push builds the SDK user
message content as a block array — a leading text block plus one base64 image block per attachment —
instead of a plain string (the Anthropic Messages content shape the CLI forwards verbatim). A
text-only turn stays a string (unchanged). Team-lead pushed turns remain text-only. Images arrive on
the neutral driver-start / run-options images field; the Codex path encodes the same field differently
(temp-file `--image` paths — see [codex-sdk-guide](../../../architecture/codex-sdk-guide.md)).

Two payoffs beyond teams: SDK control requests (`setPermissionMode` / `interrupt`) take effect
**only** in streaming-input mode — under a string prompt they were silently swallowed (ADR 0008).

## Session-runtime registry

A module-level map from session id to session runtime (see [models](agent-session-models.md)), shared across
connections. Key operations:

| Operation                      | Role                                                                                       |
| ------------------------------ | ------------------------------------------------------------------------------------------ |
| Ensure runtime                 | Get-or-create; seeds the baseline once (disk read happens once per session per process)    |
| Emit event                     | Append to the buffer, fan out to viewers, advance status, broadcast on change (AS-R11/R12) |
| Add / remove viewer            | A connection subscribes/unsubscribes as it switches view                                   |
| Bind pending → real            | Re-key the runtime; buffer/viewers/run move with it (AS-R10)                               |
| Stop run                       | Abort the in-flight run (AS-R6)                                                            |
| Remove runtime / for-workspace | Abort + drop on delete / workspace removal                                                 |
| Set status-change hook         | Server hook; broadcasts so all connections get `session_status`                            |

## Per-connection state

The connection is a **view**, not a run owner:

| Field   | Lifetime                                                      |
| ------- | ------------------------------------------------------------- |
| Viewing | the session this connection currently watches (a runtime key) |
| Socket  | set on open, cleared on close; backs delivery                 |
| Deliver | sends a wire event to this socket (viewer + status broadcast) |

A module-level set holds every live connection for `session_status` broadcasts; the runtime
status-change hook is wired to it.

On `user_prompt`: resolve the viewed session's runtime (else `error`). **Attachment guard
(2026-06-16):** the message may carry images (base64 + media type); the handler rejects the whole
turn with `error { code: 'prompt.unsupportedFile' }` on the first non-image media type — c3 forwards
images only, no generic files. Validated images flow into whichever vendor path the run forks to. If
the runtime is `team` and has a live run handle, do **not** launch a second run — emit the `user_text`
echo, set status running, and push the input (AS-R17). Otherwise, if it already has a run, reject with
`error` (serial, AS-R2). The server stays strictly single-turn here; the web console hides this
rejection from the user by **client-side queuing** — for an ordinary running session it withholds the
`user_prompt`, queues the text locally, and only sends it (merged into one prompt) once the session
returns to idle (see [web-console design](../web-console/web-console-design.md), WC-R17). The server sees just one
ordinary turn at a time and is unaware of the queue. Otherwise create a fresh abort controller, set
the run, emit the `user_text` echo, set status running, derive `resume`, and start the run with a send
callback into the runtime and the team hook. The run id is mutable: binding pending→real updates it so
post-bind events target the real key. In the finally block: clear the run if still current, emit a
synthetic `turn_end` if the run was stopped (so a viewing input unlocks), set status idle, and refresh
the session list. **No abort of any other session.**

On `select_session` / `create_session`: remove the old viewer, then either reuse the existing runtime
or seed a cold one from disk; send `session_selected` (history = baseline, running = whether a run is
in flight), replay the buffer as live events, then add the viewer. The replay block has no await, so
it is atomic against concurrent emits. `stop_run` stops the viewed session's run.

## Stop / interrupt

```mermaid
sequenceDiagram
    participant UI
    participant WS as connection handler
    participant REG as runtime registry
    participant RUN as run loop
    participant SDK as query()
    UI->>WS: stop_run (viewed session)
    WS->>REG: stop the viewed session's run
    REG->>RUN: abort
    RUN->>SDK: close input  (ends the streaming prompt → query loop terminates)
    RUN->>SDK: interrupt  (Promise; .catch swallows late rejection)
    Note over WS: finally emits turn_end(complete); status → idle
```

The abort listener does two things: closing the input ends the streaming-input prompt — this is the
**only** way a team session stops, since its input never auto-closes (AS-R16) — then `interrupt()`
cuts the in-flight turn. `interrupt()` may reject asynchronously ("ProcessTransport is not ready for
writing") when the query already finished or hasn't streamed; the rejection is swallowed so it never
crashes the process (AS-R6, AVAIL-4). Switching the view or closing the socket never reaches this
path.

## Message mapping (SDK → wire)

The iteration over `query()` maps each SDK message (AS-R9):

| SDK message | Block                         | Wire event                                                                                                                                                                |
| ----------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `system`    | `init` (has session id)       | report the session id once (AS-R10)                                                                                                                                       |
| `assistant` | text                          | `assistant_text { text }`                                                                                                                                                 |
| `assistant` | tool-use (has id + name)      | `tool_use { toolUseId, toolName, input }`; if it is a team tool ⇒ fire the team hook once first (AS-R14)                                                                  |
| `user`      | tool-result (has tool-use id) | `tool_result { toolUseId, content, isError }`                                                                                                                             |
| `result`    | —                             | if the turn emitted no visible block ⇒ `notice { text }` first, then `turn_end { reason: 'complete' }`, then fork: non-team closes the input; team keeps it open (AS-R15) |

- The user prompt is echoed once as `user_text { text }` before the run starts (AS-R1), so a
  switch-back replay shows it (it is not in the on-disk baseline captured earlier).
- A turn that produces only a thinking block (the model thought, then ended with no text or tool-use)
  is tracked per turn; the `result` branch then emits `notice { text }` before `turn_end` so the turn
  renders a muted line instead of a silent gap (an empty turn is otherwise indistinguishable from a
  hang). The flag resets per turn (a team lead reuses one process across turns). On-disk replay mirrors
  this per **turn**, not per message: the transcript splits one turn into several single-block messages
  (a thinking message, a text message, a tool-use message…), so a lone thinking message is usually just
  the lead-in to a turn that continues — the notice is added only when a whole turn (up to the next real
  user prompt) thought but produced no assistant text and no tool call.
- Tool-result content is flattened (string as-is; array → text blocks joined by newline, non-text
  JSON-stringified; else JSON-stringified).
- An exception in the loop, when not aborted, sends `turn_end { reason: 'error', error }` (AS-R7). When
  stopped (aborted), the run loop sends no terminal event; the connection's finally emits a synthetic
  `turn_end { reason: 'complete' }` so the viewing input unlocks.
- The loop checks the abort signal each iteration and breaks.

### Socket-disconnect auto-resume (AS-R18 / AS-R19, AVAIL-7)

The catch block classifies the error in a fixed order so the two paths never cross:

1. **Socket disconnect** (a narrow, single-phrase matcher for `socket connection was closed
unexpectedly`, deliberately disjoint from the degradable-error matcher) — if a socket-disconnect
   callback is wired, the run defers (no `turn_end`) and reports the error plus a side-effect-pending
   verdict. The side-effect-pending flag comes from a live set mirroring the side-effect computation: a
   **side-effect-class** tool-use opens an entry, its tool-result closes it; a non-empty set at
   disconnect time means a write may be half-applied (AS-R19). The allowlist of side-effect-**free**
   tools is conservative — anything not in it (incl. `Bash` and unknown/MCP tools) counts as a side
   effect.
2. **Degradable error** — the existing degradation-chain bypass.
3. Otherwise — a terminal `turn_end { reason: 'error' }`.

The server owns the bounded retry guard. On a socket disconnect, a pure decision returns auto-resume
only when the conjunction holds (auto-resume on, gate clear, single retry unspent, a real run id, not a
team, not aborted). On auto-resume: mark the retry spent, set status `reconnecting`, await a 3–5s
abortable backoff, then re-run with `resume` to the same id + a reconnect-attempt flag (same SDK
session ⇒ full context). The resumed run re-pushes the original prompt as the continuation turn; this
is safe _because_ the gate already guaranteed no unclosed **write** tool-use (AS-R19) — at worst a read
is repeated, never a write duplicated. The successful resume emits its own `turn_end { reason:
'complete', reconnect_attempted: true, retry_count: 1 }`. Otherwise the decision returns manual-error,
whose `turn_end { reason: 'error', side_effect_pending, original_error, … }` the server emits before
settling to idle. A socket disconnect is **never** degradable — it leaves the degradation loop rather
than trying the next agent — and is bounded to **one** resume per turn. Because the resume reuses the
same run id (single live runtime instance, the run never null across the backoff), it cannot race the
liveness-reconcile zombie cleanup.

## Team sessions (persistent agent teams)

A run becomes a persistent **agent team** when the lead delegates work that must outlive the current
turn — without keeping the lead process alive, the lead's `result` would close a string prompt's query,
exiting the process and orphaning/killing background teammates before their results return (the
motivating bug; ADR 0008).

**Detection** is evaluated on each tool-use block before that turn's `result`, firing the team hook
exactly once:

| Tool                                      | Team? | Why                                                  |
| ----------------------------------------- | ----- | ---------------------------------------------------- |
| `TeamCreate`                              | yes   | only exists in team mode                             |
| `SendMessage`                             | yes   | only exists in team mode                             |
| `Agent` with `run_in_background === true` | yes   | a detached teammate that reports back asynchronously |
| `Agent` (foreground)                      | no    | a sub-agent that completes within the turn           |

**Lifecycle:**

1. The team hook → server marks the runtime a team, emits `team_upgraded` (recorded in the buffer, so
   reconnect replay shows it), and sets status `team`.
2. On `result`, the team run keeps the input open (vs. a non-team run closing it); the lead process
   stays alive and the SDK re-wakes it on the next turn (a teammate notification or a pushed user
   prompt). The runtime stays `team` because the emitted `turn_end` would imply idle, but the team
   override holds it (see [session-registry design](../session-registry/session-registry-design.md)).
3. Next user turn: the server pushes it into the live session — no second run, no `resume` — after
   echoing `user_text` and setting running (AS-R17).
4. End: only on user stop. The abort listener closes the never-auto-closing stream (plus `interrupt`);
   the run's finally resets the team flag and falls back to idle (AS-R16). There is no automatic "team
   disbanded" detection.

## claude executable lookup

The claude lookup (memoized): `$CLAUDE_PATH` if set, else `command -v claude`. Returns nothing if not
found, in which case the option is omitted and the SDK falls back to its own lookup. Rationale and the
single-binary context are in ADR 0003.

## Technology choices

- **Hono + its Node WebSocket adapter** for HTTP and WebSocket upgrade.
- **An abort controller** as the abort signal bridged to `interrupt()`.
- **Discriminated-union narrowing** on the type tag for both SDK blocks and wire messages; no
  type-laundering beyond the minimal structural casts at the untyped SDK boundary (the SDK block shapes
  are unknown until narrowed).

## Non-functional considerations

- **Single in-flight run per session** (serial, AS-R2); **many sessions concurrent**, no cap.
- **Runs survive disconnect** — they live in the module-level registry, not the socket (ADR 0006,
  AS-R8); reconnect replays via baseline + buffer.
- **Error surfacing** never silent (AVAIL-1, AS-R7).
- **No persistence of run/permission state** — in-memory in the registry (SEC-2); buffers are not
  evicted (acceptable for a local single-user tool). Session continuity comes from the SDK transcript
  store via `resume`; the workspace/session registry is persisted by
  [session-registry](../session-registry/session-registry-design.md) (ADR 0004).

## Dependencies

- **`@anthropic-ai/claude-agent-sdk`** — `query()` (streaming-input prompt), `setPermissionMode`,
  `interrupt`; agent-team tools (`TeamCreate` / `SendMessage` / background `Agent`).
- **host `claude` CLI** — required at runtime; absence surfaces as a run error.
- **permission-gateway** — decision wait/resolve.
- **agent-config** — supplies the run's `env` overrides and `model` (the bound or default agent's
  Claude config).
