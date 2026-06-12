# Cross-domain Flows — Index

A **flow** is an ordered, cross-domain business scenario: it stitches together the rules that
several domains own to describe one end-to-end path through c3. Flows do **not** restate domain
rules — each step references the owning domain's rule ID (`AS-R*`, `SR-R*`, `PG-R*`, `RM-R*`,
`RM-A*`, `SCH-R*`, `AC-R*`, `AUTH-R*`). Read the domain spec for _what a rule means_; read a flow
for _the order things happen and where they branch_.

Wire message shapes are defined once in
[`shared/api-conventions/websocket-protocol.md`](../shared/api-conventions/websocket-protocol.md)
(code: `shared/src/protocol.ts`). Flows name messages; they do not redefine their shapes.

## The flows

| Flow                                                                 | Scenario                                                                                                   | Domains spanned                                                                          |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| [prompt → gated run](flow-prompt-to-gated-run.md)                    | A prompt becomes a run; sensitive tools are gated (consensus then human); text streams back                | web-console · session-registry · agent-config · agent-session · permission-gateway       |
| [workspace & session lifecycle](flow-workspace-session-lifecycle.md) | Register a workspace, create/select/bind/rename/delete a session, freeze its vendor                        | web-console · session-registry · agent-session · agent-config                            |
| [run resilience](flow-run-resilience.md)                             | A run survives a socket drop, an agent failure, or an unreachable vendor without losing context            | agent-session · agent-config · permission-gateway                                        |
| [intent → development](flow-intent-to-development.md)                | An idea is refined into verifiable intents, then one is launched into a background development session     | intent-management · agent-session · permission-gateway · session-registry · agent-config |
| [automation orchestrator](flow-automation-orchestrator.md)           | A backlog of `automate` intents is built one-by-one: develop, judge, commit/push, advance                  | intent-management · agent-session · permission-gateway · git                             |
| [discussion → intent](flow-discussion-to-intent.md)                  | A goal is researched, debated by an organizer-led roundtable to a conclusion, then converted to intents    | discussion · agent-config · intent-management                                            |
| [schedule execution](flow-schedule-execution.md)                     | A cron/event trigger fires a command or LLM-prompt task under an execution identity; the outcome is logged | schedules · session-registry · agent-session                                             |
| [auth login gate](flow-auth-login.md)                                | A connection authenticates before driving agents (the precondition for network exposure)                   | auth · web-console · system-config                                                       |

## Reading conventions

Each flow file follows the same shape: a **flow graph** (a Mermaid diagram of the whole path) at
the top, then **step descriptions** (ordered sections), then **branches & exceptions**.

- **Actors** are domains (or the SDK / browser / OS), not classes. A step reads `actor → action`.
- **Branches & exceptions** list the alternative paths and the anti-scenarios (what must _never_
  happen), each tied to the rule that forbids it.
- A flow is **current state**. A step describing planned/partial behaviour is marked inline and
  cites the domain's status note.
