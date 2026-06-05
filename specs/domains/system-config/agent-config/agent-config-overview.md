# agent-config — Domain Overview

| Field          | Value                                                                                                         |
| -------------- | ------------------------------------------------------------------------------------------------------------- |
| Responsibility | Manage agent profiles (vendor-discriminated config + display name), the default agent, per-session agent bind |
| API            | WebSocket `/ws` (see shared protocol)                                                                         |
| Status         | active                                                                                                        |

An **agent** is a vendor-agnostic public shell (`id`, `vendor`, `displayName`, `enabled?`, `icon?`)
plus a `vendor`-discriminated `config` sub-object. Today the only vendor with an adapter — and thus
a config shape — is **claude** (`config = { baseUrl, apiKey, model }`, the Claude Code launch
overrides); `codex`/`opencode` are the extension point (ADR-0011). The built-in **system agent** is
a claude agent with an all-empty config (it launches exactly as the bare SDK would, using the user's
existing `claude` login) and cannot be removed. The user may add more agents and pick one as the
**default**. Every session launches with its bound agent, or the default agent when unbound — its
`config` mapped to launch overrides per its `vendor` tag.

It does not run the agent (that is [agent-session](../../core/agent-session/agent-session-overview.md))
and does not render the settings view (that is [web-console](../../core/web-console/web-console-overview.md)).

See [spec.md](spec.md), [models.md](models.md), [design.md](design.md).
