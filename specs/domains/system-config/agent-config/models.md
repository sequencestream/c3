# agent-config — Models

Entity definitions. Business-semantic types; physical wiring in [design.md](design.md). Wire
shapes (`AgentConfig`, `SystemSettings`, `SYSTEM_AGENT_ID`) are defined once in the
[shared protocol](../../../shared/api-conventions/websocket-protocol.md).

## Agent

A Claude Code launch profile.

| Attribute | Type       | Description                                                                                                                                                                                                                 |
| --------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`      | text       | Stable id; `'system'` (`SYSTEM_AGENT_ID`) for the built-in agent                                                                                                                                                            |
| `name`    | text       | Display name                                                                                                                                                                                                                |
| `baseUrl` | text (url) | `ANTHROPIC_BASE_URL` override; empty ⇒ no override (AC-R5)                                                                                                                                                                  |
| `apiKey`  | text       | API key / auth token override; empty ⇒ no override (AC-R5)                                                                                                                                                                  |
| `model`   | text       | Model alias or id; empty ⇒ no override (AC-R5)                                                                                                                                                                              |
| `enabled` | bool (opt) | Enabled flag; absent/`true` ⇒ enabled, only explicit `false` disables. Disabled agents drop out of every list consumer (participants, voters, degradation chain, default picker) but remain valid launch fallbacks (AC-R10) |
| `icon`    | text (opt) | Optional display icon (emoji / short text). Empty/absent ⇒ no custom icon. Trimmed and capped to 16 chars; not validated as a real emoji. Old configs without the field load as `''` (AC-R11)                               |

Relationships: zero or more Sessions bind to an Agent; an unbound session uses the default.

## System Agent

The built-in agent. Same shape as Agent, but `id === 'system'` and all three overrides are
always empty (AC-R1). Always present, never removable. Its `enabled` flag IS honoured, so the
system agent can be disabled like any other (AC-R10) — it then leaves the list consumers but
still serves as a launch fallback. Its `icon` field is honoured the same way — a custom icon on
the system agent is preserved through normalize (AC-R11), independently of AC-R1's override
clearing.

## SystemSettings

The whole configuration, persisted at `~/.c3/settings.json`.

| Field               | Type                    | Description                                                                                                                                                              |
| ------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `agents`            | `Agent[]`               | The registry; always includes the system agent (AC-R1)                                                                                                                   |
| `defaultAgentId`    | text                    | Id of an existing agent; falls back to system agent (AC-R2)                                                                                                              |
| `defaultMode`       | `PermissionMode` (opt.) | Permission mode new sessions start in; one of the five `PermissionMode` values, falls back to `default` (AC-R8). Seeds a new session's mode in session-registry (SR-R6). |
| `consensus`         | `{enabled}` (opt.)      | Multi-agent consensus voting on permission prompts; off by default. Consumed by the permission gateway — see [consensus.md](../../core/permission-gateway/consensus.md). |
| `maxRoundsPerStage` | number (opt.)           | Per-stage round cap for multi-agent discussions; normalized to ≥ 8, default 12 (AC-R9). Consumed by the discussion engine.                                               |

## Session binding (state.json, `~/.c3`)

The per-session agent binding — distinct from the session-registry's state.

| Field           | Type                      | Description                                              |
| --------------- | ------------------------- | -------------------------------------------------------- |
| `version`       | `1`                       | Schema version                                           |
| `sessionAgents` | map `sessionId → agentId` | Binding; a missing entry ⇒ use the default agent (AC-R4) |
