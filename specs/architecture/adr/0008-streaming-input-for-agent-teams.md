# 0008 — Streaming-input prompts for persistent agent teams

- **Status:** accepted
- **Date:** 2026-05-30

## Context

`runClaude` drove the SDK `query()` with a **string** `prompt` — a one-shot turn. The SDK ends a
string-prompt query the moment a `result` arrives: the async iterator finishes and the underlying
`claude` process exits. That is exactly the next-turn-via-`resume` model c3 wanted for normal
sessions.

It is, however, incompatible with **Claude Code agent teams**. When a team lead delegates a task
to a background teammate (a `run_in_background` `Agent`) it then yields a `result` for the current
turn — but the work is not done; the teammate is still running and must report back to the lead.
With a string prompt the lead's `result` closes the query and exits the process, so the teammate
is killed or orphaned and its result never reaches the lead. The team is dead on arrival.

A secondary problem: SDK **control requests** (`setPermissionMode`, `interrupt`) only take effect
in streaming-input mode. Under the string prompt they were issued but silently swallowed (wrapped
in a try/catch), so a mid-run `set_mode` and `stop_run`'s interrupt were effectively no-ops.

## Options considered

1. **Only team sessions use streaming input.** Detect a team somehow, then switch that session to
   a streaming prompt. _Con:_ the team must be detected **before** the query starts, but team-ness
   is only knowable once a team tool is actually used mid-run — you cannot switch a live string
   query to streaming. It also forks the run path into two code shapes.
2. **Pre-flag teams by entrypoint (e.g. `/develop-pipeline`).** Mark a session a team up front when
   it is launched via a known team-spawning skill. _Con:_ brittle and incomplete — a lead can form
   a team from any prompt, not just a blessed slash command; false negatives reintroduce the bug
   and false positives keep non-team processes alive for no reason.
3. **All sessions use streaming input; detect teams at runtime; fork on `result`.** Always drive
   `query()` with a controlled async-iterable prompt. Recognize a team when its first team tool is
   used. On `result`, close the stream for non-team runs (reproducing one-shot exit) but keep it
   open for team runs (lead stays alive). _Pro:_ one uniform run path; team detection is accurate
   because it watches the actual tool stream; fixes control requests for free. _Con:_ a tiny bit
   more machinery (the `InputStream` class) on every run, including those that never form a team.

## Decision

Adopt option 3.

- **Uniform streaming input.** Every run drives `query()` with an `InputStream` (a controlled
  async-iterable of user messages in `server/src/claude.ts`), seeded with the user's first turn.
  `push(text)` appends a turn to the same live session; `close()` ends the stream so the query
  terminates normally.
- **Runtime team detection.** On each `tool_use` block (before that turn's `result`), `isTeamTool`
  flags the run as a team and fires `onTeam` once. A team tool is `TeamCreate`, `SendMessage`, or a
  background `Agent` (`run_in_background === true`); a foreground `Agent` is not (it finishes within
  the turn).
- **`result` fork.** On `result` the run always emits `turn_end { complete }`; then a **non-team**
  run `close()`s its input (process exits — the one-shot behaviour, next turn `resume`s a fresh
  process), while a **team** run keeps the input open so the lead process stays alive to coordinate
  teammates across turns.
- **End only on explicit stop.** A team's input never auto-closes; the abort listener `close()`s it
  (plus `interrupt()`), making `stop_run` / `delete_session` / `remove_workspace` the sole way a
  team session ends. "Team lead is finished" is equated with explicit user stop — there is no
  automatic team-teardown detection.
- **Live team turns.** While a session is `team`, a `user_prompt` is pushed into the live lead via
  the run handle's `pushInput` (no second run, no `resume`) rather than rejected as a serial
  violation.
- **Bonus fix.** Because all runs are now streaming, `setPermissionMode` and `interrupt` genuinely
  reach the SDK.

## Consequences

- **Easier:** agent teams work end-to-end (the lead survives delegation); `set_mode`/stop are now
  effective on a live run; one run code path serves both modes.
- **Harder:** every run carries the `InputStream` plumbing; a team session is a long-lived process
  that consumes resources until the user stops it (by design — there is no auto-teardown). A new
  `team` session status, a `team_upgraded` wire event, and a `team` flag on the runtime are added
  to the protocol and registry.
- **Migration:** `runClaude`'s `prompt` option is now an `InputStream`, not a string;
  `RunHandle` gains `pushInput`; `RunOptions` gains `onTeam`; `SessionRuntime` gains `team`;
  `SessionStatus` gains `team`; `ServerToClient` gains `team_upgraded`. The one-shot exit semantics
  for normal sessions are preserved exactly (close on `result`).

## Compliance

- Runs MUST drive `query()` with the `InputStream`, never a string prompt. Reviewers reject a
  string `prompt`.
- A team session MUST NOT be ended by anything other than user stop; its input MUST NOT auto-close.
  A non-team run MUST `close()` its input on `result` so it does not leak a live process.
- Team detection MUST use `isTeamTool` (foreground `Agent` is not a team) and fire `onTeam` at most
  once per run.

## References

- [agent-session spec](../../domains/core/agent-session/spec.md) — AS-R13…R17 (streaming input,
  team detection, `result` fork, team end-on-stop, team next-turn push).
- [agent-session design](../../domains/core/agent-session/design.md) — § InputStream, § Team
  sessions, § Stop / interrupt, § Message mapping.
- [session-registry design](../../domains/core/session-registry/design.md) — § Team-session status
  (the `team` flag and `emit` override).
- [WebSocket protocol](../../shared/api-conventions/websocket-protocol.md) — `team_upgraded`,
  `team` session status, `user_prompt` team semantics.
- Builds on [ADR 0006](0006-decouple-runs-from-connections.md) — the session-runtime registry that
  owns the (now possibly long-lived) team run.
