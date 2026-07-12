# Group: settings

The `settings` group holds c3's user-managed configuration that is not per-session
bookkeeping. It has three domains — **agent-config** (agent profiles),
**system-setting** (admin-only global knobs, incl. session subprocess proxy), and
**workspace-setting** (per-workspace configuration knobs).

## Domains

| Domain                                                | Responsibility                                                                                                                                                                               | API                                   | Status |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- | ------ |
| [agent-config](agent-config/agent-config-overview.md) | Manage agent profiles (url/key/model + name), the default agent, per-role agent routing, and per-session agent binding                                                                       | WebSocket `/ws` (see shared protocol) | active |
| system-setting                                        | Admin-only global knobs: display/timezone/baseUrl, vendor CLI effective version, system sandbox defs, session subprocess proxy, auth, host diagnostics                                       | `SystemSettings` (see protocol)       | active |
| workspace-setting                                     | Per-workspace config knobs (defaultMode, consensus, devSkill, maxRoundsPerStage, maxSpeechChars, gitBranchMode, sandbox, sddEnabled, skillRepos). SDD 规范目录是固定/只读的集中位置,非配置项 | WebSocket `/ws` (see shared protocol) | active |

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
- `vendorCliVersions.claude` / `vendorCliVersions.codex` select the runtime
  **effective** managed version — they are NOT download pins. Empty or absent
  means automatic latest-compatible: the sync flow always tracks the newest
  compatible npm release under `~/.c3/vendor/<vendor>/<version>/bin/<binary>`,
  regardless of this field, so historical versions can be selected as active
  without freezing upgrades. A non-empty value must point to a server-reported
  installed version; an uninstalled/incompatible value degrades to the latest
  compatible managed version, records a visible `lastError`, and is not silently
  cleared. The system-settings panel renders the installed version list as a
  single-select. Explicit env overrides still win; host PATH is only a degraded
  fallback after managed resolution or sync fails.
- **Migration (2026-06-07-017):** `defaultMode` is now a per-vendor map (vendor id → mode token)
  instead of a single mode token. The old single-string format is detected during workspace-setting
  normalization and automatically distributed to each vendor key (the value is used as-is for every
  vendor; each vendor's catalog validation happens at the per-vendor save handler). The read-layer
  one-shot migration of legacy global `defaultMode`/`consensus`/`devSkill`/`maxRoundsPerStage`/`maxSpeechChars`
  into per-project config is unchanged.

## Session subprocess proxy

The `SystemSettings.proxy` block (see `shared/src/protocol.ts`) controls whether new session
subprocesses receive `HTTP_PROXY`/`http_proxy`/`HTTPS_PROXY`/`https_proxy` environment variables:

- **`proxy.enabled`** — master switch (strict bool, only `true` is enabled). When disabled,
  no proxy env vars are injected regardless of saved URLs.
- **`proxy.httpProxy`** — HTTP proxy URL (e.g. `http://proxy.local:3128`). When enabled and
  non-empty, both `HTTP_PROXY` and `http_proxy` are injected into every new session subprocess.
- **`proxy.httpsProxy`** — HTTPS proxy URL. When enabled and non-empty, both `HTTPS_PROXY` and
  `https_proxy` are injected.

Key design points:

- Only the four environment variables above are supported — no `NO_PROXY`, `ALL_PROXY`, SOCKS, PAC.
- The configuration only affects **newly launched** session subprocesses (`claude` / `codex`).
  Already-running sessions are not retroactively updated.
- The server process's own outbound requests do NOT use these settings.
- Proxy URL values are retained when `enabled` is toggled off, allowing quick on/off without
  re-entering.
- Proxy authentication can be embedded in the URL (e.g. `http://user:pass@host:port`), but there
  is no dedicated auth UI form. The URL is stored in plaintext (it does not use the `c3secretv1:`
  encryption path — an intentional trade-off).
- The injection happens in `launchForAgent()` via `envOverrides`, affecting all entry points:
  main runs, tool sessions, intent comm, spec authoring, discussion, automation execution, and
  advisor sessions.
- The `buildChildEnv` merge order (keepalive < process.env < envOverrides) is unchanged: proxy
  env vars land in `envOverrides`, so they take precedence over the user's shell but can still
  be overridden by an explicit `HTTP_PROXY`/`HTTPS_PROXY` in the shell environment.

## Public-facing base URL

`SystemSettings.baseUrl`（见 `shared/src/protocol.ts`）是此 c3 部署的对外基地址，用于拼接可分享的链接（如分享按钮生成的 URL）。典型值如 `http://192.168.10.10:9000`。

- **可选字段**：`baseUrl?: string`。空值或缺失均视为「未配置」，消费者应回退到默认行为。
- **规范化**：保存时自动 trim 首尾空白，并去除尾部斜杠（`http://host:3000/` → `http://host:3000`，`http://host:3000///` → `http://host:3000`）。纯空白输入视为空值，不落库。
- **存储**：明文存储于 `~/.c3/settings.json` 顶层（非敏感信息，不走 `c3secretv1:` 加密路径）。
- **作用域**：系统级（非按工作区），不与 `WorkspaceSetting` / `projectConfigs` 交互。
- **不做格式校验**：不解析 URL、不校验协议/主机合法性、不探测可达性。允许用户填入任意字符串，由后续消费方决定容错。

## Workspace-setting fields (SDD)

- **`sddEnabled`** — master switch for spec-driven development (SDD) in the workspace.
  Off by default. When on, the SDD spec quality gate and human approval checkpoints
  apply to development tasks before coding starts. Only an explicit boolean `true`
  enables it; absent / non-boolean values normalize to `false`.
- **Spec 目录（只读、集中、固定）** — SDD 规范文档的根目录**不再是可配置项**。它被
  **固定**为按项目隔离的集中位置 `<c3 home>/doc/<项目路径段>`(命名范式与 worktree
  集中目录同源），由服务端从**归属工作区路径**确定性解析,因此同一项目的所有 worktree
  共享同一份规范集合。工作区配置**仅只读展示**该解析后的目录(随工作区设置回复一并下发),
  界面与协议都**无法修改**它:任何客户端提交的规范目录入参都会被忽略,不写入、不改变解析
  结果(沿「服务端为准」治理)。规范文档**不提交到 Git**,依赖本机 `<c3 home>`。
  > 边界:不迁移、不读取、不识别历史的工作区内 `.doc` 规范文档(集中目录仅承载启用后的
  > 新规范)。

`sddEnabled` 存储在每工作区的 `projectConfigs` 映射中,由 `normalizeWorkspaceSetting`
回填默认值;不存在持久化的规范目录字段。

## Dependency direction

```
web-console ──(/ws)──► agent-config ──supplies env/model overrides──► agent-session ──► SDK run loop
                              │
                              ├──► project-config ──supplies defaultMode/consensus/devSkill/rounds/speech──► agent-session
                              │
                              └──► proxy ──injects HTTP_PROXY/HTTPS_PROXY──► launchForAgent (envOverrides) ──► agent-session
```
