# Domain: automations

| Field          | Value                                                                                                                       |
| -------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Responsibility | Manage cron- and event-triggered execution of commands and LLM prompts across workspaces; record and inspect execution logs |
| API            | WebSocket `/ws` (see shared protocol); subscribes to kernel run-lifecycle events (ADR-0018)                                 |
| Status         | planned — first spec iteration                                                                                              |

The automations domain adds **task execution** to c3. A **Automation** is a task — a shell command or an LLM
prompt — that fires either at a configured time (cron) or on a subscribed **run lifecycle event**
(`run:started` / `run:settled`, 2026-06-08). Each execution produces an **ExecutionLog** for review.

Automations are **workspace-scoped**: every automation is bound to one workspace (registrant directory, via
[session-registry](../session-registry/session-registry-spec.md)) and **vendor-scoped**: a automation declares which vendor,
and execution resolves to the first enabled agent of that vendor. The vendor's tool manifest — the SDK
built-in tools plus (for Claude) workspace MCP namespace prefixes — is listed at automation creation time
via `get_automation_tool_manifest` so the user can select which tools the automation may use.

The scheduling engine runs inside the server process and drives execution via the same runtime
infrastructure that [agent-session](../agent-session/agent-session-spec.md) owns.

It does not gate individual tool calls within a automation's run (that is
[permission-gateway](../permission-gateway/permission-gateway-spec.md)) and does not render the automation list or log viewer
(that is [web-console](../web-console/web-console-overview.md)).

## Index

- [automations-spec.md](automations-spec.md) — entities, state machine, task types, permissions, execution identity, write queue, v1 exclusions
- [automations-design.md](automations-design.md) — database tables, CRUD store, scheduling engine, execution flow
- [automations-models.md](automations-models.md) — Automation and ExecutionLog entity field definitions
