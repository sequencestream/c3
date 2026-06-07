# discussion — Design

The [discussion](discussion-overview.md) domain's server design: the SQLite **persistence layer**
(`server/src/discussions/store.ts` over the shared adapter `server/src/db.ts`, implementing the
[models](models.md)) and the **organizer engine** (`orchestrator.ts` + pure `orchestrator-logic.ts`)
that drives a discussion through its workflow. The wire protocol
(`create_discussion` / `start_discussion` / `discussion_message`) is in
[websocket-protocol.md](../../../shared/api-conventions/websocket-protocol.md).

## Module split

| Concern               | File                              | Notes                                                                                |
| --------------------- | --------------------------------- | ------------------------------------------------------------------------------------ |
| Shared SQLite adapter | `server/src/db.ts`                | Cross-runtime `node:sqlite` / `bun:sqlite` (ADR 0007); shared with intent-management |
| Discussion store      | `server/src/discussions/store.ts` | Schema ownership + discussion/message CRUD                                           |

## SQLite layer (shared `db.ts`)

The discussion store reuses the shared adapter unchanged (see
[intent-management design §SQLite layer](../intent-management/design.md) and
[ADR 0007](../../../architecture/adr/0007-read-only-intent-agent.md) for the full rationale):
one minimal **synchronous** interface (`exec`/`run`/`all`/`get`) selected by `globalThis.Bun`,
`?`-only placeholders, rows read by field, `~/.c3/c3.db`, WAL + `busy_timeout`, esbuild `external`
for both driver modules.

`db.ts` was promoted from `server/src/intents/db.ts` to a neutral location precisely because it
is generic: the discussion store and the intent store are **sibling domains** over one db, and
neither should depend on the other. Both ride the single c3.db connection; each owns its own tables
and a private `schemaReady` flag.

## Schema (`PRAGMA user_version` migrations)

Two tables, ensured lazily on the discussion store's first access via `exec(SCHEMA)`
(`CREATE TABLE IF NOT EXISTS` + `CREATE INDEX IF NOT EXISTS`):

- `discussions` — `id` (PK), `project_path`, `title`, `type`, `goal` (`TEXT NOT NULL DEFAULT ''`),
  `context` (`TEXT NOT NULL DEFAULT ''` — the user's original input, never overwritten by research),
  `research_result` (`TEXT NOT NULL DEFAULT ''` — the read-only research agent's completed output,
  stored apart from `context`; `''` until research yields a non-empty result), `status`,
  `agenda` (`TEXT NOT NULL DEFAULT '[]'` — the
  organizer's ordered subtopics, a JSON string array), `agenda_index` (`INTEGER NOT NULL DEFAULT 0`
  — 0-based current subtopic; `=== agenda.length` ⇒ all done), `conclusion` (nullable), `created_at`,
  `updated_at`, `completed_at` (nullable). Indexed by `idx_disc_project_status (project_path,
status)`.
- `discussion_messages` — `id` (PK), `discussion_id`, `seq`, `speaker_kind`, `speaker_agent_id`
  (nullable), `speaker_name` (nullable), `content`, `created_at`. Indexed by
  `idx_disc_msg_discussion (discussion_id, seq)` — the natural read path for `listMessages`.

**Schema version (current: v1).** `SCHEMA_VERSION = 1`, written via `PRAGMA user_version`. The
single c3.db `user_version` counter is **shared** with the intent store, so the two clobber
each other on write — this is intentional and harmless: migrations key off **actual presence**
(`PRAGMA table_info` for columns, `CREATE TABLE IF NOT EXISTS` for tables), never off the version
number. The value is informational only.

**Idempotent migration (`ensureColumn`).** After `exec(SCHEMA)` and before writing `user_version`,
the store runs `ensureColumn` for the optional/nullable columns
(`goal`, `context`, `research_result`, `agenda`, `agenda_index`, `conclusion`, `completed_at`): each checks
`PRAGMA table_info(discussions)` and
only runs `ALTER TABLE … ADD COLUMN` when the column is absent. This is a **defensive forward-compat
backfill** — a `discussions` table created by an earlier in-development build that predated these
columns is upgraded in place; on a fresh schema each call is a no-op, and the whole sequence is
idempotent across runs. Same key-off-column-presence paradigm as the intent store's
`module`/`completed_at`/`automate` migrations. Both drivers support `PRAGMA table_info` /
`ALTER TABLE ADD COLUMN` through the shared `exec`/`all` surface.

**Fail-soft.** When `getDb()` returns null (open/create failure), reads return empty/null and
writes throw (`requireDb` → `Error('讨论库不可用')`) — c3 boots and runs without the discussion
feature, consistent with the intent store's degradation contract.

## Store (`store.ts`)

- **Path normalization:** every `projectPath` arg (`listDiscussions`, `createDiscussion`) is
  `resolve()`d before read/write, matching the workspace key / runtime `workspacePath` / SDK `cwd`.
  Id-keyed operations (`getDiscussion`, `updateDiscussionStatus`, `setConclusion`, `appendMessage`,
  `listMessages`) take no `projectPath`.
- `listDiscussions(projectPath, status?)` → `Discussion[]`, `ORDER BY updated_at DESC` (optionally
  status-filtered).
- `getDiscussion(id)` → `Discussion | null`.
- `createDiscussion({ projectPath, title, type, goal?, context?, status? })` → `Discussion`. Mints a
  uuid, `created_at = updated_at = now`, default `status = 'draft'`; if created directly as
  `completed`, `completed_at` is stamped.
- `updateDiscussionStatus(id, status)` — updates status + `updated_at`; `completed_at = completed ?
now : null` (mirrors the intent store's done-stamping rule, including clearing on revert).
- `setConclusion(id, conclusion)` — sets `conclusion` + bumps `updated_at`.
- `setDiscussionContext(id, context)` — replaces the user-supplied `context` + bumps `updated_at`.
- `setDiscussionResearchResult(id, researchResult)` — stores the research agent's completed output in
  the `research_result` column (kept apart from `context`) + bumps `updated_at`.
- `setAgenda(id, items, index)` — persists the agenda (`JSON.stringify(items)` into `agenda`) and
  the 0-based current `agenda_index` (`items.length` ⇒ all subtopics done) + bumps `updated_at`.
  `toDiscussion` parses `agenda` back to a `string[]` (null/blank/corrupt JSON → `[]`).
- `appendMessage({ discussionId, speakerKind, speakerAgentId?, speakerName?, content })` →
  `DiscussionMessage`. In **one transaction**: reads `COALESCE(MAX(seq),0)+1` for that discussion,
  inserts the message, and bumps the discussion's `updated_at`. The transaction makes the seq
  race-free under the single synchronous connection; `seq` is independent per discussion.
- `listMessages(discussionId)` → `DiscussionMessage[]`, `ORDER BY seq ASC`.
- `isStoreAvailable()` / `resetStoreForTests()` mirror the intent store.

## Organizer engine

The orchestration loop that drives a `draft` (or re-driven `completed`) discussion to a `conclusion`.
Split for testability:

| Concern               | File                                           | Notes                                                                                                                                    |
| --------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Pure decision/parsing | `server/src/discussions/orchestrator-logic.ts` | No I/O/SDK: prompt builders, `parseOrganizerDecision`, `parseParticipantSpeech`, `resolveStep`, `renderTranscript`. Unit-tested.         |
| Orchestration loop    | `server/src/discussions/orchestrator.ts`       | `runDiscussion(id, signal, deps)` + `defaultDiscussionDeps`. All collaborators injected (`DiscussionDeps`), including the pause `gate`.  |
| One-shot agent turn   | `server/src/agent-once.ts`                     | `askAgentOnce` (extracted from consensus): a single tool-disabled turn under the agent's launch overrides, registered as a tool session. |

**Roles.** The **organizer** is the default agent (`resolveAgent(null)`); the **participants** are
all configured agents (`loadSettings().agents`) — the organizer included, so it may nominate itself
and is the sole speaker when only one agent is configured (the consensus "no voters" degeneration).

**Round model.** Each round the organizer is asked, over the live transcript + the active workflow
stage (+ the live agenda in `discuss`), for a decision; `parseOrganizerDecision` reads it (JSON
`{action, speaker, subtopics, index, note, conclusion}` first, keyword fallback, and a safe `advance`
default so an unparseable reply never hangs). `resolveStep` folds the stage, the per-stage round cap,
and the agenda (`{items, index}`, default empty) into a concrete step:

- `speak` — a nominated participant takes a one-shot turn (`askAgentOnce` → `parseParticipantSpeech`);
  its speech is appended as a `speakerKind: 'agent'` message. The participant prompt asks each turn
  to stay within a character budget (≈`MAX_SPEECH_CHARS`=300 chars; no paragraph/structure limit), and
  `parseParticipantSpeech` no longer enforces a hard truncation — over-long replies are
  accepted verbatim (the budget serves only as prompt-level guidance). When an agenda
  is set, the current subtopic (`agenda[agendaIndex]`) is injected into the participant prompt to focus
  the turn. In converging stages (`summarize`/`confirm`) `speak` is the only speaker action — the
  organizer refines serially, one participant at a time.
- `broadcast` (`discuss` **only**) — the **divergent batch** form and the organizer's preferred discuss
  mechanism: one organizer sub-question (the `note`, announced as a `speakerKind: 'organizer'` message)
  is put to several or all participants at once, each answering **in parallel** via its own `askAgentOnce`
  on the same one-paragraph budget. `speakers` is an explicit id list or `"all"`/省略 ⇒ the whole roster
  (`resolveBroadcastSpeakers`); an explicit-but-all-invalid list recovers to the whole roster rather than
  degrading, and only a truly empty roster degrades to `advance`. Every participant in a batch sees the
  **same transcript snapshot** — taken after the sub-question is announced but before any answer — so the
  batch is genuinely independent (no participant sees another's batch reply). The N replies are appended
  **in nomination order, not completion order** (`Promise.all` collects, then a sequential in-order
  `appendMessage` loop), so each batch member's per-discussion `seq` deterministically tracks the
  broadcast order regardless of which agent finishes first. Each are `speakerKind: 'agent'` messages,
  focused on the current subtopic. A whole batch counts as **one round** (`roundsInStage`/`total` each
  +1), so it is bound by the R2 per-subtopic cap and never breaks the `maxTotalRounds` backstop. Outside
  `discuss` a `broadcast` decision degrades to `advance` (`resolveStep`), keeping the converging stages
  serial.
- `set_agenda` (`discuss` only) — decompose `goal` into ordered `subtopics`; the engine persists the
  agenda (index reset to 0), announces it as an organizer message, and **stays in `discuss`**. Parsed
  only from JSON (a non-empty `subtopics` array) — no prose fallback, since a list can't be reliably
  extracted from free text; an empty/unusable list degrades to the safe `advance` default.
- `focus_subtopic` (`discuss` only) — the current subtopic is done; move to the next (or the optional
  numeric `index`). The engine persists the new index, announces the subtopic, and stays in `discuss`.
  Moving **past the last subtopic** ⇒ every subtopic is done ⇒ resolves to `advance` (→ `summarize`).
- `advance` — move to the next workflow stage; a non-empty organizer `note` (e.g. the summary) is
  appended as a `speakerKind: 'organizer'` message. Leaving `discuss` with an agenda set snaps
  `agenda_index` to `agenda.length` (records "agenda complete").
- `conclude` — append the final conclusion (organizer message), `setConclusion`, `completed`.

**Explicit agenda.** The agenda is an ordered `string[]` of subtopics plus a 0-based `agendaIndex`
(`agenda: []` ⇒ no agenda yet; `agendaIndex === agenda.length` ⇒ all done). It is **persisted** and
**only meaningful in `discuss`** — other stages ignore agenda actions (they degrade to `advance`), and
an empty agenda makes the engine behave exactly as it did before agendas existed (full backward
compatibility). The engine seeds its live agenda from the persisted discussion at run start and writes
back on every `set_agenda`/`focus_subtopic`. Each `set_agenda`/`focus_subtopic` also fires
`deps.onStatusChange` (→ refreshed `discussions` list broadcast), so viewers see the agenda set and the
current subtopic advance **live** — the persisted `agenda`/`agendaIndex` ride the list push, since the
companion `discussion_message` announcement carries no agenda fields. In `discuss`, `maxRoundsPerStage` is effectively the
**per-subtopic** speak budget: the loop resets `roundsInStage` on each `set_agenda`/`focus_subtopic`,
and when the cap is hit it auto-moves to the next subtopic if one remains (else advances out of the
stage). `set_agenda`/`focus_subtopic` bump the **total**-round counter (the hard backstop) but never
change the stage. The read path (`getDiscussion` / `listDiscussions` / `discussion_detail`) carries
`agenda`/`agendaIndex` for free via `toDiscussion`.

**State machine.**

`start_discussion` is also invoked **automatically** after `create_discussion`'s background research
succeeds: the server re-validates the freshest record with the pure `canAutoStartDiscussion` guard
(`status === 'draft'` and no live run) and calls `startDiscussionRun`. A manual `start_discussion`
stays as a fallback (research failed/stalled, where the discussion remains a `draft`).

**Research as an observable run.** `startResearchRun` mirrors `startDiscussionRun`: a `researchRuns`
map (id → `AbortController`, presence = liveness) registers the run, `research_run_status` broadcasts
`running` then `ended` (on finish/failure/dead process — the run is awaited via `runClaude`, so a
dead process settles the promise to `ended`), and `researchDiscussionContext`'s `onMessage` callback
streams each observable turn as `research_message` (`kind: 'text'` per assistant turn, `kind: 'tool'`
per tool call, `seq` monotonic per run). Research messages and liveness are **runtime-only** — never
persisted, mirroring `discussion_dispatch_status`; only liveness is snapshotted (`researchStates` on
every `discussions` send). On settle the server broadcasts `ended` **before** auto-starting the
orchestration, so the right pane switches research → discussion stream in one batch; a failed research
broadcasts `ended` without auto-start, surfacing the manual Start fallback. Frontend phase
(`discussionPhase`) and Start visibility (`showDiscussionStart` = `status === 'draft' &&
!researchLive && !discussionLive`) are pure helpers rebuilt from the snapshots on reconnect.

The research agent's output is written to `research_result` via `setDiscussionResearchResult` (only
when non-empty); the user's original `context` is **never** overwritten. The organizer engine's
prompt background source is `researchResult || context` — the research output feeds the discussion
when present, falling back to the user's original context otherwise.

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

- **Pause gate** — `DiscussionDeps.gate(signal)` is awaited at the top of every round. While paused
  it parks (no organizer decision, no speech); resume or abort wakes it. So pause/resume suspend the
  engine **without aborting** it (local stage/round state is preserved). `pause_discussion` /
  `resume_discussion` flip the per-run flag; an already in-flight `askAgentOnce` still finishes (the
  pause is a round-boundary gate, so one more message may land after a pause request).
- **Interjection** (`discussion_speak`) — the server pauses the run, appends a `human` message
  (streamed as `discussion_message`), and resumes; the loop re-reads `listMessages` each round, so
  the organizer's next decision sees it. With no live run (in_progress but stopped) the message is
  simply appended.
- **New round** (`continue_discussion`) — on a `completed` discussion the server appends the human's
  follow-up as a `human` message, flips `completed → in_progress`, and re-runs `runDiscussion` over
  the grown transcript. The engine needs no change: it re-enters at the first workflow stage, the
  prior conclusion + the new question are context, and `setConclusion` overwrites with the new
  outcome. A re-entry guard (`discussionRuns.has(id)`) rejects it while a run is live.

**Persistence + streaming.** Every appended message is `store.appendMessage` (monotonic per-discussion
`seq`) and streamed via `deps.onMessage` → server `discussion_message` broadcast. Status/conclusion
changes — and agenda changes (`set_agenda`/`focus_subtopic`) — fire `deps.onStatusChange` → refreshed
`discussions` list broadcast. The live **run-state**
(`running` / `paused` / `ended`) is a separate `discussion_run_status` broadcast — runtime-only and
**decoupled** from the persisted `DiscussionStatus` (a paused run is still `in_progress` on disk; the
state is lost on server restart). The frontend keys a per-discussion run-state map off it (dropping
the entry on `ended`) to render the Pause/Resume control, the composer mode (Speak vs Continue), and
the left list's per-row live badge (running pulses / paused steady, distinct from the static status
pill), so concurrent background runs are each visible.

**Run-state snapshot (refresh/reconnect accuracy).** `discussion_run_status` only fires on
_transitions_, so a freshly-(re)connected view never learns about runs that were already going. To
close this, every `discussions` list message carries a `runStates` snapshot — `discussionRunSnapshot(items)`
reads `discussionRuns` and maps each _listed_ discussion with an active run to `running`/`paused`
(active entries only). It rides all three list sends: the `list_discussions` reply, the post-change
`broadcastDiscussions` push, and (via the frontend re-issuing `list_discussions`) reconnect. The
frontend's `reconcileRunState(prev, items, snapshot)` then makes its global run-state map authoritative
for _that list's_ ids — each listed id is set from the snapshot or dropped when absent (clearing an
`ended` missed during a disconnect) — while leaving other projects' entries untouched. The
transition-only `discussion_run_status` event still drives fine-grained updates between list sends.

**Dispatch (in-flight) status.** Before a nominated agent's `askAgentOnce` turn is awaited, the engine
emits the agent(s) as in-flight via the injected `deps.onDispatchStatus` hook (`speak` lists one,
`broadcast` lists the whole batch — concurrent replies); when the turn resolves it emits `cleared`,
and when it **throws** it emits `failed` (with a brief error) instead of the former silent
`.catch(() => '')`. A failure is no longer swallowed into an empty speech — it is surfaced, the speech
is skipped, and the round still proceeds (a `broadcast` uses `Promise.allSettled`, so one failure does
not drop the rest of the batch). The server maps the per-agent `DispatchStatus`
(`pending` / `cleared` / `failed`) onto a runtime-only `discussion_dispatch_status` broadcast — **not
persisted**, never a `discussion_messages` row. The frontend (`App.vue`) keeps a per-discussion
`DispatchView` (`{ pending, errors }`) reduced by `applyDispatchStatus`; the chat tail renders
`"<name> is replying…"` per pending agent and a failure line per error. `cleared` is the reliable clear
for an empty/skipped speech that appends no message; the landed reply also clears its author eagerly
(`clearDispatchAgent` keyed by `speakerAgentId`). Unlike run-state, dispatch status is **not**
snapshotted on the `discussions` list — it is too ephemeral; it self-heals via `cleared` / `failed` /
the reply message / run `ended` / discussion switch (each drops the entry), so a refresh/reconnect
(which starts empty) leaves no stuck pending.

**Termination.** Stages move forward only and `conclude` is terminal; `maxRoundsPerStage`
forces an advance out of a stuck stage; `maxTotalRounds` (default 40) is the hard backstop,
writing a fallback conclusion. `maxRoundsPerStage` is the system-configured
`SystemSettings.maxRoundsPerStage` (minimum 8, default 12 — see agent-config AC-R9), read via
`getMaxRoundsPerStage()` and injected through `defaultDiscussionDeps`; tests may override it on
the injected deps. An abort (server teardown) breaks the loop and leaves the discussion
`in_progress` (no resume).

**Background carrier.** The server keeps a `discussionRuns: Map<id, DiscussionRunControl>` where
`DiscussionRunControl = { abort, paused, resumeWaiters }`. A present entry is the re-entry guard for
`start_discussion` / `continue_discussion`; `abort` tears the loop down; `paused` + `resumeWaiters`
back the pause gate (resume splices+wakes the waiters; the gate also wakes on `abort`, so neither
resume nor teardown can hang on a paused loop). `startDiscussionRun(discussion)` is the shared
entry — it registers the control, wires the broadcast + gate hooks into `defaultDiscussionDeps`, and
on `finally` deletes the entry and broadcasts `discussion_run_status: 'ended'`. The run uses
`askAgentOnce` (tool sessions), not a user `SessionRuntime`, so finishing it never ends a session
(既有 session 约定: a session ends only on user `/clear`).

## Testing

`server/src/discussions/store.test.ts` (real temp-file db, `node:sqlite` branch): table + index
creation and `user_version`; CRUD (create defaults + explicit fields, list ordering [tie-safe
non-increasing `updatedAt`] + status filter + project scope + trailing-slash `resolve()`
normalization, `completed_at` stamp/clear, conclusion, real-file persistence across cache reset);
messages (monotonic per-discussion seq, seq independence across discussions, `updated_at` bump,
ordered list, nullable speaker fields → null); **agenda** (`setAgenda` round-trips subtopics + index,
index reaching `length`, create default `[]`/`0`, real-file persistence); migration (old db with
**no** discussion tables → created; old `discussions` table with **only core columns** →
`ensureColumn` backfills `goal`/`context`/`research_result`/`agenda`/`agenda_index`/`conclusion`/`completed_at`, historic
row survives, idempotent on re-ensure); fail-soft degradation (reads empty/null, write throws).

`server/src/discussions/orchestrator-logic.test.ts` (pure): `parseOrganizerDecision` (JSON / fenced /
keyword fallback / invalid speaker / unparseable → advance / `set_agenda` with subtopic list / empty
subtopics degrade / `focus_subtopic` with index / next-subtopic prose / **`broadcast`** with explicit
speaker list [intersected + deduped + order-preserved] / `"all"`/omitted ⇒ whole roster / all-invalid
list recovers to whole roster / no-participants degrades / broadcast prose keyword),
`parseParticipantSpeech` (trim

- self-name strip + blank + over-long text preserved verbatim (no truncation) + short speech untouched
- explicit `maxChars` override (no-op — kept for backward compatibility), `resolveStep` (terminal-stage conclude, explicit conclude, cap-forced
  advance, valid / invalid speaker, `set_agenda` step, `focus_subtopic` advances index, focus past last →
  advance, cap moves to next subtopic when unfinished / advances on last subtopic, agenda actions degrade
  outside `discuss`, **`broadcast` in `discuss` yields a broadcast step / degrades to advance outside
  `discuss` / per-stage cap still forces forward motion over a pending broadcast**), `renderTranscript`,
  prompt builders carry the key fields (incl. the agenda + current subtopic + the `broadcast` contract).

`server/src/discussions/orchestrator.test.ts` (fakes — scripted `ask`, in-memory store, capture hooks):
the full workflow happy path (status `in_progress` → `completed`, streamed messages mirror appends,
conclusion written), the single-agent degeneration, mid-run abort leaving `in_progress`, the
total-round-cap fallback conclusion, the **pause gate** (a gate that parks the first round ⇒ status
flips but no message is streamed; release ⇒ runs to completion), a **fresh post-conclusion round**
(append a `human` question + flip to `in_progress` + re-run ⇒ new conclusion, grown transcript), an
**explicit agenda walk** (`set_agenda` ⇒ subtopic-by-subtopic `speak`/`focus_subtopic` ⇒ all done ⇒
`summarize` → `conclude`; agenda persisted, `agendaIndex === length`, one participant turn per subtopic),
the **per-subtopic cap auto-advance** (a subtopic that hits `maxRoundsPerStage` carries the engine to
the next subtopic, then out of the stage on the last), a **divergent batch broadcast** (one `discuss`
broadcast decision ⇒ multiple `agent` speeches from a single round; the organizer announces the
sub-question first; replies persist in nomination order with monotonic `seq` even when a later-nominated
agent finishes first; streaming mirrors the append order), and the **converging stages stay serial** (a
`broadcast` decision issued in `summarize` degrades to `advance` and fans out nothing).

## Dependencies

- **SQLite (shared adapter)** — `server/src/db.ts` (`node:sqlite` / `bun:sqlite`, both `external`).
- **shared protocol** — `Discussion` / `DiscussionMessage` / `DiscussionStatus` /
  `DiscussionSpeakerKind` entity types; `AgentConfig.icon` (operator-set emoji / short text per
  agent) is the wire-level source of truth for the multi-speaker chat header.
- **discussion types** — `shared/src/discussion-types.ts` (workflow stages + `nextDiscussionStage`).
- **agent runtime** — `server/src/agent-once.ts` (`askAgentOnce`) and `server/src/settings.ts`
  (`resolveAgent` / `loadSettings` / `launchForAgent`) for the organizer + participants.

## Client-side rendering (cross-reference)

The server appends messages with `speakerName` set from the agent profile; the wire model is the
source of truth, and the organizer/agent ids resolve to the live `SystemSettings.agents` roster on
the client. The web client draws a small 「icon + name」 line above every discussion message body
and the resolution rules (organizer ⇒ default agent, agent ⇒ by id, fallbacks, blank-icon trim)
live in the web-console design — see
[Discussion speaker rendering](../web-console/design.md#discussion-speaker-rendering-multi-speaker-chat-header).
No server changes are required for that surface; the icon field is consumed read-only.
