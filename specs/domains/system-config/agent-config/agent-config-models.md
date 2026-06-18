# agent-config — Models

Entity definitions. Business-semantic field contracts; physical wiring in [agent-config-design.md](agent-config-design.md).
The wire shapes are defined once in the
[shared protocol](../../../shared/api-conventions/websocket-protocol.md).

## Agent

A launch profile: a vendor-agnostic **public shell** plus a `vendor`-discriminated `config`
sub-object (AC-R12). The agent config is a discriminated union keyed on `vendor`; the runtime schema
that validates + routes it is pinned to the wire shape by a compile-time assertion.

### Public shell

| Attribute     | Type       | Description                                                                                                                                                                                                                 |
| ------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`          | text       | Stable id; `'system'` for the built-in agent                                                                                                                                                                                |
| `displayName` | text       | Display name (was `name` before the vendor refactor)                                                                                                                                                                        |
| `enabled`     | bool (opt) | Enabled flag; absent/`true` ⇒ enabled, only explicit `false` disables. Disabled agents drop out of every list consumer (participants, voters, degradation chain, default picker) but remain valid launch fallbacks (AC-R10) |
| `icon`        | text (opt) | Optional display icon (emoji / short text). Empty/absent ⇒ no custom icon. Trimmed and capped to 16 chars; not validated as a real emoji. Old configs without the field load as `''` (AC-R11)                               |

### Claude config sub-object (`vendor === 'claude'`)

| Attribute | Type       | Description                                                |
| --------- | ---------- | ---------------------------------------------------------- |
| `baseUrl` | text (url) | `ANTHROPIC_BASE_URL` override; empty ⇒ no override (AC-R5) |
| `apiKey`  | text       | API key / auth token override; empty ⇒ no override (AC-R5) |
| `model`   | text       | Model alias or id; empty ⇒ no override (AC-R5)             |

### Codex config sub-object (`vendor === 'codex'`)

The neutral provider triple plus `wireApi`. Codex's launch-time policy gate
(`sandboxMode`/`approvalPolicy`) is NOT persisted here — it is derived at launch from the
session `defaultMode` via the neutral grid (2026-06-06-008).

| Attribute | Type                    | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| --------- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `baseUrl` | text (url)              | OpenAI-compatible base URL override (custom mode only); empty ⇒ no override                                                                                                                                                                                                                                                                                                                                                                                                            |
| `apiKey`  | text                    | API key / auth token override; empty ⇒ no override                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `model`   | text                    | Model alias or id; empty ⇒ no override                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `wireApi` | `'responses' \| 'chat'` | The custom provider's wire protocol — codex's own wire-api term (2026-06-12-006). `'responses'` ⇒ provider serves Responses natively ⇒ codex connects **DIRECT**; `'chat'` ⇒ Chat-Completions-only ⇒ codex routes through c3's in-process Responses→Chat **relay** (ADR-0014). Legacy records without the field migrate to `'chat'` (preserves the prior third-party-via-relay behaviour). Irrelevant to `system`-mode codex. See [codex-relay](../../../architecture/codex-relay.md). |

Relationships: zero or more Sessions bind to an Agent; an unbound session uses the default.

## System Agent

The built-in agent. Same shell as Agent, but its id is `'system'`, vendor is `'claude'`, and its
config is always the vendor **default** (all-empty for claude — AC-R1). Always present, never
removable. Its enabled flag IS honoured, so the system agent can be disabled like any other
(AC-R10) — it then leaves the list consumers but still serves as a launch fallback. Its icon
field is honoured the same way — a custom icon on the system agent is preserved through normalization
(AC-R11), independently of AC-R1's config-default clearing.

## System settings

The whole configuration, persisted at `~/.c3/settings.json`.

| Field               | Type                   | Description                                                                                                                                                                                                                                                              |
| ------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `agents`            | agent list             | The registry; always includes the system agent (AC-R1)                                                                                                                                                                                                                   |
| `defaultAgentId`    | text                   | Id of an existing agent; falls back to system agent (AC-R2)                                                                                                                                                                                                              |
| `toolAgentId`       | text                   | Id of the agent that runs background tool sessions (completion judge, name derivation; exception-handling not yet agent-driven). Empty string ⇒ "follow the default agent" (kept empty on store); a set value falls through by order sequence like the default (AC-R21). |
| `intentAgentId`     | text                   | Id of the agent that runs intent-communication sessions (the intent analyst's requirement-breakdown conversation). Empty string ⇒ "follow the default agent" (kept empty on store); a set value falls through by order sequence like the default (AC-R23).               |
| `specAgentId`       | text                   | Id of the agent that runs spec-authoring sessions (writing/refining the project specification). Empty string ⇒ "follow the default agent" (kept empty on store); a set value falls through by order sequence like the default (AC-R24).                                  |
| `defaultMode`       | permission mode (opt.) | Permission mode new sessions start in; one of the five permission-mode values, falls back to `default` (AC-R8). Seeds a new session's mode in session-registry (SR-R6).                                                                                                  |
| `consensus`         | `{ enabled }` (opt.)   | Multi-agent consensus voting on permission prompts; off by default. Consumed by the permission gateway — see [consensus](../../core/permission-gateway/features/permission-gateway-consensus.md).                                                                        |
| `maxRoundsPerStage` | number (opt.)          | Per-stage round cap for multi-agent discussions; normalized to ≥ 8, default 12 (AC-R9). Consumed by the discussion engine.                                                                                                                                               |
| `timezone`          | text (opt.)            | System-wide IANA time zone (e.g. `Asia/Shanghai`) used to interpret every schedule's cron fields; invalid/unset falls back to the server's local zone. Consumed by the [schedules](../../core/schedules/schedules-design.md) engine — see SCH-R3a.                       |

## Session binding (state.json, `~/.c3`)

The per-session agent binding — a **two-key space** (ADR-0015, AC-R16/R17), distinct from the
session-registry's state.

| Field            | Type                                     | Description                                                                                                           |
| ---------------- | ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `version`        | `2`                                      | Schema version (v1 single-map blobs migrate on first read)                                                            |
| `pendingIntents` | map `pendingId → { agentId, createdAt }` | **Intent** — a not-yet-run session's desired agent; mutable, no vendor; reaped by the janitor after 7 days (AC-R17)   |
| `sessionAgents`  | map `realId → { agentId, vendor }`       | **Fact** — the agent a real session ran on + its frozen `vendor`; a missing entry ⇒ use the default agent (AC-R4/R16) |

### Session binding entities

| Entity         | Attribute   | Type      | Description                                                              |
| -------------- | ----------- | --------- | ------------------------------------------------------------------------ |
| Pending intent | `agentId`   | text      | The agent the pending session wants to launch with                       |
| Pending intent | `createdAt` | number    | ms since epoch the intent was first recorded — drives janitor expiry     |
| Session fact   | `agentId`   | text      | The agent that actually ran (default fallback applied)                   |
| Session fact   | `vendor`    | vendor id | The **frozen** vendor; same-vendor agent swaps allowed, cross-vendor not |

Relationships: a pending intent transitions to **at most one** session fact at first bind (then it is
deleted); a fact's `vendor` is immutable for the session's life.
