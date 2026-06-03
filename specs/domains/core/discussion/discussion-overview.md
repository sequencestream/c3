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
  persists a `draft` (title derived from `goal`), **immediately replies to the creating connection
  with `discussion_detail`** (so the right pane opens the new discussion without a click) and pushes
  the `discussions` list, then a **read-only research agent** — `discussion-research` gate reusing the
  requirement read set (Read/Grep/Glob + WebSearch/WebFetch), no save tool, write/exec/sub-agent tools
  hard-disabled — completes its `context` (`server/src/discussions/research.ts`). The completed
  `context` is **strictly status-only**: the researcher collects relevant facts / current state /
  constraints / open questions, and is hard-forbidden from emitting any options, candidate solutions,
  recommendations, or conclusions — so the discussion's divergent brainstorm is not pre-anchored by a
  preset answer. The server captures the agent's final text and writes it back, pushing `discussions`
  on draft insert and again on completion. **On research success the server auto-starts the
  orchestration** (`startDiscussionRun`, equivalent to an automatic `start_discussion`), re-validating
  on the freshest record via the pure `canAutoStartDiscussion` guard (`status === 'draft'` and no live
  run — skipping if the human Started/cancelled it mid-research). `researchDiscussionContext` returns
  an `{ ok, context }` result; a **research failure** (`ok === false`) leaves the discussion a `draft`
  for a manual **Start** fallback and never auto-starts.
- Frontend: the discussion-view "+" opens an inline create form (type dropdown / goal / context);
  on submit the right pane **auto-opens the new discussion** (server `discussion_detail` reply) and
  its title bar reads **"Researching…"** while a `draft`, flipping to **"Running"** automatically once
  the server auto-starts the engine (via the refreshed `discussions` + `discussion_run_status`
  broadcasts). A manual **Start** button stays on a `draft` as a fallback (research failed/stalled),
  and streamed messages append live once the engine runs. The create form's Goal / Context textareas **auto-grow** with their content up to a
  pixel cap (`autoGrowHeight` in `discussion-view.ts`), scrolling internally only past the cap and
  resetting when the form closes. The **left list** mirrors the requirement list's interaction paradigm
  (`web/src/components/DiscussionList.vue` + pure view helpers in `web/src/lib/discussion-view.ts`):
  a header **collapse/expand** toggle (`panelToggleLabel`) that narrows the panel and hides secondary
  row info (`rowVisibility` → type / timestamps), a colored **status pill** per row (draft grey /
  in_progress amber / completed green / cancelled red, matching `.req-status`), and an **accordion**
  (`expandedId`, at most one open) that expands a **tab bar + single content area** beneath the
  clicked row (`discussionDetailTabs`): one tab per non-empty field (Goal / Context / Conclusion,
  empty fields dropped) whose body is **Markdown-rendered** via `MarkdownText :markdown` (the shared
  markdown-it `html:false` → DOMPurify pipeline), plus an always-present **Details** tab carrying the
  structured meta (type / status / created / completed). The active tab resets to the first
  content-bearing tab on (re)expand or when switching rows, and falls back if a live update empties
  the selected field. A persistent per-row **Open chat** button still emits
  `open` to load the transcript + orchestration view in the right pane (accordion browsing and the
  right pane coexist). All list copy is English (web/CLAUDE.md).
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

- **Conclusion → requirement bridge** (`discussion_to_requirement`): a completed discussion's
  title-bar **Convert to Requirement** button seeds the requirement domain. The server resolves the
  project from the discussion, restarts the requirement communication session as a fresh one (a
  `refine_requirement` variant) whose first prompt carries the discussion title + `conclusion`, and
  replies with `session_selected` + `requirements`; the agent then splits it into verifiable items
  via the **unchanged** `save_requirements` flow (see
  [requirement-management RM-R7](../requirement-management/spec.md)). Rejected unless the discussion
  is `completed` with a non-empty `conclusion`.

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
