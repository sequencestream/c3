# discussion — Design

The [discussion](discussion-overview.md) domain's server design: the SQLite **persistence layer**
(`server/src/discussions/store.ts` over the shared adapter `server/src/db.ts`, implementing the
[models](models.md)) and the **organizer engine** (`orchestrator.ts` + pure `orchestrator-logic.ts`)
that drives a discussion through its workflow. The wire protocol
(`create_discussion` / `start_discussion` / `discussion_message`) is in
[websocket-protocol.md](../../../shared/api-conventions/websocket-protocol.md).

## Module split

| Concern               | File                              | Notes                                                                                     |
| --------------------- | --------------------------------- | ----------------------------------------------------------------------------------------- |
| Shared SQLite adapter | `server/src/db.ts`                | Cross-runtime `node:sqlite` / `bun:sqlite` (ADR 0007); shared with requirement-management |
| Discussion store      | `server/src/discussions/store.ts` | Schema ownership + discussion/message CRUD                                                |

## SQLite layer (shared `db.ts`)

The discussion store reuses the shared adapter unchanged (see
[requirement-management design §SQLite layer](../requirement-management/design.md) and
[ADR 0007](../../../architecture/adr/0007-read-only-requirement-agent.md) for the full rationale):
one minimal **synchronous** interface (`exec`/`run`/`all`/`get`) selected by `globalThis.Bun`,
`?`-only placeholders, rows read by field, `~/.c3/c3.db`, WAL + `busy_timeout`, esbuild `external`
for both driver modules.

`db.ts` was promoted from `server/src/requirements/db.ts` to a neutral location precisely because it
is generic: the discussion store and the requirement store are **sibling domains** over one db, and
neither should depend on the other. Both ride the single c3.db connection; each owns its own tables
and a private `schemaReady` flag.

## Schema (`PRAGMA user_version` migrations)

Two tables, ensured lazily on the discussion store's first access via `exec(SCHEMA)`
(`CREATE TABLE IF NOT EXISTS` + `CREATE INDEX IF NOT EXISTS`):

- `discussions` — `id` (PK), `project_path`, `title`, `type`, `goal` (`TEXT NOT NULL DEFAULT ''`),
  `context` (`TEXT NOT NULL DEFAULT ''`), `status`, `conclusion` (nullable), `created_at`,
  `updated_at`, `completed_at` (nullable). Indexed by `idx_disc_project_status (project_path,
status)`.
- `discussion_messages` — `id` (PK), `discussion_id`, `seq`, `speaker_kind`, `speaker_agent_id`
  (nullable), `speaker_name` (nullable), `content`, `created_at`. Indexed by
  `idx_disc_msg_discussion (discussion_id, seq)` — the natural read path for `listMessages`.

**Schema version (current: v1).** `SCHEMA_VERSION = 1`, written via `PRAGMA user_version`. The
single c3.db `user_version` counter is **shared** with the requirement store, so the two clobber
each other on write — this is intentional and harmless: migrations key off **actual presence**
(`PRAGMA table_info` for columns, `CREATE TABLE IF NOT EXISTS` for tables), never off the version
number. The value is informational only.

**Idempotent migration (`ensureColumn`).** After `exec(SCHEMA)` and before writing `user_version`,
the store runs `ensureColumn` for the optional/nullable columns
(`goal`, `context`, `conclusion`, `completed_at`): each checks `PRAGMA table_info(discussions)` and
only runs `ALTER TABLE … ADD COLUMN` when the column is absent. This is a **defensive forward-compat
backfill** — a `discussions` table created by an earlier in-development build that predated these
columns is upgraded in place; on a fresh schema each call is a no-op, and the whole sequence is
idempotent across runs. Same key-off-column-presence paradigm as the requirement store's
`module`/`completed_at`/`automate` migrations. Both drivers support `PRAGMA table_info` /
`ALTER TABLE ADD COLUMN` through the shared `exec`/`all` surface.

**Fail-soft.** When `getDb()` returns null (open/create failure), reads return empty/null and
writes throw (`requireDb` → `Error('讨论库不可用')`) — c3 boots and runs without the discussion
feature, consistent with the requirement store's degradation contract.

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
now : null` (mirrors the requirement store's done-stamping rule, including clearing on revert).
- `setConclusion(id, conclusion)` — sets `conclusion` + bumps `updated_at`.
- `appendMessage({ discussionId, speakerKind, speakerAgentId?, speakerName?, content })` →
  `DiscussionMessage`. In **one transaction**: reads `COALESCE(MAX(seq),0)+1` for that discussion,
  inserts the message, and bumps the discussion's `updated_at`. The transaction makes the seq
  race-free under the single synchronous connection; `seq` is independent per discussion.
- `listMessages(discussionId)` → `DiscussionMessage[]`, `ORDER BY seq ASC`.
- `isStoreAvailable()` / `resetStoreForTests()` mirror the requirement store.

## Organizer engine

The orchestration loop that drives a `draft` discussion to a `conclusion`. Split for testability:

| Concern               | File                                           | Notes                                                                                                                                    |
| --------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Pure decision/parsing | `server/src/discussions/orchestrator-logic.ts` | No I/O/SDK: prompt builders, `parseOrganizerDecision`, `parseParticipantSpeech`, `resolveStep`, `renderTranscript`. Unit-tested.         |
| Orchestration loop    | `server/src/discussions/orchestrator.ts`       | `runDiscussion(id, signal, deps)` + `defaultDiscussionDeps`. All collaborators injected (`DiscussionDeps`).                              |
| One-shot agent turn   | `server/src/agent-once.ts`                     | `askAgentOnce` (extracted from consensus): a single tool-disabled turn under the agent's launch overrides, registered as a tool session. |

**Roles.** The **organizer** is the default agent (`resolveAgent(null)`); the **participants** are
all configured agents (`loadSettings().agents`) — the organizer included, so it may nominate itself
and is the sole speaker when only one agent is configured (the consensus "no voters" degeneration).

**Round model.** Each round the organizer is asked, over the live transcript + the active workflow
stage, for a decision; `parseOrganizerDecision` reads it (JSON `{action, speaker, note, conclusion}`
first, keyword fallback, and a safe `advance` default so an unparseable reply never hangs).
`resolveStep` folds the stage and the per-stage round cap into a concrete step:

- `speak` — a nominated participant takes a one-shot turn (`askAgentOnce` → `parseParticipantSpeech`);
  its speech is appended as a `speakerKind: 'agent'` message.
- `advance` — move to the next workflow stage; a non-empty organizer `note` (e.g. the summary) is
  appended as a `speakerKind: 'organizer'` message.
- `conclude` — append the final conclusion (organizer message), `setConclusion`, `completed`.

**State machine.**

```
draft ──start_discussion──▶ in_progress ──(walk workflow stages)──▶ completed (conclusion written)
                                  │
   discuss ──advance──▶ summarize ──advance──▶ confirm ──advance──▶ conclude ──▶ conclude step
      ▲  │ speak (participant turn, loops, capped by maxRoundsPerStage)
      └──┘
   (an explicit `conclude` decision finishes from any stage; the terminal `conclude` stage
    always concludes)
```

**Persistence + streaming.** Every appended message is `store.appendMessage` (monotonic per-discussion
`seq`) and streamed via `deps.onMessage` → server `discussion_message` broadcast. Status/conclusion
changes fire `deps.onStatusChange` → refreshed `discussions` list broadcast.

**Termination.** Stages move forward only and `conclude` is terminal; `maxRoundsPerStage`
(default `max(3, participants*2+1)`) forces an advance out of a stuck stage; `maxTotalRounds`
(default 40) is the hard backstop, writing a fallback conclusion. An abort (server teardown) breaks
the loop and leaves the discussion `in_progress` (no resume).

**Background carrier.** The server keeps a `discussionRuns: Map<id, AbortController>` — the running
entry is the `start_discussion` re-entry guard, and the controller aborts the loop. The run uses
`askAgentOnce` (tool sessions), not a user `SessionRuntime`, so finishing it never ends a session
(既有 session 约定: a session ends only on user `/clear`).

## Testing

`server/src/discussions/store.test.ts` (real temp-file db, `node:sqlite` branch): table + index
creation and `user_version`; CRUD (create defaults + explicit fields, list ordering [tie-safe
non-increasing `updatedAt`] + status filter + project scope + trailing-slash `resolve()`
normalization, `completed_at` stamp/clear, conclusion, real-file persistence across cache reset);
messages (monotonic per-discussion seq, seq independence across discussions, `updated_at` bump,
ordered list, nullable speaker fields → null); migration (old db with **no** discussion tables →
created; old `discussions` table with **only core columns** → `ensureColumn` backfills, historic
row survives, idempotent on re-ensure); fail-soft degradation (reads empty/null, write throws).

`server/src/discussions/orchestrator-logic.test.ts` (pure): `parseOrganizerDecision` (JSON / fenced /
keyword fallback / invalid speaker / unparseable → advance), `parseParticipantSpeech` (trim + self-name
strip + blank), `resolveStep` (terminal-stage conclude, explicit conclude, cap-forced advance, valid /
invalid speaker), `renderTranscript`, prompt builders carry the key fields.

`server/src/discussions/orchestrator.test.ts` (fakes — scripted `ask`, in-memory store, capture hooks):
the full workflow happy path (status `in_progress` → `completed`, streamed messages mirror appends,
conclusion written), the single-agent degeneration, mid-run abort leaving `in_progress`, and the
total-round-cap fallback conclusion.

## Dependencies

- **SQLite (shared adapter)** — `server/src/db.ts` (`node:sqlite` / `bun:sqlite`, both `external`).
- **shared protocol** — `Discussion` / `DiscussionMessage` / `DiscussionStatus` /
  `DiscussionSpeakerKind` entity types.
- **discussion types** — `shared/src/discussion-types.ts` (workflow stages + `nextDiscussionStage`).
- **agent runtime** — `server/src/agent-once.ts` (`askAgentOnce`) and `server/src/settings.ts`
  (`resolveAgent` / `loadSettings` / `launchForAgent`) for the organizer + participants.
