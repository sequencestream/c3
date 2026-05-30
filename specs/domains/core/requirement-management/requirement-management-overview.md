# Domain: requirement-management

- **Group:** core
- **One-line:** A project-scoped requirement ledger plus a read-only requirement-communication
  agent that breaks ideas into verifiable items, can launch development, and can auto-develop a
  flagged backlog end-to-end (judge → commit → push → next).
- **Owner:** maintainer
- **Status:** active
- **Depends on:** `agent-session` (runs the communication agent as a `requirement`-kind
  runtime, launches development runs, and runs the one-shot completion judge); `permission-gateway`
  (gates `save_requirements` via the existing `canUseTool` flow); `session-registry` (hides
  communication sessions from the normal session list); a local SQLite store at `~/.c3/c3.db`; the
  local `git` CLI (the automation orchestrator commits & pushes on a verified completion).
- **Depended on by:** `web-console` (renders the requirement view: list + communication chat +
  automation controls).
- **exposes-api:** true — eight `ClientToServer` messages and two `ServerToClient` messages
  (`requirements`, `automation_status`) on the WebSocket `/ws`. Chat I/O, history replay, and save
  confirmation **reuse** existing protocol events; the requirement list/launch/automation messages
  are new. Message shapes are defined in the shared protocol, not here.
- **ADRs:** [0007](../../../architecture/adr/0007-read-only-requirement-agent.md)

## Index

- [spec.md](spec.md) — entities, state machine, user stories US-1..US-9, business rules
  (incl. the automation orchestrator RM-A1–A9)
- [design.md](design.md) — SQLite driver adapter, communication-runtime variant, save tool,
  launch-development wiring, automation orchestrator (state machine + completion judge + git helper)
- [models.md](models.md) — Requirement / Requirement Dependency / Communication Session /
  Automation Status entities
