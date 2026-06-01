# Domain: discussion

A project-scoped **discussion** store: a discussion (a goal-directed conversation among an
organizer, agents, and the human) plus its ordered messages, persisted in the shared
`~/.c3/c3.db` alongside the requirement ledger.

**Status: partial — persistence + create flow.** This domain provides the data model and SQLite
persistence layer (tables + store CRUD), the read path (list + open), and the **create flow**: a
data-driven type catalog with per-type workflow, the "+" form, and a read-only research agent that
completes a new discussion's context. The _organizer / multi-agent orchestration loop_ (driving a
discussion through its workflow with participating agents) is **not yet built**; it will consume the
workflow definitions later.

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
- Frontend: the discussion-view "+" opens an inline create form (type dropdown / goal / context).
- Reuses the shared cross-runtime SQLite adapter (`server/src/db.ts`, ADR 0007) and the requirement
  store's fail-soft + `PRAGMA user_version` + idempotent `ensureColumn` migration paradigm.

## Out of scope (now)

- No organizer or multi-agent orchestration loop (the workflow catalog is data only; nothing yet
  drives a discussion through its stages).
- No discussion message-append write path or status-transition UI.

## Index

- [models.md](models.md) — entity definitions (`Discussion`, `DiscussionMessage`).
- [design.md](design.md) — the SQLite persistence layer (schema, migration, store API).
- Type catalog + workflow: `shared/src/discussion-types.ts`; create flow + research agent:
  `server/src/discussions/research.ts`, `create_discussion` handler in `server/src/server.ts`.

## Dependencies

- **SQLite (shared adapter)** — `server/src/db.ts`; `node:sqlite` (Node) / `bun:sqlite` (Bun),
  both `external` in esbuild (ADR 0007).
