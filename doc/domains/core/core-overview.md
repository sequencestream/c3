# Group: core

`core` group 承载 c3 的限界上下文(bounded context)。它们共同实现完整的循环:
用户选择一个工作区/会话,浏览器传入一条 prompt,智能体运行,
敏感工具调用通过浏览器被拦截确认,活动流回传——
再加上意图台账、讨论编排、交付集成、自动化调度、工作区记忆与 IM 机器人等配套能力。

## Domains

- [permission-gateway](permission-gateway/permission-gateway-overview.md) — active
  - 职责: 拦截 SDK 权限请求,路由到浏览器,阻塞直到用户决策(中止时拒绝)
  - API: 内部(无对外公开 HTTP API)
- [agent-session](agent-session/agent-session-overview.md) — active
  - 职责: 驱动 SDK 的 `query()` 循环,把 SDK 消息映射到线协议,管理模式与生命周期
  - API: WebSocket `/ws`(见 shared protocol)
- [session-registry](session-registry/session-registry-overview.md) — active
  - 职责: 管理工作区与会话;拥有每会话模式、最近访问顺序、历史回放
  - API: WebSocket `/ws`(见 shared protocol)
- [files](files/files-overview.md) — active
  - 职责: 只读工作区文件浏览:仅根植于已注册的工作区 id,在其根目录下列目录、读文本文件、做有界搜索
  - API: WebSocket `/ws`(见 shared protocol)
- [web-console](web-console/web-console-overview.md) — active
  - 职责: 浏览器 UI:侧边栏、prompt 输入、活动流、权限对话框、模式切换
  - API: 消费 `/ws`
- [intent-management](intent-management/intent-management-overview.md) — active
  - 职责: 项目级意图台账(SQLite);只读意图沟通智能体;`save_intents` 对话确认后落库;启动可配置的开发技能;工作区自动化队列
  - API: WebSocket `/ws`(见 shared protocol)
- [discussion](discussion/discussion-overview.md) — active
  - 职责: 工作区级讨论账本 + 组织者引擎编排多智能体轮流发言 + human-in-the-loop(暂停/恢复/发言/停止) + 转意图
  - API: WebSocket `/ws`(见 shared protocol)
- [delivery](delivery/delivery-overview.md) — active
  - 职责: 交付作为集成单元:账本 + 受控状态机 + 交付分支 + 意图关联 + 交付 PR + 集成就熟 N/M
  - API: WebSocket `/ws`(见 shared protocol)
- [automations](automations/automations-overview.md) — active
  - 职责: 按 cron / 事件触发的 command 与 LLM 任务;执行日志;工作区自动化总闸
  - API: WebSocket `/ws`(见 shared protocol)
- [session-cleanup](session-cleanup/session-cleanup-design.md) — active
  - 职责: 按保留期删除各 vendor 会话存储中过期的会话记录(系统级开关,vendor 中立,每日执行)
  - API: 内部(无对外公开 HTTP API)
- [self-update](self-update/self-update-design.md) — active
  - 职责: 后台下载并校验最新发行包到暂存区,由管理员在控制台一键重启生效;按运行形态选择重启方式,不可自更新的形态明确让位
  - API: WebSocket `/ws`(见 shared protocol)
- [auth](auth/auth-overview.md) — active
  - 职责: 认证抽象(可扩展的提供方联合类型、会话令牌模型、login/logout/401 消息)+ 授权:主体求解、管理员配置的账号级工作区范围(默认拒绝)、policy epoch 与外部 MCP 的唯一卡口 `authorizeCall`
  - API: WebSocket `/ws`(见 shared protocol);工作区范围与 epoch 无线消息,由控制台与外部 MCP 内部消费
- [memory](memory/memory-overview.md) — active
  - 职责: 工作区级长期记事本(SQLite):偏好/约束/事实/教训;work session 上 `memory_search` / `memory_write`;控制台只读列表 + 软删(`list_workspace_memories` / `delete_workspace_memory`)
  - API: WebSocket `/ws`(见 shared protocol);模型侧另经 event-mcp 回环
- [external-mcp](external-mcp/external-mcp-spec.md) — active
  - 职责: 面向 c3 未拉起的 agent 的公开 MCP 入口:无凭据地址,bearer key 认证,`X-C3-Workspace` 选工作区,权限由 auth 域三层求交给出
  - API: Streamable HTTP `POST /mcp`
- [im-robot](im-robot/im-robot-overview.md) — active
  - 职责: 办公 IM 出入口(当前飞书):身份绑定、无人值守回合、唯一出站守卫、L0–L3 能力上限
  - API: WebSocket `/ws`(机器人配置/身份);IM 长连接由 provider 持有

## Shared context

- 线协议编译期真源为 [`shared/src/protocol.ts`](../../../shared/src/protocol.ts);
  人类目录见 [`websocket-protocol.md`](../../shared/api-conventions/websocket-protocol.md)。
- `agent-session`、`permission-gateway`、`session-registry` 运行在服务端进程中。
  agent-session 与 permission-gateway 通过内存中的权限注册表协作;
  session-registry 为每次运行提供活跃工作区的 `cwd`、每会话模式、以及 `resume` id。
  `web-console` 是浏览器端的对应方。

## Dependency direction

```
web-console ──(/ws)──► session-registry ──supplies cwd/mode/resume──► agent-session ──uses──► permission-gateway ──blocks──► SDK query()
          └─(/ws)──► files ──validates workspace id──► session-registry
                                                                          ▲
                                                                          │ automations ──uses──► agent-session (execute llm_prompt / command)
```

`web-console` 依赖服务端的线协议契约;`session-registry` 为每次运行向
`agent-session` 提供上下文;`agent-session` 依赖 `permission-gateway` 来把关工具;
`automations` 依赖 `session-registry`(工作区校验)与 `agent-session`(执行)。
无循环依赖。
