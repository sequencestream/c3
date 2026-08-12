# Group: settings

`settings` 组承载 c3 由用户管理的配置(非按会话簿记)。含四个域:**agent-config**(智能体档案)、**system-setting**(管理员级全局旋钮,含子进程代理)、**workspace-setting**(按工作区旋钮)、**personalized-setting**(按人偏好,无管理员门)。

作用域分三类且彼此正交:系统级(全局一份,含 agent-config)、工作区级(按工作区一份)、个人级(按人一份)。`personalized-setting` 是唯一不过管理员门的一类。

## Domains

- [agent-config](agent-config/agent-config-overview.md) — active
  - 职责: 智能体档案(url/key/model + 名称)、默认智能体、按角色的 agent 路由、按会话绑定、降级链
  - API: WebSocket `/ws`(见共享协议)
- [system-setting](system-setting/system-setting-spec.md) — active
  - 职责: 管理员级全局旋钮:语音输入/时区/baseUrl、vendor CLI 生效版本、系统沙箱定义、子进程代理、鉴权、外部 MCP API key、监听地址、诊断、会话开关
  - API: `SystemSettings`(见协议)
- [workspace-setting](workspace-setting/workspace-setting-spec.md) — active
  - 职责: 按工作区旋钮:defaultMode、consensus、devSkill、讨论上限、Git 分支策略、沙箱引用、SDD、skillRepos、forge
  - API: WebSocket `/ws`(见共享协议)
- [personalized-setting](personalized-setting/personalized-setting-spec.md) — active
  - 职责: 按人偏好:显示语言。已认证按账户存服务端,无身份存浏览器;首次登录以本地值播种
  - API: `PersonalizedSettings`(见协议)

## 组级共享上下文

- 共用 [`shared/api-conventions/websocket-protocol.md`](../../shared/api-conventions/websocket-protocol.md) 的 wire 协议(`get_settings`、`save_settings`、`settings`、`load_workspace_setting`、`save_workspace_setting`、`workspace_setting`、`get_personalized_settings`、`save_personalized_settings`、`personalized_settings`)。
- 持久化到 `c3.db` 的配置表,一字段一行。隔离启动(如 e2e)用 `c3 start --db <path>` 指定数据库——它同时决定 c3 主目录,整体迁移实例而不动真实 `~/.c3`。
- 每类设置有自己的作用域表(系统 / 每工作区 / 每账号 / 每会话 / MCP 密钥),一次写入只触及一个作用域,故 `save_settings` 在存储层就不可能抹掉工作区配置、个人化偏好或 MCP 密钥。见 [persistence](../../shared/data-conventions/persistence.md)。
- 每工作区配置按 `workspaces.id` 分组;协议上仍以 `projectConfigs`(工作区路径 → workspace-setting 映射)呈现。
- 外部 MCP 的长期 API key 独立成表,整对象 `save_settings` 既不携带也无法注入/读出其哈希,进出只有专用的管理员操作。见 [system-setting](system-setting/system-setting-spec.md#外部-mcp-api-key-mcpapikeys)。
- 工作区注册表(id ↔ 路径)与会话绑定同在此库,见 [session-registry](../core/session-registry/session-registry-spec.md)。

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
