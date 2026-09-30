# agent-session — 数据模型

实体与不变量。行为见 [规格](agent-session-spec.md),协作见 [设计](agent-session-design.md)。

## Session Runtime

进程范围内某个会话执行的所有者,按会话键跨连接共享([ADR 0006](../../../architecture/adr/0006-decouple-runs-from-connections.md))。

不变量:

- 每个 runtime 至多一个进行中的 Agent Run。
- 连接关闭后仍存活;只在 `delete_session` / `remove_workspace` 时销毁。
- pending 绑定到真实 id 时,回放缓冲、viewers 与在途 run 一起迁移。
- 工作目录与权限模式由它持有;session-registry 播种并镜像模式。
- 状态为 `idle` | `running` | `awaiting_permission` | `team` | `reconnecting`。
- 会话种类(work / intent / spec / discussion / automation / tool 等)只作路由标记;runtime 仍是实时执行的事实来源。

回放由创建时的磁盘 baseline 加上此后每一条线事件的 buffer 组成。Viewers 是当前观察该会话的连接。

## Connection View

一个 WebSocket 连接对其当前观察会话的订阅,不是运行的所有者。

切换时退订旧的、订阅新的;关闭时只退订。所有存活连接还接收 `session_status` 广播。

## Agent Run

由一个用户 prompt 驱动的一次厂商运行。

状态: Streaming → Complete | Errored | Stopped。team 运行上,一次结果结束该 **turn** 而不结束该 **run**。敏感工具经 permission-gateway 门控。

## Run Handle

运行进行中才存在的实时控制:在厂商支持时把新权限模式应用到在途 run;把下一用户 turn 推入存活的 team 会话。运行结束则消失。

## Permission mode

厂商原生 token,经该厂商模式目录解释为中立网格。语义见[规格 § Permission modes](agent-session-spec.md#permission-modes);线形状见[共享协议](../../../shared/api-conventions/websocket-protocol.md)。
