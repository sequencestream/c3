# WebSocket 协议

浏览器与服务器经 `/ws` 交换以 `type` 判别的 JSON 信封（HTTPS 下为 `wss://`）。形状只在共享协议模块定义一次，由 barrel 装配为两端共用的消息联合；领域引用 `type` 名，不复制字段。

- 无法解析或 `type` 无法识别的客户端消息被忽略，绝不视为权限批准。
- `permission_request` 与匹配的 `permission_response` 以 `requestId` 成对。权限决策不持久化；重放的 `permission_request` 不附带决策（见 [permission-gateway](../../domains/core/permission-gateway.md) 与 web-console [WC-R16](../../domains/core/web-console.md)）。
- `wait_user_events` 携带 `workspaceName` 与权威 `todoCount`；分页只约束 `items`。
- 活动角标走 `activity_snapshot` / `activity_delta`：握手后下发全部可见工作区摘要，投影变化时推送带 revision 的增量。客户端不定时点查计数；revision 不连续、重连、或快照过旧时发 `request_activity_snapshot`。权限过滤在服务端完成。`session_counts` 仍可按工作区点查，口径与投影一致。
- 工作区身份是不可变的 `workspaceName`。登记工作区是唯一带磁盘路径的消息。
- 意图队列控制为 `start_workflow` / `stop_workflow` / `queue_control`，状态为 `workflow_status`（不是 `start_automation` / `automation_status`）。
