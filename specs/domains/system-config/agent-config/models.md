# agent-config — Models

Entity definitions. Business-semantic types; physical wiring in [design.md](design.md). Wire
shapes (`AgentConfig`, `SystemSettings`, `SYSTEM_AGENT_ID`) are defined once in the
[shared protocol](../../../shared/api-conventions/websocket-protocol.md).

## Agent

A Claude Code launch profile.

| Attribute | Type       | Description                                                      |
| --------- | ---------- | ---------------------------------------------------------------- |
| `id`      | text       | Stable id; `'system'` (`SYSTEM_AGENT_ID`) for the built-in agent |
| `name`    | text       | Display name                                                     |
| `baseUrl` | text (url) | `ANTHROPIC_BASE_URL` override; empty ⇒ no override (AC-R5)       |
| `apiKey`  | text       | API key / auth token override; empty ⇒ no override (AC-R5)       |
| `model`   | text       | Model alias or id; empty ⇒ no override (AC-R5)                   |

Relationships: zero or more Sessions bind to an Agent; an unbound session uses the default.

## System Agent

The built-in agent. Same shape as Agent, but `id === 'system'` and all three overrides are
always empty (AC-R1). Always present, never removable.

## SystemSettings

The whole configuration, persisted at `~/.c3/settings.json`.

| Field            | Type               | Description                                                                                                                                                              |
| ---------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `agents`         | `Agent[]`          | The registry; always includes the system agent (AC-R1)                                                                                                                   |
| `defaultAgentId` | text               | Id of an existing agent; falls back to system agent (AC-R2)                                                                                                              |
| `consensus`      | `{enabled}` (opt.) | Multi-agent consensus voting on permission prompts; off by default. Consumed by the permission gateway — see [consensus.md](../../core/permission-gateway/consensus.md). |

## Session binding (state.json, `~/.c3`)

The per-session agent binding — distinct from the session-registry's state.

| Field           | Type                      | Description                                              |
| --------------- | ------------------------- | -------------------------------------------------------- |
| `version`       | `1`                       | Schema version                                           |
| `sessionAgents` | map `sessionId → agentId` | Binding; a missing entry ⇒ use the default agent (AC-R4) |
