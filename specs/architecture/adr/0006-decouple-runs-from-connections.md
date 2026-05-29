# 0006 — Decouple agent runs from WebSocket connections

- **Status:** accepted
- **Date:** 2026-05-29

## Context

c3's first design bound an agent run to the WebSocket connection that started it: the
per-connection closure held the single `runAbort`/`runHandle`, and `create_session`,
`select_session`, and `user_prompt` each called `runAbort?.abort()` before proceeding.
Consequences:

- Switching the viewed session **killed** the running one — only one session could make
  progress at a time, and looking away from a long task aborted it.
- Closing the socket (refresh, tab close) discarded all run state and aborted the run.
- Live stream events were sent straight to the one connection's socket; there was no notion
  of "which session this event belongs to", so a backgrounded session had nowhere to put its
  output.

Users want multiple sessions running concurrently: switch away and the run keeps going in the
background; switch back and see everything that happened while away.

## Options considered

1. **Keep runs per-connection, multiplex in the browser.** Open one WebSocket per session
   from the browser. _Con:_ duplicates connection state, complicates the single-contract wire
   protocol, and still loses runs on refresh; the server remains the wrong owner of run
   lifetime.
2. **Module-level session-runtime registry; connection becomes a pure view.** Runs live in a
   process-wide `Map<sessionId, SessionRuntime>`, each owning its abort/handle, an in-memory
   event buffer, and the set of viewers currently watching it. A connection only records which
   session it views and subscribes/unsubscribes as it switches. _Pro:_ runs survive switching,
   refresh, and disconnect; one connection can drive many concurrent sessions; replay is
   exact. _Con:_ in-memory buffers grow with transcript length; cross-process writers (e.g. the
   `claude` CLI) aren't observed once a runtime exists.

## Decision

Adopt option 2. A `SessionRuntime` (in `server/src/runs.ts`) owns one session's execution,
decoupled from any connection:

- **Baseline + buffer replay.** On first entry the runtime snapshots the on-disk transcript as
  `baseline`; every wire event since is appended to `buffer`. A connection switching back
  replays `baseline + buffer` — disk is read exactly once per session per process, so there is
  no disk/live double-counting.
- **Pub/sub fan-out.** `emit(sessionId, event)` appends to the buffer and delivers to that
  session's current `viewers`. A connection adds itself as a viewer on select and removes
  itself on switch-away or close.
- **No abort on view change or disconnect.** Switching sessions and closing the socket only
  change/clear subscriptions; the run continues in the background until it finishes or is
  explicitly stopped (`stop_run`).
- **Serial per session, concurrent across sessions.** A session refuses a new prompt while its
  own turn is in flight; different sessions run concurrently with no fixed cap.
- **Status broadcast.** Each runtime carries `idle | running | awaiting_permission`; any change
  broadcasts `session_status` to every connection so sidebars can badge background sessions.

## Consequences

- **Easier:** true multi-session concurrency; refresh/reconnect resumes the view of a live run;
  background sessions surface status, awaiting-permission highlight, and browser notifications.
- **Harder:** the server now holds run state for the process lifetime (in-memory buffers, no
  eviction yet) — acceptable for a local single-user tool. A run with no viewers still consumes
  resources until it ends or is stopped.
- **Migration:** the per-connection `runAbort`/`runHandle`/`activeSession`/`activeMode` fields
  are gone; the connection holds only `viewing`. Permission decisions remain global by
  `requestId`, so a backgrounded session's prompt is answerable after switching back. The
  superseded "closing the socket aborts the in-flight run" rule (architecture cross-cutting,
  agent-session AS-R8) is replaced.

## Compliance

- Runs MUST NOT be aborted by `select_session`, `create_session`, or connection close — only by
  `stop_run`, `delete_session`, or `remove_workspace`. Reviewers reject any `abort()` on the
  view-change paths.
- Every live stream event MUST flow through `emit()` (buffer + viewers), never directly to a
  socket, so replay stays complete.

## References

- [agent-session spec](../../domains/core/agent-session/spec.md) — run lifecycle & rules.
- [session-registry spec](../../domains/core/session-registry/spec.md) — viewed session vs runtime.
- [WebSocket protocol](../../shared/api-conventions/websocket-protocol.md) — `stop_run`,
  `session_status`, `user_text`, `session_selected.running`, `ready.statuses`.
- Supersedes the per-connection-abort aspect of [ADR 0002](0002-websocket-as-permission-transport.md)'s
  connection model (the transport decision itself stands).
