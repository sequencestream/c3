# Group: core

`core` group 承载 c3 的限界上下文(bounded context)。它们共同实现完整的循环:
用户选择一个工作区/会话,浏览器传入一条 prompt,智能体运行,
敏感工具调用通过浏览器被拦截确认,活动流回传——
再加上意图台账、讨论编排、交付集成、自动化调度、工作区记忆与 IM 机器人等配套能力。

## Domains

- [permission-gateway](permission-gateway.md) — active
  - 职责: 敏感工具在运行前暂停,路由到浏览器,阻塞直到人裁决;中止即拒绝
  - API: 内部
- [agent-session](agent-session.md) — active
  - 职责: 驱动厂商运行,把消息译到统一协议,管理权限模式与生命周期
  - API: WebSocket `/ws`
- [session-registry](session-registry.md) — active
  - 职责: 工作区与会话目录,每会话模式、最近访问与历史回放
  - API: WebSocket `/ws`
- [files](files.md) — active
  - 职责: 只读浏览已登记工作区的仓库
  - API: WebSocket `/ws`
- [sandbox](sandbox.md) — active
  - 职责: 入选会话的 run 进进程级隔离;驱动不可用则失败不裸跑
  - API: 内部
- [web-console](web-console.md) — active
  - 职责: 人观察活动流、提交 prompt、回答权限、切换模式与智能体
  - API: 消费 `/ws`
- [intent-management](intent-management.md) — active
  - 职责: 意图账本、只读沟通智能体、规格与开发、可选自动化队列
  - API: WebSocket `/ws`
- [discussion](discussion.md) — active
  - 职责: 多智能体圆桌,人可介入,结论可转意图
  - API: WebSocket `/ws`
- [delivery](delivery.md) — active
  - 职责: 一批意图共同集成并进入主线
  - API: WebSocket `/ws`
- [automations](automations.md) — active
  - 职责: 按计划或事件跑命令与 LLM 任务,留下执行记录
  - API: WebSocket `/ws`
- [session-cleanup](session-cleanup.md) — active
  - 职责: 按保留期清理过期的厂商会话存储
  - API: 内部
- [self-update](self-update.md) — active
  - 职责: 后台校验新发行,管理员确认后按运行形态重启
  - API: WebSocket `/ws`
- [auth](auth.md) — active
  - 职责: 连接过身份门;工作区默认拒绝,管理员配置范围
  - API: WebSocket `/ws`
- [memory](memory.md) — active
  - 职责: 工作区记事本;仅工作会话可写,设置页只读查阅与软删
  - API: WebSocket `/ws`
- [external-mcp](external-mcp.md) — active
  - 职责: 外部智能体凭长期钥匙访问本部署,权限与 auth 求交
  - API: Streamable HTTP `POST /mcp`
- [im-robot](im-robot.md) — active
  - 职责: 办公 IM 出入口:身份绑定、无人值守、唯一出站守卫
  - API: WebSocket `/ws`;IM 长连接由平台持有

## Shared context

- 线协议约定见 [`websocket-protocol.md`](../../shared/api-conventions/websocket-protocol.md)。
- `agent-session`、`permission-gateway`、`session-registry` 在服务端进程内协作:
  注册表播种工作目录与模式,网关把门,控制台是浏览器视图。

## Dependency direction

```
web-console ──(/ws)──► session-registry ──工作目录/模式/续跑──► agent-session ──► permission-gateway
          └─(/ws)──► files ──已登记工作区──► session-registry
                                                                          ▲
                                                                          │ automations ──► agent-session
```

`web-console` 依赖线协议;`session-registry` 为运行提供上下文;`agent-session` 依赖网关把关工具;`automations` 依赖注册表与运行时。无循环依赖。
