# Domain: requirement-management

- **Group:** core
- **One-line:** A project-scoped requirement ledger plus a read-only requirement-communication
  agent that breaks ideas into verifiable items and can launch development.
- **Owner:** maintainer
- **Status:** active
- **Depends on:** `agent-session` (runs the communication agent as a `requirement`-kind
  runtime and launches development runs); `permission-gateway` (gates `save_requirements`
  via the existing `canUseTool` flow); `session-registry` (hides communication sessions from
  the normal session list); a local SQLite store at `~/.c3/c3.db`.
- **Depended on by:** `web-console` (renders the requirement view: list + communication chat).
- **exposes-api:** true — five `ClientToServer` messages and one `ServerToClient` message on
  the WebSocket `/ws`. Chat I/O, history replay, and save confirmation **reuse** existing
  protocol events; only the requirement-specific list/launch messages are new. Message shapes
  are defined in the shared protocol, not here.
- **ADRs:** [0007](../../../architecture/adr/0007-read-only-requirement-agent.md)

## Index

- [spec.md](spec.md) — entities, state machine, user stories US-1..US-8, business rules
- [design.md](design.md) — SQLite driver adapter, communication-runtime variant, save tool,
  launch-development wiring
- [models.md](models.md) — Requirement / Requirement Dependency / Communication Session entities
