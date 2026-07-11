# Group: core

`core` group 承载 c3 的限界上下文(bounded context)。它们共同实现完整的循环:
用户选择一个工作区/会话,浏览器传入一条 prompt,智能体运行,
敏感工具调用通过浏览器被拦截确认,活动流回传——
再加上一个为该循环提供工作输入的项目级意图台账(intent ledger),以及一个
项目级讨论存储(持久化基础)。

## Domains

| Domain                                                                  | Responsibility                                                                                                  | API                                 | Status        |
| ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ----------------------------------- | ------------- |
| [permission-gateway](permission-gateway/permission-gateway-overview.md) | 拦截 SDK 权限请求,路由到浏览器,阻塞直到用户决策(中止时拒绝)                                                     | 内部(无对外公开 HTTP API)           | active        |
| [agent-session](agent-session/agent-session-overview.md)                | 驱动 SDK 的 `query()` 循环,把 SDK 消息映射到线协议,管理模式与生命周期                                           | WebSocket `/ws`(见 shared protocol) | active        |
| [session-registry](session-registry/session-registry-overview.md)       | 管理工作区与会话;拥有每会话模式、最近访问顺序、历史回放                                                         | WebSocket `/ws`(见 shared protocol) | active        |
| [codes](codes/codes-overview.md)                                        | 只读工作区代码浏览:在已注册的工作区根目录下列目录、读文本文件、做有界搜索                                       | WebSocket `/ws`(见 shared protocol) | active        |
| [web-console](web-console/web-console-overview.md)                      | 浏览器 UI:侧边栏、prompt 输入、活动流、权限对话框、模式切换                                                     | 消费 `/ws`                          | active        |
| [intent-management](intent-management/intent-management-overview.md)    | 项目级意图台账(SQLite);只读意图沟通智能体;`save_intents` 确认;启动可配置的开发技能                              | WebSocket `/ws`(见 shared protocol) | active        |
| [codes](codes/codes-overview.md)                                        | 只读工作区代码浏览与有界搜索,仅根植于已注册的工作区 id                                                          | WebSocket `/ws`(见 shared protocol) | active        |
| [discussion](discussion/discussion-overview.md)                         | 项目级讨论存储(SQLite):讨论 + 有序消息,带状态生命周期与结论。持久化基础;智能体/编排/UI 尚未构建                 | 内部(尚无公开 API)                  | partial       |
| [automations](automations/automations-overview.md)                      | 跨工作区的基于时间的命令与 LLM prompt 执行;执行日志记录与查看                                                   | WebSocket `/ws`(见 shared protocol) | planned       |
| [auth](auth/auth-overview.md)                                           | 认证抽象:可扩展的提供方联合类型(`basic` 优先)、会话令牌模型、login/logout/401 消息——网络暴露的前提条件(C-SEC-5) | WebSocket `/ws`(见 shared protocol) | contract-only |

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
