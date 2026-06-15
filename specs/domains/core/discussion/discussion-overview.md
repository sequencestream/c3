# Domain: discussion

A project-scoped **discussion** store: a discussion (a goal-directed conversation among an
organizer, agents, and the human) plus its ordered messages, persisted in the shared
`~/.c3/c3.db` alongside the intent ledger.

**Status: live — persistence + create flow + organizer engine + human-in-the-loop.** This domain
provides the data model and SQLite persistence layer (tables + store CRUD), the read path (list +
open), the **create flow** (data-driven type catalog with per-type workflow, the "+" form, and a
read-only research agent that fills a new discussion's research result), the **organizer-driven
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
  intent read set (Read/Grep/Glob + WebSearch/WebFetch), no save tool, write/exec/sub-agent tools
  hard-disabled — produces a `researchResult` (`server/src/discussions/research.ts`). The research
  output is **strictly status-only**: the researcher collects relevant facts / current state /
  constraints / open questions, and is hard-forbidden from emitting any options, candidate solutions,
  recommendations, or conclusions — so the discussion's divergent brainstorm is not pre-anchored by a
  preset answer. The server captures the agent's final text and writes it to the **`researchResult`**
  field via `setDiscussionResearchResult` (only when non-empty); the user's original **`context` is
  never overwritten**, so both coexist. It pushes `discussions` on draft insert and again on research
  completion. The organizer engine reads `researchResult || context` as its prompt background (research
  output when present, the user's original context otherwise). The research run is **observable**
  (`startResearchRun`, mirroring `startDiscussionRun`): it **streams each turn** as `research_message`
  (assistant text + tool calls) and broadcasts its **liveness** as `research_run_status`
  (`running` while the agent works, `ended` on finish/failure/dead process — the run is awaited, so a
  dead process settles to `ended`). Research messages and liveness are **runtime-only** (never
  persisted), and every `discussions` send carries a `researchStates` snapshot (active research only)
  so a refresh/reconnect mid-research authoritatively rebuilds the research phase. **On research
  success the server auto-starts the
  orchestration** (`startDiscussionRun`, equivalent to an automatic `start_discussion`), re-validating
  on the freshest record via the pure `canAutoStartDiscussion` guard (`status === 'draft'` and no live
  run — skipping if the human Started/cancelled it mid-research). `researchDiscussionContext` returns
  an `{ ok, researchResult }` result (`researchResult` is `''` on empty output — never the user's
  context); a **research failure** (`ok === false`) leaves the discussion a `draft`
  for a manual **Start** fallback and never auto-starts.
- Frontend: the discussion-view "+" opens an inline create form (type dropdown / goal / context);
  on submit the right pane **auto-opens the new discussion** (server `discussion_detail` reply). The
  right pane is **two-phase** (`discussionPhase` in `web/src/lib/discussion-view.ts`): while the
  research run is live (`researchStates`/`research_run_status` → `running`) it shows the **research
  stream** (streamed `research_message` turns; researcher bubbles + tool-activity lines, no
  agenda/dispatch/composer); when research ends and the orchestration auto-starts it switches to the
  **discussion stream** (agenda + transcript + dispatch + composer). The **Start** button is a manual
  fallback shown **only when research has ended/died and the orchestration has not started**
  (`showDiscussionStart`: `status === 'draft' && !researchLive && !discussionLive`) — never while
  research is still running — replacing the old `status === 'draft'` rule. Both phase and button
  rebuild on refresh/reconnect from the `researchStates`/`runStates` snapshots. The create form's Goal / Context textareas **auto-grow** with their content up to a
  pixel cap (shared `autoGrowHeight` in `lib/textarea.ts`), scrolling internally only past the cap and
  resetting when the form closes. The **left list** (`web/src/pages/discussions/components/DiscussionList/DiscussionList.vue`
  - pure view helpers in `web/src/lib/discussion-view.ts`) carries:
    a header **collapse/expand** toggle (`panelToggleLabel`) that narrows the panel and hides secondary
    row info (`rowVisibility` → type / timestamps), a single **unified status indicator** per row
    (`<icon> <agent>.<status>` — see the run-state note below), and an **accordion**
    (`expandedId`, at most one open) that expands a **tab bar + single content area** beneath the row
    (`discussionDetailTabs`): one tab per non-empty field (Goal / Context / **Research** / Conclusion,
    empty fields dropped) whose body is **Markdown-rendered** via `MarkdownText :markdown` (the shared
    markdown-it `html:false` → DOMPurify pipeline), plus an always-present **Details** tab carrying the
    structured meta (type / status / created / completed). The **Research** tab surfaces the persisted
    `researchResult` written by the `discussion-research` gate (read-only researcher that runs once per
    draft, between create and auto-start); it appears in the order `Goal → Context → Research →
Conclusion → Details` so the read-order follows the right-pane's two-phase timeline (research
    stream → discussion stream). The active tab resets to the first
    content-bearing tab on (re)expand or when switching rows, and falls back if a live update empties
    the selected field. **Row click is a single combined action** (`openRow`): it emits `open` to load
    the transcript + orchestration view in the right pane \_and\* toggles that row's inline detail
    accordion in one gesture (re-clicking the same row collapses the detail; `open` stays idempotent).
    There is no chevron and no per-row "Open chat" button. All list copy is English (web/CLAUDE.md).
- **Targeted participants (2026-06-12)**: a discussion's roster is **chosen at creation** — the create
  modal lists the enabled agents (default all selected; the organizer row is force-selected and disabled)
  and persists the picks to `Discussion.participantAgentIds`. The orchestrator nominates **only** from
  that set (∪ the always-included organizer), so unrelated agents no longer add noise. An empty/unset set
  (legacy rows) falls back to the whole `enabledAgents()` pool. See design.md §Roles.
- **Heterogeneous roundtable (multi-vendor, 2026-06-06-004)**: a discussion is **vendor-agnostic
  by construction** — the organizer nominates among the **selected** participants (a subset of
  `enabledAgents()`; see Targeted participants above), which may mix
  normalized to the same `CanonicalMessage` / `ChatBody` shape, so divergent multi-vendor
  perspectives become value rather than a rendering fork. Each `agent` bubble carries a **vendor
  tag** (one hue per vendor) so the source is identifiable; vendor is **derived from the agent
  config** via `speakerAgentId` (`resolveDiscussionSpeaker`), **not persisted** on the message —
  Phase 1 vendor is effectively immutable per agent, and an unresolvable agent simply shows no tag.
  `human`/`organizer` turns carry no vendor tag. **Cost discipline:** cost is **never merged across
  vendors** — different vendors meter differently, so any future per-turn cost is labeled per vendor
  with no cross-vendor sum. Phase 1 has **no cost meter** (the orchestrator's one-shot `askAgentOnce`
  tracks no cost); this is a standing principle, not a built surface. The two-color approval
  provenance (preApproved vs c3-gated) is a `web-console` concern (WC-R20 / PG-R12), not discussion's.
  **Out of Phase 1: no consensus, no agent-teams** on the discussion path — only the heterogeneous
  roundtable plus the base approval gateway.
- **Organizer engine** (`server/src/discussions/orchestrator.ts` + pure
  `orchestrator-logic.ts`): a background loop reusing the consensus `askAgentOnce` /
  `launchForAgent` paradigm. The organizer's round decision and participants' speech parsing are
  pure, dependency-injected, unit-tested functions; the loop walks `draft → in_progress →
completed`, appends every turn (`appendMessage`) and streams it (`discussion_message`), and writes
  the `conclusion`. Termination is guaranteed (forward-only stages, per-stage + total round caps);
  a single configured agent degenerates gracefully (organizer == sole participant).
- Reuses the shared cross-runtime SQLite adapter (`server/src/db.ts`, ADR 0007) and the intent
  store's fail-soft + `PRAGMA user_version` + idempotent `ensureColumn` migration paradigm.
- **Human-in-the-loop control** (`pause_discussion` / `resume_discussion` / `discussion_speak` /
  `continue_discussion`): the engine awaits a **pause gate** at each round boundary (paused ⇒ no new
  organizer decision or agent speech), so the run can be paused/resumed without aborting. The human
  can **interject** (`discussion_speak` pauses the run, appends a `human` message, resumes — the
  organizer picks it up next round) and can **drive a new round** on a `completed` discussion
  (`continue_discussion` appends the follow-up question, flips `completed → in_progress`, and re-runs
  the engine over the full transcript to a fresh `conclusion`). The live run-state (`running` /
  `paused` / `ended`) is broadcast as `discussion_run_status`, **decoupled from** the persisted
  `DiscussionStatus` (pause is runtime-only, not persisted). The left list renders **one unified
  status indicator** per row — `<icon> <agent>.<status>` (shared `web/src/lib/status-indicator.ts`:
  status→icon map + the `statusIndicator.agentStatus` join key, reused by `SessionStatusBar`): when a
  live run is present it shows the run-state (running pulses, paused steady) with the in-flight
  dispatched agent as the `<agent>` segment (omitted when unresolvable — no leftover separator);
  otherwise it falls back to the persisted lifecycle status (draft / in_progress / completed /
  cancelled, no agent). This replaces the former dual run-badge + status-pill, so multiple background
  runs are each visible in one indicator. Because `discussion_run_status` only fires on transitions, every
  `discussions` list send also carries a `runStates` snapshot (active runs only) — a refresh or
  reconnect authoritatively reconciles each listed discussion's run-state from it, so a run already
  going in the background shows correctly even on a freshly-(re)connected view.
- **Dispatch (in-flight) status**: before each dispatched turn the engine emits the nominated
  agent(s) as `pending` via `discussion_dispatch_status` (`speak` one, `broadcast` the whole batch),
  emits `cleared` when the turn resolves, and `failed` (with a brief error) when it throws — so a
  failed reply is surfaced in the chat tail instead of being silently swallowed, while the round still
  proceeds. The chat tail shows `"<name> is replying…"` per pending agent and a failure line per
  error. Runtime-only (never persisted, never a `discussion_messages` row) and — unlike run-state —
  **not** snapshotted on the list: it self-heals via `cleared`/`failed`/the reply message/run
  `ended`/discussion switch, so a refresh/reconnect leaves no stuck pending.

- **Conclusion → intent bridge** (`discussion_to_intent`): a completed discussion's
  title-bar **Convert to Intent** button seeds the intent domain. The server resolves the
  project from the discussion, restarts the intent communication session as a fresh one (a
  `refine_intent` variant) whose first prompt carries the discussion title + `conclusion`, and
  replies with `session_selected` + `intents`; the agent then splits it into verifiable items
  via the **unchanged** `save_intents` flow (see
  [intent-management RM-R7](../intent-management/spec.md)). Rejected unless the discussion
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
