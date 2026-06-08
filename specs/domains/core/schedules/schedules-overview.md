# Domain: schedules

| Field          | Value                                                                                                                       |
| -------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Responsibility | Manage cron- and event-triggered execution of commands and LLM prompts across workspaces; record and inspect execution logs |
| API            | WebSocket `/ws` (see shared protocol); subscribes to kernel run-lifecycle events (ADR-0018)                                 |
| Status         | planned — first spec iteration                                                                                              |

The schedules domain adds **task execution** to c3. A **Schedule** is a task — a shell command or an LLM
prompt — that fires either at a configured time (cron) or on a subscribed **run lifecycle event**
(`run:started` / `run:settled`, 2026-06-08). Each execution produces an **ExecutionLog** for review.

Schedules are **workspace-scoped**: every schedule is bound to one workspace (registrant directory, via
[session-registry](../session-registry/spec.md)) and **vendor-scoped**: a schedule declares which vendor
(`claude` / `codex` / `opencode`) it belongs to, so the dispatcher routes execution to the right agent.
The scheduling engine runs inside the server process and drives execution via the same runtime
infrastructure that [agent-session](../agent-session/spec.md) owns.

It does not gate individual tool calls within a schedule's run (that is
[permission-gateway](../permission-gateway/spec.md)) and does not render the schedule list or log viewer
(that is [web-console](../web-console/web-console-overview.md)).

## Index

- [spec.md](spec.md) — entities, state machine, task types, permissions, execution identity, write queue, v1 exclusions
- [design.md](design.md) — database tables, CRUD store, scheduling engine, execution flow
- [models.md](models.md) — Schedule and ExecutionLog entity field definitions
