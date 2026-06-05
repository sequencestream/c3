# agent-session — Domain Spec

## Overview

An agent session turns a user prompt into a Claude Agent SDK `query()` run, streams the run's
activity, gates sensitive tools through the [permission-gateway](../permission-gateway/spec.md),
and lets the user steer the run via permission mode and interruption.

A run is **not** bound to the browser connection that started it. Each session has a
process-wide **Session Runtime** that owns its run; a connection is only a **view** onto a
session (which one it currently watches). Switching the view or closing the socket never stops
a run — it keeps going in the background, and a returning view replays everything that happened
(ADR 0006). Different sessions run **concurrently** with no fixed cap; a single session is
**serial** (one turn at a time) — except a persistent **agent team** session, where the lead
process stays alive between turns and the user may push further turns into it (AS-R13/R14).

Every run drives the SDK in **streaming-input mode** (a controlled async-iterable prompt)
rather than a one-shot string. A normal session ends each turn's underlying process by closing
the stream on `result` (so the next turn resumes a fresh process — the one-shot behaviour); a
team session keeps the stream open so the lead process outlives the turn (ADR 0008).

The run's context — working directory (`cwd`), starting permission mode, and the `resume`
session id — comes from the runtime, seeded by the
[session-registry](../session-registry/spec.md).

**Scope:** run lifecycle (start, stream, end, stop), background execution & replay buffering,
permission-mode policy, session continuity (`resume`), persistent agent-team sessions, live
status, and faithful mapping of SDK messages to wire events. **Boundary:** it does not decide individual permissions (gateway),
does not manage the workspace/session registry (session-registry), and does not render UI
(web-console).

## Core entities

| Entity          | Description                                                                                                         |
| --------------- | ------------------------------------------------------------------------------------------------------------------- |
| Session Runtime | Process-wide owner of one session's execution: its run, `baseline + buffer` for replay, current viewers, and status |
| Agent Run       | One `query()` invocation driven by one user prompt                                                                  |
| Run Handle      | Live controls over an in-flight run: set permission mode, and push the next user turn into a live team session      |
| Connection View | One WebSocket connection's subscription to the session it currently watches (delivers live events; replays on join) |

See [models.md](models.md).

## Business rules

| ID     | Rule                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AS-R1  | A `user_prompt` starts a new Agent Run against the viewed session's runtime, with that session's `cwd`, permission mode, and (for an existing session) `resume` id. The prompt is echoed into the stream as `user_text` so every viewer (and switch-back replay) shows it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| AS-R2  | A session is **serial**: at most one Agent Run is in flight per session. A `user_prompt` for a session whose turn is already in flight is rejected with `error` and starts nothing. Different sessions run **concurrently** with no fixed cap.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| AS-R3  | Permission mode is **per session** (owned by the runtime, mirrored to session-registry). A run starts in the session's mode; `set_mode` changes only the viewed session's mode.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| AS-R10 | A run reports its SDK session id (from the `init` message) so a pending session binds to a real id and subsequent prompts `resume` it. Binding **re-keys** the runtime (buffer, viewers, run move with it); a resumed run keeps the same id.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| AS-R4  | A `set_mode` applies to the viewed session's in-flight run immediately if one exists; otherwise it takes effect on that session's next run. The change is confirmed with `mode_changed`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| AS-R5  | The mode determines which tool calls are sensitive and thus reach the gateway. `bypassPermissions` authorizes auto-execution of all tools; `acceptEdits` auto-accepts edit-class tools; `default`/`auto`/`plan` route sensitive calls to the gateway per the SDK classifier.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| AS-R6  | A run is stopped only by `stop_run` (the viewed session), `delete_session`, or `remove_workspace` — never by switching the view or closing the socket. Stopping interrupts the underlying `query()`; a run already finished or not yet streaming is interrupted harmlessly.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| AS-R7  | A run ends with exactly one terminal outcome: `turn_end` with `reason: 'complete'` (the SDK produced a result, or the run was stopped) or `reason: 'error'` (an exception). `turn_end` never means the session ended — it stays alive for the next prompt.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| AS-R8  | Closing the connection only unsubscribes its view; the run **continues in the background** in its runtime. Reconnecting and selecting the session replays the full record and resumes live delivery.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| AS-R9  | Only the model's text blocks, tool-use blocks, and tool-result blocks are mapped to the wire; other SDK message kinds are ignored.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| AS-R11 | Every live event is recorded in the runtime: appended to its `buffer` and fanned out to current viewers via `emit`. A view joining a session replays `baseline` (on-disk snapshot at runtime creation) then `buffer`, so the full record is reconstructed with no duplication.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| AS-R12 | Each runtime has a status — `idle`, `running`, `awaiting_permission`, `team`, or `reconnecting`. Any change broadcasts `session_status` to **all** connections so backgrounded sessions surface their state.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| AS-R13 | Every run drives the SDK in **streaming-input mode**: the prompt is a controlled async-iterable seeded with the user's first turn, not a one-shot string. This keeps the SDK control channel live (so `set_mode`/stop genuinely reach the run) and lets a turn's process outlive a single `result` (ADR 0008).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| AS-R14 | A run is recognized as a persistent **agent team** at runtime: when the first **team tool** is used, the runtime is marked `team` once and `team_upgraded` is emitted. A team tool is `TeamCreate`, `SendMessage`, or a background `Agent` (`run_in_background === true`); a foreground `Agent` is **not** (it finishes within the turn). Detection happens before that turn's `result`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| AS-R15 | On `result`, the run emits `turn_end { reason: 'complete' }`. A **non-team** run then closes its input stream — the underlying process exits and the next prompt resumes a fresh one (the one-shot behaviour). A **team** run keeps its input open: the lead process stays alive between turns to coordinate teammates, so the run remains in flight (status `team`, not `idle`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| AS-R16 | A team session ends **only** when the user explicitly stops it (`stop_run` / `delete_session` / `remove_workspace`): aborting closes the input stream, which is the sole way a team's stream is closed (it never auto-closes). There is no automatic team-teardown detection — "team lead is done" is equated with explicit user stop.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| AS-R17 | While a session is `team`, a `user_prompt` is **not** rejected and does **not** start a second run; it is echoed as `user_text` and pushed as the next user turn into the live lead session (no `resume`, no new process). The user may send even while the lead is mid-turn — the SDK queues it. (For non-team sessions AS-R2 still holds.)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| AS-R18 | A **normal** user session whose turn fails with `socket connection was closed unexpectedly` (a narrow classifier, **separate** from the degradation-chain classifier — a socket disconnect never enters `agentsToTry`) auto-`resume`s the **same** run **once**, after a bounded 3–5s backoff, with `resume: runId` so the full context is preserved (never a fresh session). The retry is **bounded to one per turn**; during the backoff the status holds at `reconnecting`. If the resume succeeds, the turn's `turn_end` carries `reconnect_attempted: true` (and `retry_count`). If auto-resume is refused (AS-R19), disabled (`socketAutoResume: false`), there is no real session id, the session is a `team`/`requirement`, or the single retry is already spent, the turn ends with `turn_end { reason: 'error' }` (carrying `original_error` and the gate verdict) and settles to `idle` — the user continues manually (a normal `user_prompt` resumes the same session). Never silently hangs (AVAIL-1/AVAIL-7). |
| AS-R20 | **Keepalive env injection** (the socket-disconnect _prevention_ layer — scheme E's first line of defence, paired with the AS-R18/R19 recovery layer). Every Claude Code child a run spawns receives a fixed set of transport-resilience env vars — `CLAUDE_CODE_REMOTE_SEND_KEEPALIVES=true`, `BUN_CONFIG_HTTP_IDLE_TIMEOUT`, `BUN_CONFIG_HTTP_RETRY_COUNT` — to lower the _rate_ of `socket connection was closed unexpectedly` at the source. They are injected with **lowest priority**: a same-named value the user (shell `process.env`) or the active agent (`envOverrides`) set explicitly always wins (user priority). They apply even to the system agent (which has no overrides). Decoupled from auto-resume — it ships independently and changes only the child env, never the resume/gate logic.                                                                                                                                                                                                               |
| AS-R19 | **Tool side-effect gate** (the auto-resume guard): from the SDK message stream, c3 infers mid-turn state by pairing `tool_use`↔`tool_result`. If, at disconnect time, a **side-effect-class** `tool_use` is still open (no `tool_result` yet), `side_effect_pending` is true and auto-resume is **refused** (a write may have half-applied). The classification is **conservative**: only `Read/Grep/Glob/LS/NotebookRead/WebFetch/WebSearch/TaskCreate/TaskList/TaskUpdate/TaskGet/AskUserQuestion` are side-effect-free; **everything else** — `Write/Edit/MultiEdit/NotebookEdit/Bash` and any unknown / MCP tool — counts as a side-effect tool. The bias is deliberate: rather miss an auto-resume (fall back to manual continue) than wrongly auto-resume after a possible write.                                                                                                                                                                                                                                     |

## States & transitions

### Session Runtime status (process-wide, per session)

```mermaid
stateDiagram-v2
    [*] --> Idle: runtime created (create/select)
    Idle --> Running: user_prompt
    Running --> AwaitingPermission: permission_request
    AwaitingPermission --> Running: decision resolved
    Running --> Idle: turn_end (complete/error) or stop_run
    AwaitingPermission --> Idle: stop_run
    Running --> Reconnecting: socket disconnect, gate clear (AS-R18/R19)
    Reconnecting --> Running: single auto-resume (resume: runId, backoff elapsed)
    Reconnecting --> Idle: stop_run during backoff
    Running --> Idle: socket disconnect refused/exhausted ⇒ turn_end error (AS-R18)
    Running --> Team: team tool used (team_upgraded)
    Team --> Team: turn_end (lead turn done; process stays alive) / user_prompt (push)
    Team --> Running: user_prompt resumes a lead turn
    Team --> AwaitingPermission: permission_request
    Team --> Idle: stop_run (only)
    Idle --> [*]: delete_session / remove_workspace
```

Switching the view and closing the connection do **not** change runtime status — the run runs
on in the background (AS-R8). Status changes broadcast `session_status` (AS-R12). The `Team`
state holds the lead process alive between turns; it returns to `Idle` only on explicit user
stop (AS-R15/R16).

### Connection View

```mermaid
stateDiagram-v2
    [*] --> None: connection open
    None --> Viewing: create_session / select_session (subscribe; replay baseline+buffer)
    Viewing --> Viewing: select other (unsubscribe old, subscribe new)
    Viewing --> [*]: connection close (unsubscribe only; run survives)
```

### Agent Run

```mermaid
stateDiagram-v2
    [*] --> Streaming: query() created (streaming-input prompt)
    Streaming --> Streaming: assistant_text / tool_use / tool_result / permission_request
    Streaming --> Streaming: result while team (input stays open; awaits next turn)
    Streaming --> Complete: SDK result message (non-team ⇒ input closed)
    Streaming --> Errored: exception (and not stopped)
    Streaming --> Stopped: stop_run / delete / workspace removal (input closed + interrupt)
    Complete --> [*]
    Errored --> [*]
    Stopped --> [*]
```

For a team run, a `result` ends the _turn_ (emitting `turn_end`) but not the _run_ — the input
stream stays open and the lead process keeps running until stopped (AS-R15/R16).

## Permission modes

| Mode                | Meaning for tool gating                                                                                        |
| ------------------- | -------------------------------------------------------------------------------------------------------------- |
| `default`           | SDK invokes the gateway only for sensitive tools; read-only auto-allowed.                                      |
| `auto`              | Like default, biased toward auto-progress where the SDK deems safe.                                            |
| `plan`              | Planning mode; the agent proposes without executing changes.                                                   |
| `acceptEdits`       | Edit-class tools auto-accepted; other sensitive tools still gated.                                             |
| `bypassPermissions` | All tools auto-executed; gateway not consulted. Requires explicit user selection (constitution C-SEC-2/SEC-7). |

The exact classification is owned by the SDK; c3 selects the mode and surfaces it.

> **Vendor dimension (ADR-0011).** The five modes above are Claude's `PermissionMode`,
> the wire/UI surface today. Underneath, `kernel/agent/adapters/` introduces a vendor-neutral
> abstraction so this domain can drive Codex / OpenCode as well as Claude: the run lifecycle is an
> `AgentDriver`, the gateway is an `ApprovalBridge`, history is a `SessionStore`, and the five-way
> mode is reduced to a neutral `ActionMode{plan,build} × ToolGate{...}` grid each adapter translates
> into. Per-vendor divergence (Codex has no per-tool approval; only Claude forks/streams) lives in a
> probed `AdapterCapabilities` ledger, not this spec's mode table. The Claude path described here is
> the **reference adapter**; the run loop is not yet rewritten to route through the driver (additive
> phase). No vendor SDK type crosses into the neutral surface or `shared/protocol.ts` (ADR-0009).

## Domain events (wire)

Emits `mode_changed`, `user_text`, `assistant_text`, `tool_use`, `tool_result`, `turn_end`,
`team_upgraded` (one-shot, on team detection — AS-R14), and `session_status` (run-status
broadcast). Consumes `user_prompt`, `set_mode`, `stop_run`, `ping`. Forwards `permission_request` on behalf of the gateway. Reports the run's SDK session id
to session-registry (which emits `session_started`). Workspace/session events (`ready`,
`workspaces`, `sessions`, `session_selected`) belong to
[session-registry](../session-registry/spec.md). Shapes in the
[shared protocol](../../../shared/api-conventions/websocket-protocol.md).

## User scenarios

- **Concurrent sessions:** Given a run in flight on session A, When the user selects session B
  and submits a prompt, Then both runs execute concurrently; neither is stopped.
- **Switch away & back:** Given session A is running, When the user views B then returns to A,
  Then A's full activity since it began (prompt, output, any pending permission) is replayed and
  live delivery resumes.
- **Stop (anti-scenario):** Selecting another session or closing the socket must **never** stop
  a run (AS-R6/AS-R8); only `stop_run`/`delete_session`/`remove_workspace` may.
- **Serial within a session (anti-scenario):** A second `user_prompt` for a session whose turn
  is in flight must **never** start a second concurrent run for that session (AS-R2).
- **Team forms:** Given a run uses a team tool (creates a team, sends a teammate message, or
  spawns a background `Agent`), When that turn's `result` arrives, Then the session is marked
  `team`, `team_upgraded` is broadcast, and the lead process stays alive instead of exiting.
- **Team next turn:** Given a `team` session, When the user submits another prompt, Then it is
  echoed and pushed into the live lead session (no new process, no `resume`); the lead continues
  in the same context.
- **Team only ends on stop (anti-scenario):** A `team` session must **never** drop to `idle` on
  a lead `turn_end`; it ends only on explicit `stop_run` / `delete_session` / `remove_workspace`
  (AS-R16).
- **Socket disconnect, safe state:** Given a normal session whose turn dropped the socket while
  the model was producing text (no open write `tool_use`), When the gate is clear, Then c3 backs
  off briefly (status `reconnecting`) and auto-`resume`s the same run once; the turn completes
  with `reconnect_attempted: true` and the full context is intact (AS-R18).
- **Socket disconnect, danger state (anti-scenario):** Given a turn dropped the socket while an
  `Edit`/`Write`/`Bash` `tool_use` was still unclosed, c3 must **never** auto-resume; it ends the
  turn with `turn_end { reason: 'error', side_effect_pending: true }`, settles to `idle`, and lets
  the user continue manually — which resumes the same session (AS-R18/R19).
- **Bounded reconnect (anti-scenario):** A turn must **never** auto-resume more than **once**, and
  a refused/exhausted disconnect must **never** hang silently — it always emits a terminal
  `turn_end` (AVAIL-1/AVAIL-7).

## Interactions

- **permission-gateway** — invoked from the run's `canUseTool`; blocks the run until
  resolved. A pending request survives switching away (decisions are keyed by `requestId`).
- **Claude Agent SDK** — `query()` provides the run, driven by a streaming-input prompt
  (AS-R13); `setPermissionMode` and `interrupt` steer it (effective only in streaming-input
  mode). Closing the input stream ends the query.
- **Claude Code agent teams** — the SDK feature whose team tools (`TeamCreate` / `SendMessage` /
  background `Agent`) upgrade a session to a persistent team (AS-R14).
- **claude CLI** — spawned by the SDK as the agent process; resolved from `$CLAUDE_PATH`
  or PATH.

## Data dictionary

- **In-flight run** — a Streaming Agent Run with a live Run Handle.
- **settingSources: ['user', 'project']** — the option that inherits user/project settings
  (hooks, allow/deny rules, Skills, `CLAUDE.md`); c3 is the gateway on top (ADR 0005).
