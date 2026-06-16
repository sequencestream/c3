# discussion — Models

Entity definitions. Business-semantic types; physical wiring (schema, migrations) is in
[design.md](design.md). The Discussion, Discussion Message, status, and speaker-kind shapes are
part of the single shared wire/persistence contract — the same home as the intent entity types —
and referenced here rather than redefined.

## Discussion

A goal-directed conversation scoped to one project.

| Attribute             | Type              | Description                                                                                                                                                                                                                                         |
| --------------------- | ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                  | text (UUID)       | Stable identifier; referenced by messages                                                                                                                                                                                                           |
| `workspacePath`       | text (path)       | Resolved absolute workspace path; the workspace key (always resolved to an absolute path)                                                                                                                                                           |
| `title`               | text              | Short discussion title                                                                                                                                                                                                                              |
| `type`                | text              | Free-form discussion type/category (e.g. design, arch); no enum constraint at the persistence layer                                                                                                                                                 |
| `goal`                | text              | What the discussion aims to achieve; `''` when unset                                                                                                                                                                                                |
| `context`             | text              | Background material seeding the discussion — the user's original input; `''` when unset; **never overwritten by research**                                                                                                                          |
| `researchResult`      | text              | The read-only research agent's completed output, stored apart from `context`; `''` until research yields a non-empty result (or when research is skipped/fails)                                                                                     |
| `status`              | enum              | `draft`\|`in_progress`\|`completed`\|`cancelled`                                                                                                                                                                                                    |
| `agenda`              | string[]          | Organizer's ordered subtopics decomposed from `goal`; `[]` when no agenda is set                                                                                                                                                                    |
| `agendaIndex`         | integer           | 0-based index of the current subtopic (`0..agenda.length`); `=== agenda.length` ⇒ all subtopics done                                                                                                                                                |
| `participantAgentIds` | string[]          | Agents selected at creation to participate; the orchestrator nominates from this set only (∪ the always-included organizer). `[]` = unset/legacy ⇒ fall back to the whole enabled-agent roster. Persisted as a JSON array (`participant_agent_ids`) |
| `conclusion`          | text \| null      | The concluded outcome; `null` until the engine writes it                                                                                                                                                                                            |
| `createdAt`           | timestamp         | Creation time                                                                                                                                                                                                                                       |
| `updatedAt`           | timestamp         | Last mutation time (bumped by status/conclusion changes and by appending a message)                                                                                                                                                                 |
| `completedAt`         | timestamp \| null | When status entered `completed`; stamped on transition to `completed`, cleared (null) when it leaves it                                                                                                                                             |

Status lifecycle: `draft` (created, not started) → `in_progress` (underway) →
`completed` (concluded; stamps `completedAt`) / `cancelled` (abandoned, terminal, no stamp).

Relationships: belongs to one project (by `workspacePath`); has zero or more Discussion Messages.

## Discussion Message

One message within a discussion, ordered by a per-discussion monotonic sequence number.

| Attribute        | Type         | Description                                                                  |
| ---------------- | ------------ | ---------------------------------------------------------------------------- |
| `id`             | text (UUID)  | Stable identifier                                                            |
| `discussionId`   | text (UUID)  | The owning discussion                                                        |
| `seq`            | integer      | Per-discussion monotonic sequence (1-based, assigned `MAX(seq)+1` on append) |
| `speakerKind`    | enum         | `organizer`\|`agent`\|`human` — who authored the message                     |
| `speakerAgentId` | text \| null | The participating agent's id when `speakerKind === 'agent'`; else `null`     |
| `speakerName`    | text \| null | Display name of the speaker; `null` when not applicable                      |
| `content`        | text         | Message body                                                                 |
| `createdAt`      | timestamp    | Creation time                                                                |

Relationships: belongs to one Discussion (by `discussionId`). `seq` is unique within a discussion
and independent across discussions. Appending a message also bumps the owning discussion's
`updatedAt`.
