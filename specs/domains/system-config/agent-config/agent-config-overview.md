# agent-config — Domain Overview

| Field          | Value                                                                                   |
| -------------- | --------------------------------------------------------------------------------------- |
| Responsibility | Manage agent profiles (url/key/model + name), the default agent, per-session agent bind |
| API            | WebSocket `/ws` (see shared protocol)                                                   |
| Status         | active                                                                                  |

An **agent** is a named set of Claude Code launch overrides — `baseUrl`, `apiKey`, `model`. The
built-in **system agent** has empty overrides (it launches Claude Code exactly as the bare SDK
would, using the user's existing `claude` login) and cannot be removed. The user may add more
agents and pick one as the **default**. Every session launches with its bound agent, or the
default agent when unbound.

It does not run the agent (that is [agent-session](../../core/agent-session/agent-session-overview.md))
and does not render the settings view (that is [web-console](../../core/web-console/web-console-overview.md)).

See [spec.md](spec.md), [models.md](models.md), [design.md](design.md).
