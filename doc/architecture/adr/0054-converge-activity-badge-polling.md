# 0054 — 活动角标收敛为推送，空闲不再点查

- **Status:** accepted
- **Date:** 2026-10-01

## Context

活动摘要已经以 snapshot / delta 推送到前端，角标也已改读这份投影。浏览器仍每 15 秒点查 `session_status`（运行集合变化时再点查 `session_counts`），会话列表每 10 秒刷新时顺带再要一次计数，页面恢复可见时无条件重取状态。服务端存活对账之后无论投影是否变化都广播完整 `session_status`。这些路径与推送重叠，空闲标签页会持续发出业务计数请求。

WebSocket ping/pong 是连接保活，不是业务统计。

## Options considered

- **A. 保留双轨定时点查作为校准** — 被否决。投影未变时仍占用往返，也让角标继续依赖列表刷新。
- **B. 删除全部 `session_status` / `session_counts` 能力** — 被否决。会话列表运行态与兼容期点查仍需要这两条消息；本阶段只去掉周期性业务请求。
- **C. 前端空闲不点查计数；可见性恢复只在快照缺失或过旧时请求 snapshot；服务端低频对账，摘要未变不广播** — 采纳。

## Decision

- 删除前端 15 秒 `request_session_status` 定时器。会话列表定时刷新只发 `list_sessions`，不顺带 `get_session_counts`。
- 页面恢复可见时，仅当连接已打开且尚未收到 snapshot、或距上次成功应用的 snapshot/delta 已超过过旧窗口，才发 `request_activity_snapshot`。revision 缺口仍由 delta 处理路径立即重取。
- WebSocket 重连仍请求 `session_status` 与 activity snapshot，作为故障恢复校准。
- 保留 WebSocket ping/pong。
- 服务端继续按原存活间隔对账 Runtime 与活动注册表。对账先收敛挂死的 run，再从事实源重建注册表；重建保留仍在活动中的 generation / sequence，以免打断在途围栏。投影 revision 未增加则不发 `activity_delta`，也不再周期性广播 `session_status`。运行态变化仍按既有路径立即广播 `session_status`。
- 兼容期保留按需 `get_session_counts`（首次加载列表等），口径仍与投影一致。

## Consequences

- 浏览器空闲时没有周期性的业务计数或 `session_status` 点查；角标变化仍由一条 WebSocket 推送完成。
- 后台冻结导致丢帧时，靠重连、revision 缺口或过旧快照收敛，而不是靠定时器。
- 会话列表绿点不再享受 15 秒全量校准，改为变更即推、重连补齐。

## Compliance

- 前端不得为角标设立业务定时器。
- 对账不得在摘要未变时增加 revision 或推送 delta。
- 周期性重建不得改写仍在活动中的 generation，以免拒绝在途 settle。

## References

- [0053](0053-activity-snapshot-delta-protocol.md) — snapshot / delta 已上线
- [0051](0051-badge-projection-from-activity-sets.md) — revision 仅在摘要变化时增加
- [0050](0050-activity-registry-as-current-state.md) — 注册表可从事实源重建
- [0002](0002-websocket-as-permission-transport.md) — WebSocket 是控制台传输
