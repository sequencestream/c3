# Group: settings

`settings` 组承载 c3 由用户管理的配置(非按会话簿记)。含四个域:**agent-config**(智能体档案)、**system-setting**(管理员级全局旋钮,含子进程代理)、**workspace-setting**(按工作区旋钮)、**personalized-setting**(按人偏好,无管理员门)。

作用域分三类且彼此正交:系统级(全局一份,含 agent-config)、工作区级(按工作区一份)、个人级(按人一份)。`personalized-setting` 是唯一不过管理员门的一类。

## Domains

| Domain                                                                    | 职责                                                                                                                                    | API                            | Status |
| ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ | ------ |
| [agent-config](agent-config/agent-config-overview.md)                     | 智能体档案(url/key/model + 名称)、默认智能体、按角色的 agent 路由、按会话绑定、降级链                                                   | WebSocket `/ws`(见共享协议)    | active |
| [system-setting](system-setting/system-setting-spec.md)                   | 管理员级全局旋钮:语音输入/时区/baseUrl、vendor CLI 生效版本、系统沙箱定义、子进程代理、鉴权、外部 MCP API key、监听地址、诊断、会话开关 | `SystemSettings`(见协议)       | active |
| [workspace-setting](workspace-setting/workspace-setting-spec.md)          | 按工作区旋钮:defaultMode、consensus、devSkill、讨论上限、Git 分支策略、沙箱引用、SDD、skillRepos、forge                                 | WebSocket `/ws`(见共享协议)    | active |
| [personalized-setting](personalized-setting/personalized-setting-spec.md) | 按人偏好:显示语言。已认证按账户存服务端,无身份存浏览器;首次登录以本地值播种                                                             | `PersonalizedSettings`(见协议) | active |

## 组级共享上下文

- 共用 [`shared/api-conventions/websocket-protocol.md`](../../shared/api-conventions/websocket-protocol.md) 的 wire 协议(`get_settings`、`save_settings`、`settings`、`load_workspace_setting`、`save_workspace_setting`、`workspace_setting`、`get_personalized_settings`、`save_personalized_settings`、`personalized_settings`)。
- 默认持久化到 `~/.c3/settings.json`。路径可为隔离启动(如 e2e)经 `c3 start --settings <path>` CLI 覆盖——它指定具体 settings.json 文件,其目录同时存 `state.json`,整体迁移配置目录而不动真实 `~/.c3`(`C3_DIR` 环境变量亦可迁移目录)。按工作区配置存于 `projectConfigs` 键(工作区路径 → workspace-setting 映射)。
- **所有写入走单一、并发安全的写路径**:进程内串行化 + 跨进程文件锁,写时磁盘重读并 merge-not-overwrite,故 `save_settings` 绝不抹掉按项目配置或按账户的个人化映射。见 [persistence](../../shared/data-conventions/persistence.md)。
- 按账户个人化偏好存于 `personalizedSettings` 顶层键(subject → 偏好),是 `SystemSettings` 的兄弟键而非字段,故不进系统设置快照。
- 外部 MCP 的长期 API key 存于 `mcpApiKeys` 顶层键,同样是 `SystemSettings` 的兄弟键而非字段。这不只是布局:整对象 `save_settings` 因此既不携带也无法注入/读出其哈希,进出只有专用的管理员操作。见 [system-setting](system-setting/system-setting-spec.md#外部-mcp-api-key-mcpapikeys)。
- 与 session-registry 的 `state.json`(`${CLAUDE_CONFIG_DIR:-~/.claude}/c3/state.json`)相互独立。

## 依赖方向

```
web-console ──(/ws)──► agent-config ──供给 env/model override──► agent-session ──► SDK run loop
                              │
                              ├──► workspace-setting ──供给 defaultMode/consensus/devSkill/rounds/speech──► agent-session
                              │
                              ├──► system-setting ──proxy 注入 HTTP_PROXY/HTTPS_PROXY──► launchForAgent(envOverrides)──► agent-session
                              │
                              └──► personalized-setting ──供给 agent 输出语言──► 提示词构造(意图/规格/自动化标题/讨论总结)
```
