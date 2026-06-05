# agent-config — Domain Spec

## Overview

The agent-config domain manages the **agents** sessions launch Claude Code with. An agent names
a set of Claude Code launch overrides (`baseUrl`, `apiKey`, `model`). One agent — the built-in
**system agent** — always exists with empty overrides; the user adds others and selects one as
the **default**. The configuration persists at `~/.c3/settings.json`; the per-session agent
binding persists at `~/.c3/state.json`.

**Scope:** the agent registry, the default-agent selection, the per-session agent binding, and
resolving a session's launch overrides for each run.
**Boundary:** it does not drive `query()` (agent-session) and does not own permission state.

## Core entities

| Entity         | Description                                                                                                |
| -------------- | ---------------------------------------------------------------------------------------------------------- |
| Agent          | A launch profile: `id`, `name`, `baseUrl`, `apiKey`, `model`, `enabled`, `icon`                            |
| System Agent   | The built-in agent (`id === 'system'`): empty overrides, undeletable, always present (but may be disabled) |
| SystemSettings | The whole configuration: `agents[]` + `defaultAgentId` + `defaultMode`                                     |
| Session bind   | A `sessionId → agentId` entry; absent ⇒ the session uses the default agent                                 |

See [models.md](models.md).

## Business rules

| ID     | Rule                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AC-R1  | The system agent (`id === SYSTEM_AGENT_ID`) always exists, has empty `baseUrl`/`apiKey`/`model`, and cannot be removed. Edits to its Claude config are ignored.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| AC-R2  | `defaultAgentId` must reference an existing agent. On save, an unknown/empty default falls back to the system agent.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| AC-R3  | `save_settings` is normalized server-side: the system agent is re-injected, agents without an id get a fresh uuid, duplicate ids and a duplicate system entry are dropped. The normalized result is echoed as `settings`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| AC-R4  | A session launches Claude Code with its bound agent's overrides; if unbound, with the **default** agent's. Empty fields produce no override (system agent ⇒ no overrides).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| AC-R5  | A non-empty `baseUrl` sets `ANTHROPIC_BASE_URL`; a non-empty `apiKey` sets both `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN`; a non-empty `model` sets the SDK `model`. All overrides merge over `process.env`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| AC-R6  | New (pending) sessions are unbound, so they launch with the default agent (AC-R4).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| AC-R7  | The configuration persists at `~/.c3/settings.json`; the per-session binding at `~/.c3/state.json`. Both are written atomically and fail soft to defaults so c3 still boots.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| AC-R8  | `defaultMode` is the permission mode new sessions start in. On save it must be one of the five `PermissionMode` values; an unknown/absent value falls back to `default`. It seeds a new session's mode (SR-R6); per-session mode changes thereafter (SR-R5) do not alter it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| AC-R9  | `maxRoundsPerStage` is the per-stage round cap for multi-agent discussions. On save it is normalized: a finite value ≥ 8 is floored and kept; a positive value below 8 is clamped up to 8; anything else (missing, non-finite, ≤ 0) falls back to the default 12. The discussion engine reads it via `getMaxRoundsPerStage()`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| AC-R10 | Each agent has an optional `enabled` flag. On normalize it persists as an explicit boolean; **absent/`true` ⇒ enabled** (back-compat: old configs without the field count as enabled), only an explicit `false` disables. The system agent's `enabled` is honoured too (its overrides stay ignored — AC-R1). Every **list-of-agents consumer** takes only enabled agents: discussion participants, consensus voters, the degradation chain (`normalizeDegradationChain` drops disabled ids), and the default-agent picker (a disabled agent cannot be picked as default). A disabled agent is removed from these pools the moment it is disabled and restored when re-enabled. **Launch fallback is unaffected:** `resolveSessionLaunch`/`resolveAgent` never filter on `enabled`, so a session bound to a disabled agent — or whose default/system fallback is disabled — still launches (a session is never locked out). |
| AC-R11 | Each agent has an optional `icon` field (an emoji or short text) used for display identity in multi-speaker contexts. On normalize the value is **trimmed, empty-after-trim ⇒ `''`, and capped to 16 chars**; anything non-string falls back to `''` (no custom icon). **Back-compat:** old configs without `icon` load as `''` without error. The system agent's `icon` is honoured the same way (its Claude overrides stay ignored — AC-R1). `icon` does NOT affect any launch/list behavior: it is a display-only field, so list-of-agents consumers (participants, voters, chain, picker) and launch fallback behave exactly as without it.                                                                                                                                                                                                                                                                            |

## User scenarios

- **First boot:** Given no config file, When the user opens settings, Then exactly one agent —
  the system agent — is shown and is the default.
- **Add an agent:** Given the settings view, When the user adds an agent with a name/url/key/model and
  saves, Then it is persisted with a stable id and may be chosen as default.
- **Default agent drives new sessions:** Given a non-system default agent, When the user starts
  a new session and sends a prompt, Then Claude Code launches with that agent's url/key/model
  (AC-R4).
- **Default mode seeds new sessions:** Given a configured `defaultMode` (e.g. `plan`), When the
  user starts a new session, Then it opens in that mode (AC-R8, SR-R6); switching its mode later
  leaves `defaultMode` unchanged.
- **Disable an agent:** Given several agents, When the user toggles one off and saves, Then it
  disappears from the discussion participant pool, the consensus voter pool, the degradation
  chain, and the default-agent picker; re-enabling it restores it everywhere (AC-R10).
- **Disable the system agent:** Given the system agent enabled, When the user disables it, Then it
  too drops out of the pools/picker above — yet `resolveSessionLaunch` can still fall back to it,
  so any session whose chain bottoms out at the system agent still launches (AC-R10).
- **Disabled agent never locks a session (anti-scenario):** Given a session bound to an agent that
  is later disabled, When the session runs, Then it must **never** be blocked from launching — the
  bound/default/system fallback still applies (AC-R10).
- **System agent (anti-scenario):** The system agent must **never** be deletable and its Claude
  config must **never** carry overrides (AC-R1). (It may, however, be disabled — AC-R10.)
- **Dangling default (anti-scenario):** Removing the agent that was the default must **never**
  leave `defaultAgentId` dangling — it falls back to the system agent (AC-R2).
- **Pick an icon:** Given the settings view, When the user opens an agent row's emoji picker and
  clicks an emoji, Then it is written into that agent's `icon` text field and saved like any manual
  edit; the manual text input still accepts free entry. The picker is a **display-only input
  affordance** in the web console — it writes back to the same `icon` field and changes no
  persistence or normalization (AC-R11 still governs trim / empty / 16-char cap).

## Domain events (wire)

Consumes `get_settings`, `save_settings`. Emits `settings`. See the
[shared protocol](../../../shared/api-conventions/websocket-protocol.md).

## Interactions

- **agent-session** — receives the resolved `envOverrides` / `model` for each run via
  `resolveSessionLaunch(sessionId)`.
- **session-registry** — supplies the active `sessionId` that the binding is keyed on (the
  binding itself lives in agent-config's own `~/.c3/state.json`, not the registry's state).
- **web-console** — renders the full-page settings view and sends `get_settings` / `save_settings`.
- **discussion** — reads `maxRoundsPerStage` via `getMaxRoundsPerStage()` as the per-stage round
  cap for the orchestration loop (AC-R9).

## Data dictionary

- **Agent** — a Claude Code launch profile keyed by `id`.
- **Default agent** — the agent unbound sessions launch with.
- **settings.json** — the agent registry at `~/.c3/settings.json`.
- **state.json (`~/.c3`)** — the `sessionId → agentId` binding; distinct from the
  session-registry's `~/.claude/c3/state.json`.
