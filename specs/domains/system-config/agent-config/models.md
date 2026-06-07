# agent-config — Models

Entity definitions. Business-semantic types; physical wiring in [design.md](design.md). Wire
shapes (`AgentConfig`, `AgentConfigBase`, `ClaudeAgentConfig`, `SystemSettings`, `SYSTEM_AGENT_ID`)
are defined once in the [shared protocol](../../../shared/api-conventions/websocket-protocol.md).

## Agent

A launch profile: a vendor-agnostic **public shell** plus a `vendor`-discriminated `config`
sub-object (AC-R12). `AgentConfig` is a discriminated union keyed on `vendor`; the runtime schema
that validates + routes it lives in `kernel/agent-config/schema.ts`, pinned to the wire type by a
compile-time assertion.

### Public shell (`AgentConfigBase`)

| Attribute     | Type       | Description                                                                                                                                                                                                                 |
| ------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`          | text       | Stable id; `'system'` (`SYSTEM_AGENT_ID`) for the built-in agent                                                                                                                                                            |
| `vendor`      | `VendorId` | The discriminant. The agent's vendor; only `claude` has a config shape today (`codex`/`opencode` are the extension point, ADR-0011)                                                                                         |
| `displayName` | text       | Display name (was `name` before the vendor refactor)                                                                                                                                                                        |
| `enabled`     | bool (opt) | Enabled flag; absent/`true` ⇒ enabled, only explicit `false` disables. Disabled agents drop out of every list consumer (participants, voters, degradation chain, default picker) but remain valid launch fallbacks (AC-R10) |
| `icon`        | text (opt) | Optional display icon (emoji / short text). Empty/absent ⇒ no custom icon. Trimmed and capped to 16 chars; not validated as a real emoji. Old configs without the field load as `''` (AC-R11)                               |

### Claude config sub-object (`ClaudeAgentConfig`, `vendor === 'claude'`)

| Attribute | Type       | Description                                                |
| --------- | ---------- | ---------------------------------------------------------- |
| `baseUrl` | text (url) | `ANTHROPIC_BASE_URL` override; empty ⇒ no override (AC-R5) |
| `apiKey`  | text       | API key / auth token override; empty ⇒ no override (AC-R5) |
| `model`   | text       | Model alias or id; empty ⇒ no override (AC-R5)             |

Relationships: zero or more Sessions bind to an Agent; an unbound session uses the default.

## System Agent

The built-in agent. Same shell as Agent, but `id === 'system'`, `vendor === 'claude'`, and its
`config` is always the vendor **default** (all-empty for claude — AC-R1). Always present, never
removable. Its `enabled` flag IS honoured, so the system agent can be disabled like any other
(AC-R10) — it then leaves the list consumers but still serves as a launch fallback. Its `icon`
field is honoured the same way — a custom icon on the system agent is preserved through normalize
(AC-R11), independently of AC-R1's config-default clearing.

## SystemSettings

The whole configuration, persisted at `~/.c3/settings.json`.

| Field               | Type                    | Description                                                                                                                                                                                                                                                                  |
| ------------------- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agents`            | `Agent[]`               | The registry; always includes the system agent (AC-R1)                                                                                                                                                                                                                       |
| `defaultAgentId`    | text                    | Id of an existing agent; falls back to system agent (AC-R2)                                                                                                                                                                                                                  |
| `defaultMode`       | `PermissionMode` (opt.) | Permission mode new sessions start in; one of the five `PermissionMode` values, falls back to `default` (AC-R8). Seeds a new session's mode in session-registry (SR-R6).                                                                                                     |
| `consensus`         | `{enabled}` (opt.)      | Multi-agent consensus voting on permission prompts; off by default. Consumed by the permission gateway — see [consensus.md](../../core/permission-gateway/consensus.md).                                                                                                     |
| `maxRoundsPerStage` | number (opt.)           | Per-stage round cap for multi-agent discussions; normalized to ≥ 8, default 12 (AC-R9). Consumed by the discussion engine.                                                                                                                                                   |
| `timezone`          | text (opt.)             | System-wide IANA time zone (e.g. `Asia/Shanghai`) used to interpret every schedule's cron fields; invalid/unset falls back to the server's local zone (`Intl…resolvedOptions().timeZone`). Consumed by the [schedules](../../core/schedules/design.md) engine — see SCH-R3a. |

## Session binding (state.json, `~/.c3`)

The per-session agent binding — a **two-key space** (ADR-0015, AC-R16/R17), distinct from the
session-registry's state.

| Field            | Type                                     | Description                                                                                                           |
| ---------------- | ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `version`        | `2`                                      | Schema version (v1 single-map blobs migrate on first read)                                                            |
| `pendingIntents` | map `pendingId → { agentId, createdAt }` | **Intent** — a not-yet-run session's desired agent; mutable, no vendor; reaped by the janitor after 7 days (AC-R17)   |
| `sessionAgents`  | map `realId → { agentId, vendor }`       | **Fact** — the agent a real session ran on + its frozen `vendor`; a missing entry ⇒ use the default agent (AC-R4/R16) |

### Session binding entities

| Entity         | Attribute   | Type       | Description                                                              |
| -------------- | ----------- | ---------- | ------------------------------------------------------------------------ |
| Pending intent | `agentId`   | text       | The agent the pending session wants to launch with                       |
| Pending intent | `createdAt` | number     | ms since epoch the intent was first recorded — drives janitor expiry     |
| Session fact   | `agentId`   | text       | The agent that actually ran (default fallback applied)                   |
| Session fact   | `vendor`    | `VendorId` | The **frozen** vendor; same-vendor agent swaps allowed, cross-vendor not |

Relationships: a pending intent transitions to **at most one** session fact at first bind (then it is
deleted); a fact's `vendor` is immutable for the session's life.
