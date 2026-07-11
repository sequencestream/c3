# agent-session — 数据模型

实体定义。业务语义类型;行为接线见 [agent-session-design.md](agent-session-design.md)。

## Session Runtime

进程范围内某个会话执行的所有者,以 session id 为键,跨连接共享(ADR 0006)。一旦创建即存活于进程生命周期内(尚无淘汰机制)。

| Attribute      | Type                        | Description                                                                                    |
| -------------- | --------------------------- | ---------------------------------------------------------------------------------------------- |
| Session id     | text (UUID \| pending form) | Map 键;在首次绑定时从 pending 重新键入为真实值(AS-R10)                                         |
| Workspace path | text (path)                 | 该运行的工作目录(由 runtime 拥有)                                                              |
| Mode           | permission mode             | 该会话的模式;运行的起始策略(AS-R3, SR-R5)                                                      |
| Baseline       | list of transcript items    | runtime 创建时的磁盘转录快照;在 buffer 之前回放                                                |
| Buffer         | list of wire events         | 创建以来发出的每个事件(所有 turn);在视图加入时回放(AS-R11)                                     |
| Run            | reference \| none           | 正在进行的 Agent Run 的中止句柄 + handle,或 turn 之间为 none                                   |
| Status         | enum                        | idle \| running \| awaiting_permission \| team(AS-R12)                                         |
| Session kind   | enum                        | work \| intent \| spec \| discussion \| automation \| tool;为 projection/list 路由标记 runtime |
| Viewers        | set of delivery callbacks   | 当前正在观察该会话的连接;实时事件分发给它们                                                    |

关系:每个 runtime 至多有一个进行中的 Agent Run(串行,AS-R2);许多 runtime
并发运行。连接关闭后仍存活(AS-R8);在 `delete_session` /
`remove_workspace` 时销毁。绑定时,runtime 的 kind 及任何启动域所有者会被镜像到
可重建的 `session_metadata` projection 中,供 list/count 读取使用;runtime 仍然是
实时执行的事实来源。

## Connection View

一个 WebSocket 连接对其当前观察的会话的订阅。

| Attribute | Type            | Description                                      |
| --------- | --------------- | ------------------------------------------------ |
| Viewing   | text id \| none | 该连接当前观察的会话(一个 runtime 键)            |
| Deliver   | operation       | 向该连接的 socket 发送线事件(viewer + broadcast) |

关系:注册为所观察 runtime 的一个 viewer;同时也在全局广播集合
中用于 `session_status`。切换时,取消订阅旧的并订阅新的;关闭时,
仅取消订阅——运行不受影响。

## Agent Run

由一个用户 prompt 针对某会话的 runtime 驱动的一次 `query()` 调用。

| Attribute       | Type                | Description                                            |
| --------------- | ------------------- | ------------------------------------------------------ |
| Prompt          | text                | 用户的第一个 turn,注入到流式输入 prompt 中(AS-R13)     |
| Working dir     | text (path)         | SDK 的 `cwd`;会话的工作区目录                          |
| Resume id       | text (UUID) \| none | 要继续的现有 session id;pending 会话的首次运行为 none  |
| Permission mode | permission mode     | 运行启动时所处的模式(运行中可变)                       |
| Session id      | text (UUID)         | 从运行的 `init` 消息中报告;重新键入 runtime(AS-R10)    |
| State           | enum                | Streaming → Complete \| Errored \| Stopped(见规格文档) |

关系:产生一系列线事件;通过 Permission
Request 门控敏感工具(permission-gateway 域)。

## Run Handle

运行启动时交给连接的实时控制。

| Operation  | Description                                               |
| ---------- | --------------------------------------------------------- |
| Set mode   | 对进行中的运行应用新模式(AS-R4)                           |
| Push input | 将下一个用户 turn 送入实时流式会话——team 会话使用(AS-R17) |

关系:仅在运行进行中时存在;运行结束时清为 none。

## Run Options

一次运行的输入。除 [agent-session-design.md](agent-session-design.md) § Run construction 中列出的
SDK 选项外,与业务相关的补充项:

| Input                      | Kind     | Description                                                                                                                                    |
| -------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Start callback             | callback | 用 **Run Handle** 触发一次,以便调用方驱动实时运行                                                                                              |
| Session-id callback        | callback | 用 `init` 消息中的 SDK session id 触发一次(AS-R10)                                                                                             |
| Team callback              | callback | 在检测到第一个 team 工具时触发一次——运行变为持久化(AS-R14)                                                                                     |
| Degradable-error callback  | callback | 在速率限制/鉴权/连接错误时触发,以便调用方切换 agent(降级链);该运行会跳过其终止性 `turn_end`                                                    |
| Socket-disconnect callback | callback | 在出现 `socket connection was closed unexpectedly` 时触发,携带 AS-R19 门控结论,以便调用方决定是否单次自动 `resume`;运行跳过 `turn_end`(AS-R18) |
| Reconnect-attempt flag     | boolean  | 当本次运行**是**断线后自动 `resume` 的单次尝试时为 true;为该 turn 的 `turn_end` 打上 `reconnect_attempted`/`retry_count` 标记(AS-R18)          |

## Permission mode

`default` · `auto` · `plan` · `acceptEdits` · `bypassPermissions`。在
[共享协议](../../../shared/api-conventions/websocket-protocol.md)中定义一次;门控语义
见 [agent-session-spec.md](agent-session-spec.md) § Permission modes。
