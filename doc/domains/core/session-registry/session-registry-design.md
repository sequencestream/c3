# session-registry — Design

Implements the [spec](session-registry-spec.md). It is built from a persistence concern (the registry on disk),
a session enumeration/IO concern (the vendor session API plus transcript mapping), and the WS
handler (per-connection active session plus event dispatch).

## Responsibilities

| Concern                       | Notes                                                                  |
| ----------------------------- | ---------------------------------------------------------------------- |
| Persisted registry            | Module-level cache; atomic write (temp + rename); fail-soft            |
| Vendor session enumeration/IO | List / load history / rename / delete                                  |
| Viewed session + dispatch     | Per-connection viewed session; per-session mode lives on the runtime   |
| Session runtimes              | Per-session run/buffer/status/team flag (agent-session, ADR 0006/0008) |

## Persistence

- Location: `${CLAUDE_CONFIG_DIR:-~/.claude}/c3/state.json`.
- Loaded lazily into a module cache; every mutation persists synchronously.
- **Atomic write:** write a per-process temp file then atomically rename over the target.
- **Fail-soft:** a missing/corrupt file (or write error) falls back to empty state and logs;
  c3 must still boot (ADR 0004, AVAIL).
- Adding a workspace validates the path is a directory (SR-R1) and is idempotent; selecting/creating
  bumps `lastAccessed` (SR-R3); listing returns a copy sorted by `lastAccessed` desc.

## Session IO

The vendor session API backs four registry operations:

| Operation                   | Maps to                                                       |
| --------------------------- | ------------------------------------------------------------- |
| List a workspace's sessions | Session entries + per-session mode, newest first              |
| Load a session's history    | Transcript items (see mapping)                                |
| Remove a session            | Deletes the transcript + drops the session's tool-session tag |
| Rename a session            | —                                                             |

**Unified projection listing (ADR-0013, 2026-06-28 amendment).** The wire
`list_sessions` path reads the `session_metadata` projection cache in c3.db
instead of enumerating the vendor stores directly on every read. The projection
is a rebuildable cache — the per-vendor enumeration accessors are the rebuild /
lazy-validation source for work sessions, not the daily read source. The read
path queries per workspace and `session_kind`, filters to `bound = 1`, maps each
row to a session entry (additive `state`, `sessionKind`, `ownerKind`, `ownerId`,
and `bound` fields), applies the hidden-set and recorded-tool-session filters
for work listings, and sorts newest-first. The session page uses the same
projection for its six tabs (work / intent / spec / discussion / schedule /
tool) and running-count badges; this phase wires real rows for work, intent,
and spec, with the other kinds reserved as gray placeholders until their domain writers
are connected. Spec rows are written by the intent-management spec lifecycle at bind time with
`session_kind='spec'` and an intent owner, so selecting them jumps back to the owning intent's
spec-session tab instead of opening them as ordinary work sessions. Work-only pre-bind rows are
represented by `bound = 0`; the legacy `kind` column is retained but no longer drives read
behavior.

For work listings, the read path filters two classes out before mapping: the project's
**hidden set** (intent/spec comm sessions, owned by intent-management) and **tool-created
sessions** (completion judge / consensus advisor) unless the show-tool-sessions setting is on. The
intent and spec tabs do not apply that hidden-set filter to themselves.
Tool sessions are tagged when a tool query reports its session id, which writes through to the
persisted tool-session table so the tag — and thus the default-off filter — survives restarts;
an in-memory-only set would be empty after a restart and leak historic tool sessions into the
list. The tool-session check reads the in-memory cache first and falls back to the db. Removing
a session deletes the transcript **and** the persisted tag, so a reused id is not misclassified.

Transcript mapping mirrors the live mapping in agent-session so replayed history renders
identically: assistant text / tool-use map to assistant / tool-use items; user
string/text / tool-result map to user / tool-result items (tool-result content flattened to text).

## Per-connection state

Each connection tracks the session it watches (real or `pending:`).
The working directory and per-session mode are read from the viewed session's runtime, not
connection fields. `set_mode` updates the runtime's mode, persists it for a real session (pending
persists on bind), pushes it to the in-flight run if any, and confirms with `mode_changed` (SR-R5).
The persisted `activeSessionId` is updated on select/bind as a restart hint.

## Pending-session binding

```mermaid
sequenceDiagram
    participant UI
    participant WS as Server
    participant RUN as Agent run
    UI->>WS: create_session(ws)
    WS->>UI: session_selected (sessionId=pending:…, history=[])
    UI->>WS: user_prompt(text)
    WS->>RUN: start run (cwd, no resume id, mode from runtime)
    RUN-->>WS: reports real session id (from the run's init)
    WS->>WS: bind pending→realId; persist mode + activeSessionId; viewed=realId
    WS->>UI: session_started(clientId=pending:…, sessionId=realId)
    Note over WS,UI: on run end → sessions list refreshed (real title)
```

Binding re-keys the runtime (buffer/viewers/run move with it). A `select_session` of an
existing session passes its id as the resume id; the run reports the same id back, so no rebind
occurs (rebind is guarded on the reported id differing from the runtime's id).

## Switching & concurrency

Switching is a **view** change, not a run change. `create_session` and `select_session`
swap the connection's viewer from the old session to the new one and replay the new session's
record; they **never** abort a run (ADR 0006, AS-R8). Many sessions run concurrently; a single
session is serial — a `user_prompt` for a session with a turn already in flight returns an
`error` (AS-R2). `user_prompt` requires a viewed session; otherwise an `error` is returned.

## Team-session status

A runtime carries a team flag (default off), set on when a run uses a team tool and reset off when
the run tears down (agent-session, ADR 0008). It changes status semantics: a `turn_end` normally
implies idle, but while the team flag is set the implied idle is overridden to the team status.
So a team lead's `turn_end` reports team, not idle — the lead process is alive between turns,
not free. A team session's next `user_prompt` is pushed into the live run rather than launching
a new one (AS-R17, agent-session design § Team sessions).

## `turn_end` → idle is held until teardown

The normal completion path emits its `turn_end` from **inside** the run loop, so the run's teardown
(which clears the run pointer) has not happened yet. If the status settled to idle there, it
would broadcast idle while the run is still alive. The client derives "running" purely from
broadcast status (§ Client-side reconciliation): it sees the running→idle transition and flushes
its **pending-send queue** as a fresh `user_prompt`, which the server then rejects with "a turn is
already running" (AS-R2) — silently dropping the queued prompt. The teardown gap is the entire
agent query winddown (input close → iterator end), tens-to-hundreds of ms, so the flush reliably
wins the race.

So the status layer **holds** a `turn_end`'s implied idle while the run pointer is still live,
keeping the current status until the run actually tears down. The terminal-state backstop then
re-settles to idle from the teardown step — **after** the run pointer is cleared — so the broadcast
idle and the server's readiness to accept a new `user_prompt` are consistent, and the flushed prompt
lands on a genuinely-ready session. This holds for both complete and error `turn_end`s. Precedence
among the idle-overrides: an unanswered permission prompt (→ awaiting-permission, the consensus-window
guard) outranks the team hold (→ team), which outranks the run-alive hold (→ no change). The
`turn_end` **wire event** still reaches viewers regardless — it just no longer drives the status to
idle early.

## Terminal-state guarantee

Client "running"/"thinking" is derived purely from broadcast status, so a turn that never
broadcasts its end leaves the viewer stuck (and its pending-send queue unflushed). The normal
end signal is the agent's result → `turn_end` (agent-session). But the run loop can finish
**without** a result: the agent iterator ends or the Claude process exits mid-turn. Then neither
the result branch nor the error handler fires, so no `turn_end` reaches viewers.

A **terminal-state backstop** runs from the server's run teardown (after the run pointer is
cleared, the team flag reset, and pending sends cleared). It:

- synthesizes a `turn_end` with reason `complete` **iff** none was broadcast this turn, then
- **unconditionally** settles the session to idle (no longer only when the run was aborted).

Idempotency uses a per-runtime "saw turn-end" flag: it is set on any `turn_end` and re-armed to
false at turn start. So a normal completed run gets only the idle settle (no
duplicate `turn_end`), while a loop that ended without a result gets a synthesized one. The
run-loop layer carries the same guarantee defensively: its teardown emits a
terminal `turn_end` when the iterator ended without a result (non-team, non-aborted), so the
two layers agree and the saw-turn-end / saw-result flags prevent a double emit.

## Session-layer heartbeat & liveness reconciliation

In addition to the edge-triggered status broadcast (above), the server runs a **periodic
heartbeat** (every 15 seconds) that:

1. **Reaps stale/hung runs** via a liveness reconciliation pass before broadcasting, so the
   snapshot is always authoritative, then
2. **Unconditionally broadcasts** `session_status` to all connections, so a client that missed an
   event-driven broadcast (reconnect race, background tab, dropped frame) corrects within one
   heartbeat period.

### Liveness reconciliation pass

For every runtime with a live run pointer:

- **Aborted branch:** the run's abort signal is set → the run was requested to stop but its
  teardown never ran (zombie). Converge **regardless** of status — this is the only path that
  converges awaiting-permission and team sessions.
- **Stale branch:** status is running and no events have been emitted for longer than the stale
  threshold → the agent iterator/loop is presumed hung or the Claude process exited mid-turn.
  Converge to idle.
- **Dangling-pointer branch:** status is idle while the run pointer is still live → a status/run
  inconsistency. The primary cause — a normal `turn_end` settling idle before teardown cleared the
  run pointer — is now prevented at the source (§ `turn_end` → idle is held until teardown), so this
  is a **defensive backstop** for any residual path that settles idle with a live run pointer.
  Broadcasts would otherwise advertise the session as idle while `user_prompt` still rejects with
  "a turn is already running"; the stale branch (gated on running) never reaps it. Converge so
  client and server agree.
- **Preserved:** awaiting-permission and team are **not** converged by staleness alone — a
  user waiting on a prompt is legitimate, and a team lead waiting between turns is legitimate.

Convergence mimics the run launcher's teardown:

1. Abort the run (safe if already aborted)
2. Clear the run pointer
3. Reset the team flag; clear pending sends
4. Run the terminal-state backstop — synthesises a `turn_end` (if needed), settles to idle, and
   triggers a status-change rebroadcast.

The stale threshold defaults to 5 minutes — conservative enough to avoid false-positives
from long-running tools (build, deploy) that emit no intermediate events.

### Client-side reconciliation

The client pulls the authoritative snapshot on three triggers:

- **Periodic** — a 15-second interval sends `request_session_status`.
- **Visibility restore** — becoming visible sends `request_session_status`.
- **Reconnect** — a socket reopen sends `request_session_status`.

On receiving `session_status`, the client does a **full-table replace** of the local
session-status map and fires a level-triggered flush backstop. Any discrepancy
between the local stale state and the server's snapshot is corrected at the next arrival.

The transport-layer ping/pong is unchanged — it only probes socket half-open. The
session-layer heartbeat is a distinct concern.

## Non-functional considerations

- **Only metadata persisted** — never permission state (SR-R11, ADR 0001/0004).
- **Recent-access order** is the workspace sort; sessions sort by SDK `lastModified`.
- **Stale ids** in `sessionModes` are harmless and ignored on read.

## Dependencies

- **Claude Agent SDK** — session enumeration, history, rename, delete.
- **agent-session** — receives working directory / resume id / mode; returns the bound `sessionId`.
- **Node filesystem APIs** — atomic JSON persistence under the config dir.
