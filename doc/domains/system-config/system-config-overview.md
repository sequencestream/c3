# Group: system-config

The `system-config` group holds c3's user-managed configuration that is not per-session
bookkeeping. Today it has two domains — **agent-config** (agent profiles) and
**project-config** (per-workspace configuration knobs).

## Domains

| Domain                                                | Responsibility                                                                                                                                                                   | API                                   | Status |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- | ------ |
| [agent-config](agent-config/agent-config-overview.md) | Manage agent profiles (url/key/model + name), the default agent, and per-session agent binding                                                                                   | WebSocket `/ws` (see shared protocol) | active |
| project-config                                        | Per-workspace config knobs (defaultMode, consensus, devSkill, maxRoundsPerStage, maxSpeechChars, gitBranchMode, sandbox, sddEnabled). SDD 规格目录是固定/只读的集中位置,非配置项 | WebSocket `/ws` (see shared protocol) | active |

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
  per-project config. See [persistence](../../shared/data-conventions/persistence.md) (唯一写入路径 + 双层锁，2026-06-08-003).
- Separate from the session-registry's `state.json` (`${CLAUDE_CONFIG_DIR:-~/.claude}/c3/state.json`).
- **Migration (2026-06-07-017):** `defaultMode` is now a per-vendor map (vendor id → mode token)
  instead of a single mode token. The old single-string format is detected during workspace-setting
  normalization and automatically distributed to each vendor key (the value is used as-is for every
  vendor; each vendor's catalog validation happens at the per-vendor save handler). The read-layer
  one-shot migration of legacy global `defaultMode`/`consensus`/`devSkill`/`maxRoundsPerStage`/`maxSpeechChars`
  into per-project config is unchanged.

## Workspace-setting fields (SDD)

- **`sddEnabled`** — master switch for spec-driven development (SDD) in the workspace.
  Off by default. When on, the SDD spec quality gate and human approval checkpoints
  apply to development tasks before coding starts. Only an explicit boolean `true`
  enables it; absent / non-boolean values normalize to `false`.
- **Spec 目录（只读、集中、固定）** — SDD 规格文档的根目录**不再是可配置项**。它被
  **固定**为按项目隔离的集中位置 `<c3 home>/doc/<项目路径段>`(命名范式与 worktree
  集中目录同源），由服务端从**归属工作区路径**确定性解析,因此同一项目的所有 worktree
  共享同一份规格集合。工作区配置**仅只读展示**该解析后的目录(随工作区设置回复一并下发),
  界面与协议都**无法修改**它:任何客户端提交的规格目录入参都会被忽略,不写入、不改变解析
  结果(沿「服务端为准」治理)。规格文档**不提交到 Git**,依赖本机 `<c3 home>`。
  > 边界:不迁移、不读取、不识别历史的工作区内 `.doc` 规格文档(集中目录仅承载启用后的
  > 新规格)。

`sddEnabled` 存储在每工作区的 `projectConfigs` 映射中,由 `normalizeWorkspaceSetting`
回填默认值;不存在持久化的规格目录字段。

## Dependency direction

```
web-console ──(/ws)──► agent-config ──supplies env/model overrides──► agent-session ──► SDK run loop
                              │
                              └──► project-config ──supplies defaultMode/consensus/devSkill/rounds/speech──► agent-session
```
