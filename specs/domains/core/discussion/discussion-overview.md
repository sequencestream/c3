# Domain: discussion

A project-scoped **discussion** store: a discussion (a goal-directed conversation among an
organizer, agents, and the human) plus its ordered messages, persisted in the shared
`~/.c3/c3.db` alongside the requirement ledger.

**Status: live — persistence + create flow + organizer engine + human-in-the-loop.** This domain
provides the data model and SQLite persistence layer (tables + store CRUD), the read path (list +
open), the **create flow** (data-driven type catalog with per-type workflow, the "+" form, and a
read-only research agent that completes a new discussion's context), the **organizer-driven
multi-agent orchestration loop** (`start_discussion` runs a `draft` to a `conclusion` in the
background, the organizer nominating speakers among the configured agents and driving the type's
workflow, each turn a one-shot `askAgentOnce`, every message streamed live as `discussion_message`),
and **human-in-the-loop control**: pause/resume the running engine, the human interjecting a `human`
message mid-run, and re-driving a _new round_ on a concluded discussion with a follow-up question
(see [design §organizer-engine](design.md#organizer-engine)).

## Scope (now)

- Two tables in c3.db: `discussions` and `discussion_messages` (see [models](models.md)).
- A store (`server/src/discussions/store.ts`) with discussion CRUD + message append/list (see
  [design](design.md)).
- **Data-driven type catalog + workflow** (`shared/src/discussion-types.ts`): brainstorm / decision /
  review / planning / retro, each carrying an ordered `discuss → summarize → confirm → conclude`
  workflow with organizer-facing stage prompts. Pure data + pure functions, unit tested.
- **Create flow**: `create_discussion` (see [protocol](../../../shared/api-conventions/websocket-protocol.md))
  persists a `draft` (title derived from `goal`), then a **read-only research agent** —
  `discussion-research` gate reusing the requirement read set (Read/Grep/Glob + WebSearch/WebFetch),
  no save tool, write/exec/sub-agent tools hard-disabled — completes its `context`
  (`server/src/discussions/research.ts`). The server captures the agent's final text and writes it
  back, pushing `discussions` on draft insert and again on completion.
- Frontend: the discussion-view "+" opens an inline create form (type dropdown / goal / context);
  the right pane shows a **Start** button on a `draft` and appends streamed messages live once the
  engine runs.
- **Organizer engine** (`server/src/discussions/orchestrator.ts` + pure
  `orchestrator-logic.ts`): a background loop reusing the consensus `askAgentOnce` /
  `launchForAgent` paradigm. The organizer's round decision and participants' speech parsing are
  pure, dependency-injected, unit-tested functions; the loop walks `draft → in_progress →
completed`, appends every turn (`appendMessage`) and streams it (`discussion_message`), and writes
  the `conclusion`. Termination is guaranteed (forward-only stages, per-stage + total round caps);
  a single configured agent degenerates gracefully (organizer == sole participant).
- Reuses the shared cross-runtime SQLite adapter (`server/src/db.ts`, ADR 0007) and the requirement
  store's fail-soft + `PRAGMA user_version` + idempotent `ensureColumn` migration paradigm.
- **Human-in-the-loop control** (`pause_discussion` / `resume_discussion` / `discussion_speak` /
  `continue_discussion`): the engine awaits a **pause gate** at each round boundary (paused ⇒ no new
  organizer decision or agent speech), so the run can be paused/resumed without aborting. The human
  can **interject** (`discussion_speak` pauses the run, appends a `human` message, resumes — the
  organizer picks it up next round) and can **drive a new round** on a `completed` discussion
  (`continue_discussion` appends the follow-up question, flips `completed → in_progress`, and re-runs
  the engine over the full transcript to a fresh `conclusion`). The live run-state (`running` /
  `paused` / `ended`) is broadcast as `discussion_run_status`, **decoupled from** the persisted
  `DiscussionStatus` (pause is runtime-only, not persisted).

## Out of scope (now)

- No resume of an orphaned `in_progress` discussion (no live run) after a server restart — pause
  state is runtime-only and not restored.
- Pause takes effect only at a round boundary: an already in-flight one-shot `askAgentOnce` finishes
  (so one more message may land after a pause request).

## Index

- [models.md](models.md) — entity definitions (`Discussion`, `DiscussionMessage`).
- [design.md](design.md) — the SQLite persistence layer (schema, migration, store API) **and the
  organizer engine state machine** ([§organizer-engine](design.md#organizer-engine)).
- Type catalog + workflow: `shared/src/discussion-types.ts`; create flow + research agent:
  `server/src/discussions/research.ts`; organizer engine: `server/src/discussions/orchestrator.ts`
  - `orchestrator-logic.ts`; `create_discussion` / `start_discussion` handlers in
    `server/src/server.ts`.

## Dependencies

- **SQLite (shared adapter)** — `server/src/db.ts`; `node:sqlite` (Node) / `bun:sqlite` (Bun),
  both `external` in esbuild (ADR 0007).
