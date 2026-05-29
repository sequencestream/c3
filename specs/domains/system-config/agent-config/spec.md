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

| Entity         | Description                                                                          |
| -------------- | ------------------------------------------------------------------------------------ |
| Agent          | A launch profile: `id`, `name`, `baseUrl`, `apiKey`, `model`                         |
| System Agent   | The built-in agent (`id === 'system'`): empty overrides, undeletable, always present |
| SystemSettings | The whole configuration: `agents[]` + `defaultAgentId`                               |
| Session bind   | A `sessionId → agentId` entry; absent ⇒ the session uses the default agent           |

See [models.md](models.md).

## Business rules

| ID    | Rule                                                                                                                                                                                                                      |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AC-R1 | The system agent (`id === SYSTEM_AGENT_ID`) always exists, has empty `baseUrl`/`apiKey`/`model`, and cannot be removed. Edits to its Claude config are ignored.                                                           |
| AC-R2 | `defaultAgentId` must reference an existing agent. On save, an unknown/empty default falls back to the system agent.                                                                                                      |
| AC-R3 | `save_settings` is normalized server-side: the system agent is re-injected, agents without an id get a fresh uuid, duplicate ids and a duplicate system entry are dropped. The normalized result is echoed as `settings`. |
| AC-R4 | A session launches Claude Code with its bound agent's overrides; if unbound, with the **default** agent's. Empty fields produce no override (system agent ⇒ no overrides).                                                |
| AC-R5 | A non-empty `baseUrl` sets `ANTHROPIC_BASE_URL`; a non-empty `apiKey` sets both `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN`; a non-empty `model` sets the SDK `model`. All overrides merge over `process.env`.         |
| AC-R6 | New (pending) sessions are unbound, so they launch with the default agent (AC-R4).                                                                                                                                        |
| AC-R7 | The configuration persists at `~/.c3/settings.json`; the per-session binding at `~/.c3/state.json`. Both are written atomically and fail soft to defaults so c3 still boots.                                              |

## User scenarios

- **First boot:** Given no config file, When the user opens settings, Then exactly one agent —
  the system agent — is shown and is the default.
- **Add an agent:** Given the settings view, When the user adds an agent with a name/url/key/model and
  saves, Then it is persisted with a stable id and may be chosen as default.
- **Default agent drives new sessions:** Given a non-system default agent, When the user starts
  a new session and sends a prompt, Then Claude Code launches with that agent's url/key/model
  (AC-R4).
- **System agent (anti-scenario):** The system agent must **never** be deletable and its Claude
  config must **never** carry overrides (AC-R1).
- **Dangling default (anti-scenario):** Removing the agent that was the default must **never**
  leave `defaultAgentId` dangling — it falls back to the system agent (AC-R2).

## Domain events (wire)

Consumes `get_settings`, `save_settings`. Emits `settings`. See the
[shared protocol](../../../shared/api-conventions/websocket-protocol.md).

## Interactions

- **agent-session** — receives the resolved `envOverrides` / `model` for each run via
  `resolveSessionLaunch(sessionId)`.
- **session-registry** — supplies the active `sessionId` that the binding is keyed on (the
  binding itself lives in agent-config's own `~/.c3/state.json`, not the registry's state).
- **web-console** — renders the full-page settings view and sends `get_settings` / `save_settings`.

## Data dictionary

- **Agent** — a Claude Code launch profile keyed by `id`.
- **Default agent** — the agent unbound sessions launch with.
- **settings.json** — the agent registry at `~/.c3/settings.json`.
- **state.json (`~/.c3`)** — the `sessionId → agentId` binding; distinct from the
  session-registry's `~/.claude/c3/state.json`.
