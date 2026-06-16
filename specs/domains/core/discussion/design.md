# discussion — Design

The [discussion](discussion-overview.md) domain's server design: the **persistence layer**
(the discussion store over the shared database adapter, implementing the [models](models.md)) and the
**organizer engine** (the orchestration loop + its pure decision/parsing logic) that drives a
discussion through its workflow. The wire protocol
(`create_discussion` / `start_discussion` / `discussion_message`) is in
[websocket-protocol.md](../../../shared/api-conventions/websocket-protocol.md).

## Module split

| Concern                 | Notes                                                                   |
| ----------------------- | ----------------------------------------------------------------------- |
| Shared database adapter | Cross-runtime database driver (ADR 0007); shared with intent-management |
| Discussion store        | Schema ownership + discussion/message CRUD                              |

## Database layer (shared adapter)

The discussion store reuses the shared adapter unchanged (see
[intent-management design §SQLite layer](../intent-management/design.md) and
[ADR 0007](../../../architecture/adr/0007-read-only-intent-agent.md) for the full rationale):
one minimal **synchronous** interface (exec / run / all / get) selected by the runtime,
positional placeholders only, rows read by field, the shared on-disk database file, write-ahead
logging + a busy timeout, and the driver modules kept out of the bundle.

The adapter lives in a neutral location precisely because it is generic: the discussion store and
the intent store are **sibling domains** over one database, and neither should depend on the other.
Both ride the single shared connection; each owns its own tables and a private schema-ready flag.

## Schema (version-counter migrations)

Two tables, ensured lazily on the discussion store's first access (create-if-not-exists for tables
and indexes):

- discussions — `id` (PK), `workspace_path`, `title`, `type`, `goal` (text, not null, default empty),
  `context` (text, not null, default empty — the user's original input, never overwritten by
  research), `research_result` (text, not null, default empty — the read-only research agent's
  completed output, stored apart from `context`; empty until research yields a non-empty result),
  `status`, `agenda` (text, not null, default an empty JSON array — the organizer's ordered subtopics),
  `agenda_index` (integer, not null, default 0 — 0-based current subtopic; equal to the agenda length
  ⇒ all done), `conclusion` (nullable), `created_at`, `updated_at`, `completed_at` (nullable). Indexed
  by `(workspace_path, status)`.
- discussion messages — `id` (PK), `discussion_id`, `seq`, `speaker_kind`, `speaker_agent_id`
  (nullable), `speaker_name` (nullable), `content`, `created_at`. Indexed by `(discussion_id, seq)` —
  the natural read path for listing messages.

**Schema version (current: v4),** written via the database version counter. v2→v3
added `participant_agent_ids`; **v3→v4 renamed the workspace-key column `project_path` →
`workspace_path` in place** (composite index rebuilt), run BEFORE the schema-ensure step —
idempotent, never drops a table. This **deliberately diverges** from the back-compat `projectConfigs`
settings.json key (see `database/migrate/2026/06/14/012`). The single shared version counter is
**shared** with the intent store, so the two clobber each other on write — this is intentional and
harmless: migrations key off **actual presence** (table-info introspection for columns,
create-if-not-exists for tables), never off the version number. The value is informational only.

**Idempotent additive migration.** After the schema-ensure step and before writing the version
counter, the store backfills the optional/nullable columns (`goal`, `context`, `research_result`,
`agenda`, `agenda_index`, `conclusion`, `completed_at`): each checks the table's columns and only adds
the column when it is absent. This is a **defensive forward-compat backfill** — a discussions table
created by an earlier in-development build that predated these columns is upgraded in place; on a
fresh schema each call is a no-op, and the whole sequence is idempotent across runs. Same
key-off-column-presence paradigm as the intent store's `module`/`completed_at`/`automate` migrations.
Both runtimes support column introspection / additive column alters through the shared surface.

**Fail-soft.** When the database cannot be opened/created, reads return empty/null and writes throw
("讨论库不可用") — c3 boots and runs without the discussion feature, consistent with the intent
store's degradation contract.

## Store

- **Path normalization:** every workspace-path argument (list, create) is resolved to an absolute
  path before read/write, matching the workspace key / runtime workspace path / SDK working directory.
  Id-keyed operations (get, update status, set conclusion, append message, list messages) take no
  workspace path.
- **List discussions** by workspace, ordered by most recently updated (optionally status-filtered).
- **Get a discussion** by id (or nothing).
- **Create a discussion** (workspace, title, type, optional goal/context/status). Mints a uuid,
  `created_at = updated_at = now`, default `status = draft`; if created directly as `completed`,
  `completed_at` is stamped.
- **Update status** — updates status + `updated_at`; `completed_at = now` when completed, cleared on
  revert (mirrors the intent store's done-stamping rule).
- **Set conclusion** — sets `conclusion` + bumps `updated_at`.
- **Set context** — replaces the user-supplied `context` + bumps `updated_at`.
- **Set research result** — stores the research agent's completed output in the research-result column
  (kept apart from `context`) + bumps `updated_at`.
- **Set agenda** — persists the agenda (a JSON array) and the 0-based current index (equal to the
  agenda length ⇒ all subtopics done) + bumps `updated_at`. Reads parse the agenda back to a string
  array (null/blank/corrupt JSON → empty).
- **Append a message** (discussion id, speaker kind, optional agent id / name, content). In **one
  transaction**: reads the next sequence number (max existing + 1) for that discussion, inserts the
  message, and bumps the discussion's `updated_at`. The transaction makes the sequence race-free under
  the single synchronous connection; the sequence is independent per discussion.
- **List messages** for a discussion, ordered by sequence ascending.
- Availability check / test-reset helpers mirror the intent store.

## Organizer engine

The orchestration loop that drives a `draft` (or re-driven `completed`) discussion to a `conclusion`.
Split for testability:

| Concern               | Notes                                                                                                                                             |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pure decision/parsing | No I/O/SDK: prompt builders, organizer-decision parsing, participant-speech parsing, step resolution, transcript rendering. Unit-tested.          |
| Orchestration loop    | The run routine (discussion id, cancellation signal, injected dependencies) + its defaults. All collaborators injected, including the pause gate. |
| One-shot agent turn   | A single tool-disabled turn under the agent's launch overrides, registered as a tool session (shared with consensus).                             |

**Roles.** The **organizer** is the discussion's designated organizer (else the workspace's default
agent); the **participants** are the subset of agents **selected at creation** (picked in the create
modal, default-all-enabled), resolved against the live enabled-agent pool, **∪ the organizer** — the
organizer is always folded in (even if not selected) so it may nominate itself and is the sole speaker
when only one agent participates (the consensus "no voters" degeneration). **Back-compat:** an empty
participant set (legacy/pre-selection rows) means _unset_, and the roster falls back to the whole
enabled-agent pool (the old "everyone participates" behaviour). The selection is fixed for the
discussion's life — later rounds / resume reuse the same set (no post-creation editing this iteration).

**Round model.** Each round the organizer is asked, over the live transcript + the active workflow
stage (+ the live agenda in `discuss`), for a decision; the parse reads it (a JSON object of action /
speaker / subtopics / index / note / conclusion first, keyword fallback, and a safe `advance`
default so an unparseable reply never hangs). Step resolution folds the stage, the per-stage round cap,
and the agenda (items + index, default empty) into a concrete step:

- `speak` — a nominated participant takes a one-shot turn (parsed into its speech); its speech is
  appended as an `agent` message. The participant prompt asks each turn to stay within a character
  budget (≈300 chars; no paragraph/structure limit), and the parse no longer enforces a hard
  truncation — over-long replies are accepted verbatim (the budget serves only as prompt-level
  guidance). When an agenda is set, the current subtopic is injected into the participant prompt to
  focus the turn. In converging stages (`summarize`/`confirm`) `speak` is the only speaker action — the
  organizer refines serially, one participant at a time.
- `broadcast` (`discuss` **only**) — the **divergent batch** form and the organizer's preferred discuss
  mechanism: one organizer sub-question (the note, announced as an `organizer` message) is put to
  several or all participants at once, each answering **in parallel** via its own one-shot turn on the
  same one-paragraph budget. The speakers list is an explicit id list or "all"/omitted ⇒ the whole
  roster; an explicit-but-all-invalid list recovers to the whole roster rather than degrading, and only
  a truly empty roster degrades to `advance`. Every participant in a batch sees the **same transcript
  snapshot** — taken after the sub-question is announced but before any answer — so the batch is
  genuinely independent (no participant sees another's batch reply). The N replies are appended **in
  nomination order, not completion order** (collected concurrently, then appended in a sequential
  in-order loop), so each batch member's per-discussion sequence deterministically tracks the broadcast
  order regardless of which agent finishes first. Each is an `agent` message, focused on the current
  subtopic. A whole batch counts as **one round** (the per-stage and total counters each +1), so it is
  bound by the R2 per-subtopic cap and never breaks the total-round backstop. Outside `discuss` a
  `broadcast` decision degrades to `advance`, keeping the converging stages serial.
- `set_agenda` (`discuss` only) — decompose the goal into ordered subtopics; the engine persists the
  agenda (index reset to 0), announces it as an organizer message, and **stays in `discuss`**. Parsed
  only from JSON (a non-empty subtopics array) — no prose fallback, since a list can't be reliably
  extracted from free text; an empty/unusable list degrades to the safe `advance` default.
- `focus_subtopic` (`discuss` only) — the current subtopic is done; move to the next (or the optional
  numeric index). The engine persists the new index, announces the subtopic, and stays in `discuss`.
  Moving **past the last subtopic** ⇒ every subtopic is done ⇒ resolves to `advance` (→ `summarize`).
- `advance` — move to the next workflow stage; a non-empty organizer note (e.g. the summary) is
  appended as an `organizer` message. Leaving `discuss` with an agenda set snaps the agenda index to
  the agenda length (records "agenda complete").
- `conclude` — append the final conclusion (organizer message), set the conclusion, mark `completed`.

**Explicit agenda.** The agenda is an ordered list of subtopics plus a 0-based index (empty agenda ⇒
none yet; index equal to the agenda length ⇒ all done). It is **persisted** and **only meaningful in
`discuss`** — other stages ignore agenda actions (they degrade to `advance`), and an empty agenda makes
the engine behave exactly as it did before agendas existed (full backward compatibility). The engine
seeds its live agenda from the persisted discussion at run start and writes back on every
`set_agenda`/`focus_subtopic`. Each `set_agenda`/`focus_subtopic` also fires the status-change hook (→
refreshed `discussions` list broadcast), so viewers see the agenda set and the current subtopic advance
**live** — the persisted agenda + index ride the list push, since the companion `discussion_message`
announcement carries no agenda fields. In `discuss`, the per-stage round cap is effectively the
**per-subtopic** speak budget: the loop resets the in-stage round count on each
`set_agenda`/`focus_subtopic`, and when the cap is hit it auto-moves to the next subtopic if one remains
(else advances out of the stage). `set_agenda`/`focus_subtopic` bump the **total**-round counter (the
hard backstop) but never change the stage. The read path (get / list / `discussion_detail`) carries the
agenda + index for free.

**State machine.**

`start_discussion` is also invoked **automatically** after `create_discussion`'s background research
succeeds: the server re-validates the freshest record with a pure auto-start guard (status is still
`draft` and no live run) and starts the run. A manual `start_discussion` stays as a fallback (research
failed/stalled, where the discussion remains a `draft`).

**Research as an observable run.** The research run mirrors a discussion run: a per-id registry
(presence = liveness) registers the run, `research_run_status` broadcasts `running` then `ended` (on
finish/failure/dead process — the run is awaited, so a dead process settles the promise to `ended`),
and the research routine's message callback streams each observable turn as `research_message` (a text
kind per assistant turn, a tool kind per tool call, a monotonic sequence per run). Research messages
and liveness are **runtime-only** — never persisted, mirroring `discussion_dispatch_status`; only
liveness is snapshotted (the research-states snapshot on every `discussions` send). On settle the
server broadcasts `ended` **before** auto-starting the orchestration, so the right pane switches
research → discussion stream in one batch; a failed research broadcasts `ended` without auto-start,
surfacing the manual Start fallback. Frontend phase and Start visibility (status is `draft` and neither
research nor a discussion run is live) are pure helpers rebuilt from the snapshots on reconnect.

The research agent's output is written to the research-result column (only when non-empty); the user's
original `context` is **never** overwritten. The organizer engine's prompt background source is the
research result when present, falling back to the user's original context otherwise.

```
draft ──start_discussion / auto-start after research──▶ in_progress ──(walk workflow stages)──▶ completed (conclusion written)
                              │   ▲                                       │
                  pause ──────┤   │ resume                                │ continue_discussion
                  (gate parks)│   │                                       │ (append human Q)
                              └───┘                                       ▼
   discuss ──advance/agenda done──▶ summarize ──advance──▶ confirm ──advance──▶ conclude ──▶ conclude step
      ▲  │ broadcast (divergent batch: N participants answer the subtopic in parallel — discuss only)
      │  │ speak (single participant turn on the current subtopic; the only speaker action in summarize/confirm)
      │  │ set_agenda (decompose goal into subtopics) / focus_subtopic (next subtopic) — both stay in discuss
      │  │ (all four are per-subtopic capped by maxRoundsPerStage; a batch counts as one round)
      └──┘
   (an explicit `conclude` decision finishes from any stage; the terminal `conclude` stage
    always concludes. `continue_discussion` re-enters in_progress at the first stage with the
    full prior transcript as context, producing a new conclusion.)
```

**Human-in-the-loop.** Three controls layer onto the loop without touching its decision logic:

- **Pause gate** — the gate is awaited at the top of every round. While paused it parks (no organizer
  decision, no speech); resume or abort wakes it. So pause/resume suspend the engine **without
  aborting** it (local stage/round state is preserved). `pause_discussion` / `resume_discussion` flip
  the per-run flag; an already in-flight one-shot turn still finishes (the pause is a round-boundary
  gate, so one more message may land after a pause request).
- **Interjection** (`discussion_speak`) — the server pauses the run, appends a `human` message
  (streamed as `discussion_message`), and resumes; the loop re-reads the message list each round, so
  the organizer's next decision sees it. With no live run (in_progress but stopped) the message is
  simply appended.
- **New round** (`continue_discussion`) — on a `completed` discussion the server appends the human's
  follow-up as a `human` message, flips `completed → in_progress`, and re-runs the engine over the
  grown transcript. The engine needs no change: it re-enters at the first workflow stage, the prior
  conclusion + the new question are context, and the conclusion is overwritten with the new outcome. A
  re-entry guard (a live run already registered for this id) rejects it while a run is live.

**Persistence + streaming.** Every appended message is persisted (monotonic per-discussion sequence)
and streamed via the message hook → server `discussion_message` broadcast. Status/conclusion changes —
and agenda changes (`set_agenda`/`focus_subtopic`) — fire the status-change hook → refreshed
`discussions` list broadcast. The live **run-state** (`running` / `paused` / `ended`) is a separate
`discussion_run_status` broadcast — runtime-only and **decoupled** from the persisted discussion status
(a paused run is still `in_progress` on disk; the state is lost on server restart). The frontend keys a
per-discussion run-state map off it (dropping the entry on `ended`) to render the Pause/Resume control,
the composer mode (Speak vs Continue), and the left list's per-row live badge (running pulses / paused
steady, distinct from the static status pill), so concurrent background runs are each visible.

**Run-state snapshot (refresh/reconnect accuracy).** `discussion_run_status` only fires on
_transitions_, so a freshly-(re)connected view never learns about runs that were already going. To
close this, every `discussions` list message carries a run-states snapshot — reading the live run
registry and mapping each _listed_ discussion with an active run to `running`/`paused` (active entries
only). It rides all three list sends: the `list_discussions` reply, the post-change list push, and (via
the frontend re-issuing `list_discussions`) reconnect. The frontend's reconciliation then makes its
global run-state map authoritative for _that list's_ ids — each listed id is set from the snapshot or
dropped when absent (clearing an `ended` missed during a disconnect) — while leaving other workspaces'
entries untouched. The transition-only `discussion_run_status` event still drives fine-grained updates
between list sends.

**Dispatch (in-flight) status.** Before a nominated agent's one-shot turn is awaited, the engine emits
the agent(s) as in-flight via the injected dispatch-status hook (`speak` lists one, `broadcast` lists
the whole batch — concurrent replies); when the turn resolves it emits `cleared`, and when it **throws**
it emits `failed` (with a brief error) instead of the former silent swallow. A failure is no longer
swallowed into an empty speech — it is surfaced, the speech is skipped, and the round still proceeds (a
`broadcast` awaits all settled results, so one failure does not drop the rest of the batch). The server
maps the per-agent dispatch status (`pending` / `cleared` / `failed`) onto a runtime-only
`discussion_dispatch_status` broadcast — **not persisted**, never a stored message row. The frontend
keeps a per-discussion view of pending agents + errors reduced from those events; the chat tail renders
`"<name> is replying…"` per pending agent and a failure line per error. `cleared` is the reliable clear
for an empty/skipped speech that appends no message; the landed reply also clears its author eagerly
(keyed by the speaker's agent id). Unlike run-state, dispatch status is **not** snapshotted on the
`discussions` list — it is too ephemeral; it self-heals via `cleared` / `failed` / the reply message /
run `ended` / discussion switch (each drops the entry), so a refresh/reconnect (which starts empty)
leaves no stuck pending.

**Termination.** Stages move forward only and `conclude` is terminal; the per-stage round cap forces an
advance out of a stuck stage; the total-round cap (default 40) is the hard backstop, writing a fallback
conclusion. The per-stage cap is the system-configured maximum rounds per stage (minimum 8, default 12
— see agent-config AC-R9), read from system settings and injected through the run's default
dependencies; tests may override it on the injected dependencies. An abort (server teardown) breaks the
loop and leaves the discussion `in_progress` (no resume).

**Background carrier.** The server keeps a registry of live discussion runs, each holding an abort
handle, a paused flag, and the set of resume waiters. A present entry is the re-entry guard for
`start_discussion` / `continue_discussion`; the abort handle tears the loop down; the paused flag +
resume waiters back the pause gate (resume splices+wakes the waiters; the gate also wakes on abort, so
neither resume nor teardown can hang on a paused loop). A shared run-start entry registers the control,
wires the broadcast + gate hooks into the run's default dependencies, and on completion deletes the
entry and broadcasts `discussion_run_status: 'ended'`. The run uses one-shot tool sessions, not a user
session runtime, so finishing it never ends a session (既有 session 约定: a session ends only on user
`/clear`).

## Testing

**Store** (real temp-file database): table + index creation and the version counter; CRUD (create
defaults + explicit fields, list ordering [tie-safe non-increasing updated-at] + status filter +
workspace scope + trailing-slash path normalization, the completed-at stamp/clear, conclusion,
real-file persistence across cache reset); messages (monotonic per-discussion sequence, sequence
independence across discussions, updated-at bump, ordered list, nullable speaker fields → null);
**agenda** (set-agenda round-trips subtopics + index, index reaching the agenda length, create defaults
of empty/0, real-file persistence); migration (old database with **no** discussion tables → created;
old discussions table with **only core columns** → additive backfill of
`goal`/`context`/`research_result`/`agenda`/`agenda_index`/`conclusion`/`completed_at`, historic row
survives, idempotent on re-ensure); fail-soft degradation (reads empty/null, write throws).

**Pure decision/parsing**: organizer-decision parsing (JSON / fenced / keyword fallback / invalid
speaker / unparseable → advance / `set_agenda` with subtopic list / empty subtopics degrade /
`focus_subtopic` with index / next-subtopic prose / **`broadcast`** with explicit speaker list
[intersected + deduped + order-preserved] / "all"/omitted ⇒ whole roster / all-invalid list recovers to
whole roster / no-participants degrades / broadcast prose keyword); participant-speech parsing (trim +
self-name strip + blank + over-long text preserved verbatim (no truncation) + short speech untouched +
explicit max-chars override [a no-op — kept for backward compatibility]); step resolution
(terminal-stage conclude, explicit conclude, cap-forced advance, valid / invalid speaker, set-agenda
step, focus advances index, focus past last → advance, cap moves to next subtopic when unfinished /
advances on last subtopic, agenda actions degrade outside `discuss`, **`broadcast` in `discuss` yields a
broadcast step / degrades to advance outside `discuss` / per-stage cap still forces forward motion over
a pending broadcast**); transcript rendering; prompt builders carry the key fields (incl. the agenda +
current subtopic + the `broadcast` contract).

**Orchestration loop** (fakes — scripted replies, in-memory store, capture hooks): the full workflow
happy path (status `in_progress` → `completed`, streamed messages mirror appends, conclusion written),
the single-agent degeneration, mid-run abort leaving `in_progress`, the total-round-cap fallback
conclusion, the **pause gate** (a gate that parks the first round ⇒ status flips but no message is
streamed; release ⇒ runs to completion), a **fresh post-conclusion round** (append a `human` question +
flip to `in_progress` + re-run ⇒ new conclusion, grown transcript), an **explicit agenda walk**
(`set_agenda` ⇒ subtopic-by-subtopic `speak`/`focus_subtopic` ⇒ all done ⇒ `summarize` → `conclude`;
agenda persisted, index equal to the agenda length, one participant turn per subtopic), the
**per-subtopic cap auto-advance** (a subtopic that hits the per-stage cap carries the engine to the next
subtopic, then out of the stage on the last), a **divergent batch broadcast** (one `discuss` broadcast
decision ⇒ multiple `agent` speeches from a single round; the organizer announces the sub-question
first; replies persist in nomination order with monotonic sequence even when a later-nominated agent
finishes first; streaming mirrors the append order), and the **converging stages stay serial** (a
`broadcast` decision issued in `summarize` degrades to `advance` and fans out nothing).

## Dependencies

- **Shared database adapter** — the cross-runtime database driver, kept out of the bundle.
- **Shared protocol** — the Discussion, Discussion Message, status, and speaker-kind entity types;
  each agent's icon (operator-set emoji / short text per agent) is the wire-level source of truth for
  the multi-speaker chat header.
- **Discussion types** — the workflow stage catalog + next-stage function.
- **Agent runtime** — the one-shot agent turn and the settings/agent-resolution + launch helpers for
  the organizer + participants.

## Client-side rendering (cross-reference)

The server appends messages with the speaker name set from the agent profile; the wire model is the
source of truth, and the organizer/agent ids resolve to the live agent roster on the client. The web
client draws a small 「icon + name」 line above every discussion message body and the resolution rules
(organizer ⇒ designated organizer or default agent, agent ⇒ by id, fallbacks, blank-icon trim) live in
the web-console design — see
[Discussion speaker rendering](../web-console/design.md#discussion-speaker-rendering-multi-speaker-chat-header).
No server changes are required for that surface; the icon field is consumed read-only.
