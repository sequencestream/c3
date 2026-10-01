# 0053 — 活动摘要以 snapshot / delta 推送到前端

- **Status:** accepted
- **Date:** 2026-10-01

## Context

角标投影已经按 Workspace 维护权威摘要和 revision，但前端仍按当前工作区请求 `session_counts`。未打开的工作区数字不会持续刷新，顶部入口在离开会话页后也要靠 `session_status` 触发点查。快照与增量不能由前端从分页列表推算，也不能把无权查看的工作区名称送到线上。

## Options considered

- **A. 继续按当前工作区点查 `session_counts`** — 被否决。后台工作区与未打开的入口无法保持最新。
- **B. 把摘要嵌进 `ready` 或 `session_status`** — 被否决。握手载荷会膨胀，且与运行状态广播耦合。
- **C. 独立的 snapshot / delta 协议：握手后下发可见工作区完整摘要，投影变化时推送受影响工作区的完整摘要，revision 跳跃则重取 snapshot** — 采纳。

## Decision

新增三条线消息：

- `activity_snapshot`：该连接可见的全部工作区摘要 + revision。握手 `ready` 之后立即下发；客户端也可发 `request_activity_snapshot` 重取。
- `activity_delta`：新 revision、受影响工作区的完整摘要、可选 `removedWorkspaces`。不发送字段级 +1/−1。
- `request_activity_snapshot`：客户端在重连或 revision 不连续时请求完整快照。

传输规则：

- 权限过滤与工作区列表使用同一套可见性，前端不能收到无权查看的工作区摘要。
- 客户端按 revision 原子替换或合并；跳跃或尚未收到 snapshot 时丢弃 delta 并请求 snapshot。
- 前端角标只读这份按工作区保存的映射：会话分类与条目读当前工作区，竖条读各工作区 `runningSessions`，工作台读 `attention.pendingUserTasks`，交付读 `attention.actionableDeliveries`。
- 兼容期保留 `session_counts` / `get_session_counts`，口径与投影一致。

## Consequences

- 不打开会话页时，所有可见工作区与顶部入口角标仍随投影变化更新。
- 旧客户端可继续点查 `session_counts`；新客户端优先消费 activity 消息。
- 周期性业务计数请求的删除留给后续阶段。

## Compliance

- 快照构造必须经过与工作区列表相同的授权过滤。
- delta 只携带受影响工作区的完整摘要，不传播加减命令。
- 前端不得从分页列表重新计算这些角标。

## References

- [0051](0051-badge-projection-from-activity-sets.md) — 角标投影提供摘要与 revision
- [0052](0052-attention-sets-in-badge-projection.md) — attention 三类集合
- [0002](0002-websocket-as-permission-transport.md) — WebSocket 是控制台传输
- [0023](0023-auth-abstraction-network-exposure.md) — 工作区可见性
