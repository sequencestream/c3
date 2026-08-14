# Group: core

`core` group 承载 c3 的限界上下文(bounded context)。它们共同实现完整的循环:
用户选择一个工作区/会话,浏览器传入一条 prompt,智能体运行,
敏感工具调用通过浏览器被拦截确认,活动流回传——
再加上一个为该循环提供工作输入的项目级意图台账(intent ledger),以及一个
项目级讨论存储(持久化基础)。

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
- [codes](codes/codes-overview.md) — active
  - 职责: 只读工作区代码浏览:仅根植于已注册的工作区 id,在其根目录下列目录、读文本文件、做有界搜索
  - API: WebSocket `/ws`(见 shared protocol)
- [web-console](web-console/web-console-overview.md) — active
  - 职责: 浏览器 UI:侧边栏、prompt 输入、活动流、权限对话框、模式切换
  - API: 消费 `/ws`
- [intent-management](intent-management/intent-management-overview.md) — active
  - 职责: 项目级意图台账(SQLite);只读意图沟通智能体;`save_intents` 对话确认后落库;启动可配置的开发技能
  - API: WebSocket `/ws`(见 shared protocol)
- [discussion](discussion/discussion-overview.md) — partial
  - 职责: 项目级讨论存储(SQLite):讨论 + 有序消息,带状态生命周期与结论。持久化基础;智能体/编排/UI 尚未构建
  - API: 内部(尚无公开 API)
- [delivery](delivery/delivery-overview.md) — active
  - 职责: 交付作为集成单元:一批意图的 Git 生命周期承载体——本地账本 + 受控状态机 + 集成就熟 N/M 聚合;本阶段不建分支/不关联意图/不动 PR
  - API: WebSocket `/ws`(见 shared protocol)
- [automations](automations/automations-overview.md) — planned
  - 职责: 跨工作区的基于时间的命令与 LLM prompt 执行;执行日志记录与查看
  - API: WebSocket `/ws`(见 shared protocol)
- [session-cleanup](session-cleanup/session-cleanup-design.md) — active
  - 职责: 按保留期删除各 vendor 会话存储中过期的会话记录(系统级开关,vendor 中立,每日执行)
  - API: 内部(无对外公开 API)
- [self-update](self-update/self-update-design.md) — active
  - 职责: 后台下载并校验最新发行包到暂存区,由管理员在控制台一键重启生效;按运行形态选择重启方式,不可自更新的形态明确让位
  - API: WebSocket `/ws`(见 shared protocol)
- [auth](auth/auth-overview.md) — active
  - 职责: 认证抽象(可扩展的提供方联合类型、会话令牌模型、login/logout/401 消息)+ 授权:主体求解、管理员配置的账号级工作区范围(默认拒绝)、policy epoch 与外部 MCP 的唯一卡口 `authorizeCall`
  - API: WebSocket `/ws`(见 shared protocol);工作区范围与 epoch 无线消息,由控制台与外部 MCP 内部消费
- [external-mcp](external-mcp/external-mcp-spec.md) — active
  - 职责: 面向 c3 未拉起的 agent 的公开 MCP 入口:无凭据地址,bearer key 认证,`X-C3-Workspace` 选工作区,权限由 auth 域三层求交给出
  - API: Streamable HTTP `POST /mcp`

## Shared context

- 三者共享
  [`shared/api-conventions/websocket-protocol.md`](../../shared/api-conventions/websocket-protocol.md)
  中的线协议。
- `agent-session`、`permission-gateway`、`session-registry` 运行在服务端进程中。
  agent-session 与 permission-gateway 通过内存中的权限注册表协作;
  session-registry 为每次运行提供活跃工作区的 `cwd`、每会话模式、以及 `resume` id。
  `web-console` 是浏览器端的对应方。

## Dependency direction

```
web-console ──(/ws)──► session-registry ──supplies cwd/mode/resume──► agent-session ──uses──► permission-gateway ──blocks──► SDK query()
          └─(/ws)──► codes ──validates workspace id──► session-registry
                                                                          ▲
                                                                          │ automations ──uses──► agent-session (execute llm_prompt / command)
```

`web-console` 依赖服务端的线协议契约;`session-registry` 为每次运行向
`agent-session` 提供上下文;`agent-session` 依赖 `permission-gateway` 来把关工具;
`automations` 依赖 `session-registry`(工作区校验)与 `agent-session`(执行)。
无循环依赖。
