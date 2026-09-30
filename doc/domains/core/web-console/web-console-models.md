# web-console — 数据模型

实体与不变量。行为见[规格](web-console-spec.md)，协作见[设计](web-console-design.md)。线上形状在[共享协议](../../../shared/api-conventions/websocket-protocol.md)中定义，此处不重复。这些实体只存在于浏览器中。

## View

当前观察：哪一个应用视图（工作区 / 工作台）、哪一个工作区上下文、正在看哪条会话及其活动流。

不变量:

- 不是运行的所有者。切走或关闭不停止运行（[ADR 0006](../../../architecture/adr/0006-decouple-runs-from-connections.md)）。
- 活动流只属于正在看的会话；选中会整段替换为回放再接实时尾部。
- 可操作的权限提示至多一条，关联键是 `requestId`。
- `spec_review` 的流可看不可写。

当前工作区是本机导航状态，与正在看的会话所属工作区不必相同。

## Connection

浏览器到服务端的 WebSocket。状态为 `connecting` | `open` | `closed`。与 runtime 的 `reconnecting` 不是一回事。

不变量:

- 关闭只退订视图，不拆运行。
- 重连后恢复当前视图的回放，不另起运行。

## Queue

普通会话在 turn 进行中写下、尚未发出的 prompt。仅客户端。

不变量:

- 按会话划分；切会话保留；刷新丢失。
- 只在「正在看且 idle」时刷出为一条 `user_prompt`。
- team 无队列。
