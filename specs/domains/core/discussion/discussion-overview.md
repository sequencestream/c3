# Domain: discussion

A project-scoped **discussion** store: a discussion (a goal-directed conversation among an
organizer, agents, and the human) plus its ordered messages, persisted in the shared
`~/.c3/c3.db` alongside the requirement ledger.

**Status: partial — persistence foundation only.** This domain currently provides the data model
and the SQLite persistence layer (tables + store CRUD). The discussion _agent_, the _organizer /
orchestration_, the WebSocket protocol, and the frontend are **not yet built**; they will layer on
this foundation later.

## Scope (now)

- Two tables in c3.db: `discussions` and `discussion_messages` (see [models](models.md)).
- A store (`server/src/discussions/store.ts`) with discussion CRUD + message append/list (see
  [design](design.md)).
- Reuses the shared cross-runtime SQLite adapter (`server/src/db.ts`, ADR 0007) and the requirement
  store's fail-soft + `PRAGMA user_version` + idempotent `ensureColumn` migration paradigm.

## Out of scope (now)

- No discussion agent / read-only enforcement / save-confirmation tooling.
- No organizer or multi-agent orchestration loop.
- No wire protocol messages and no frontend view.

## Index

- [models.md](models.md) — entity definitions (`Discussion`, `DiscussionMessage`).
- [design.md](design.md) — the SQLite persistence layer (schema, migration, store API).

## Dependencies

- **SQLite (shared adapter)** — `server/src/db.ts`; `node:sqlite` (Node) / `bun:sqlite` (Bun),
  both `external` in esbuild (ADR 0007).
