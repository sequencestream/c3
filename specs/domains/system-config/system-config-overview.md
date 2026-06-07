# Group: system-config

The `system-config` group holds c3's user-managed configuration that is not per-session
bookkeeping. Today it has two domains — **agent-config** (agent profiles) and
**project-config** (per-workspace configuration knobs).

## Domains

| Domain                                                | Responsibility                                                                                   | API                                   | Status |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------- | ------ |
| [agent-config](agent-config/agent-config-overview.md) | Manage agent profiles (url/key/model + name), the default agent, and per-session agent binding   | WebSocket `/ws` (see shared protocol) | active |
| project-config                                        | Per-workspace config knobs (defaultMode, consensus, devSkill, maxRoundsPerStage, maxSpeechChars) | WebSocket `/ws` (see shared protocol) | active |

## Shared context

- Shares the wire protocol in
  [`shared/api-conventions/websocket-protocol.md`](../../shared/api-conventions/websocket-protocol.md)
  (`get_settings`, `save_settings`, `settings`, `load_project_config`, `save_project_config`,
  `project_config`).
- Persists to `~/.c3/settings.json` — stored as `SystemSettings.projectConfigs` (a
  `Record<projectPath, ProjectConfig>`), written atomically alongside the main settings.
- Separate from the session-registry's `state.json` (`${CLAUDE_CONFIG_DIR:-~/.claude}/c3/state.json`).
- **Migration (2026-06-07-017):** `defaultMode` is now a `Record<VendorId, ModeToken>` instead of a
  single `ModeToken`. The old single-string format is detected by `normalizeProjectConfig` and
  automatically distributed to each vendor key (the value is used as-is for every vendor; each
  vendor's catalog validation happens at the per-vendor save handler). The read-layer one-shot
  migration of legacy global `defaultMode`/`consensus`/`devSkill`/`maxRoundsPerStage`/`maxSpeechChars`
  into per-project config is unchanged.

## Dependency direction

```
web-console ──(/ws)──► agent-config ──supplies env/model overrides──► agent-session ──► SDK query()
                              │
                              └──► project-config ──supplies defaultMode/consensus/devSkill/rounds/speech──► agent-session
```
