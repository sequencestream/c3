# Group: system-config

The `system-config` group holds c3's user-managed configuration that is not per-session
bookkeeping. Today it has a single domain — **agent-config** — which lets the user define the
agents (Claude Code launch profiles) that sessions start with.

## Domains

| Domain                                                | Responsibility                                                                                 | API                                   | Status |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------- | ------ |
| [agent-config](agent-config/agent-config-overview.md) | Manage agent profiles (url/key/model + name), the default agent, and per-session agent binding | WebSocket `/ws` (see shared protocol) | active |

## Shared context

- Shares the wire protocol in
  [`shared/api-conventions/websocket-protocol.md`](../../shared/api-conventions/websocket-protocol.md)
  (`get_settings`, `save_settings`, `settings`).
- Persists to `~/.c3/` — separate from the session-registry's `state.json`
  (`${CLAUDE_CONFIG_DIR:-~/.claude}/c3/state.json`).

## Dependency direction

```
web-console ──(/ws)──► agent-config ──supplies env/model overrides──► agent-session ──► SDK query()
```

agent-config resolves a session's launch overrides (from its agent, or the default agent) and
feeds them to each run; it does not drive `query()` itself.
