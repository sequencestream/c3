# Domain: intent-management

- **Group:** core
- **One-line:** A project-scoped intent ledger plus a read-only intent-communication
  agent that breaks ideas into verifiable items, can launch development, and can auto-develop a
  flagged backlog end-to-end (judge → commit → push → next).
- **Owner:** maintainer
- **Status:** active
- **Depends on:** `agent-session` (runs the communication agent as a `intent`-kind
  runtime, launches development runs, and runs the one-shot completion judge); `permission-gateway`
  (gates `save_intents` via the existing `canUseTool` flow); `session-registry` (hides
  communication sessions from the normal session list); a local SQLite store at `~/.c3/c3.db`; the
  local `git` CLI (the automation orchestrator commits & pushes on a verified completion).
- **Depended on by:** `web-console` (renders the intent view: list + communication chat +
  automation controls).
- **exposes-api:** true — eight client-to-server messages and two server-to-client messages
  (`intents`, `automation_status`) on the WebSocket `/ws`. Chat I/O, history replay, and save
  confirmation **reuse** existing protocol events; the intent list/launch/automation messages
  are new. Message shapes are defined in the shared protocol, not here.
- **ADRs:** [0007](../../../architecture/adr/0007-read-only-intent-agent.md)

## Index

- [intent-management-spec.md](intent-management-spec.md) — entities, state machine, user stories US-1..US-9, business rules
  (incl. the automation orchestrator RM-A1–A9)
- [intent-management-design.md](intent-management-design.md) — SQLite driver adapter, communication-runtime variant, save tool,
  launch-development wiring, automation orchestrator (state machine + completion judge + git helper)
- [intent-management-models.md](intent-management-models.md) — Intent / Intent Dependency / Communication Session /
  Automation Status entities
