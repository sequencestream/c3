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
  (`get_settings`, `save_settings`, `settings`, `load_workspace_setting`, `save_workspace_setting`,
  `workspace_setting`).
- Persists to `~/.c3/settings.json` by default. The path is overridable for isolated launches
  (e.g. e2e) via the `c3 start --settings <path>` CLI flag — it names the exact settings.json file
  and its directory also holds `state.json`, relocating the whole config dir without touching the
  real `~/.c3`. (The `C3_DIR` env var, already honored by the db layer, likewise relocates the dir.)
  Stored under the `projectConfigs` key (a per-workspace-path → workspace-setting map). **All writes
  go through the single, concurrency-safe write path:** in-process serialization + a cross-process
  file lock, with write-time disk re-read and merge-not-overwrite so `save_settings` never wipes
  per-project config. See [persistence.md](persistence.md) (唯一写入路径 + 双层锁，2026-06-08-003).
- Separate from the session-registry's `state.json` (`${CLAUDE_CONFIG_DIR:-~/.claude}/c3/state.json`).
- **Migration (2026-06-07-017):** `defaultMode` is now a per-vendor map (vendor id → mode token)
  instead of a single mode token. The old single-string format is detected during workspace-setting
  normalization and automatically distributed to each vendor key (the value is used as-is for every
  vendor; each vendor's catalog validation happens at the per-vendor save handler). The read-layer
  one-shot migration of legacy global `defaultMode`/`consensus`/`devSkill`/`maxRoundsPerStage`/`maxSpeechChars`
  into per-project config is unchanged.

## Dependency direction

```
web-console ──(/ws)──► agent-config ──supplies env/model overrides──► agent-session ──► SDK run loop
                              │
                              └──► project-config ──supplies defaultMode/consensus/devSkill/rounds/speech──► agent-session
```
