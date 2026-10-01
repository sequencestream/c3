# 0050 — 活动状态注册表作为当前状态容器

- **Status:** accepted
- **Date:** 2026-10-01

## Context

角标需要稳定回答「现在是什么状态」，而进程内事件总线只表达「发生了什么」。总线不保存成员集合，也不能抵抗重复、乱序或迟到的生命周期事件。工作区运行中集合目前在请求时扫描 Session Runtime 与自动化执行日志；两者口径已统一，但仍是分散查询，不是一份可增量维护的当前状态。

权限等待、team parked、pending 绑定和会话删除并不都经过同一组总线主题。只订阅 `run:started` / `run:bound` / `run:settled` 无法覆盖这些转换。

## Options considered

- **A. 继续请求时扫描 Runtime 与执行日志** — 被否决。每次计数都全量并集，无法为后续增量投影和跨工作区推送提供受影响范围。
- **B. 让 EventBus 载荷携带 +1/−1 并在消费者侧累加** — 被否决。重复、乱序、重连和重放会让计数漂移；子节点也不应向父节点发送加减命令。
- **C. 外部消息队列或持久事件源** — 被否决。超出本机单进程形态，也不是角标所需要的。
- **D. 进程内活动注册表，由权威状态源同步写入，可从事实源重建** — 采纳。

## Decision

引入进程内 **活动状态注册表**：保存当前被认可的实时活动，与事件总线正交。

- 总线继续发布已发生的事实，驱动副作用与自动化。
- 注册表保存带 generation / sequence 的活动事实；相同活动只接受当前 generation，相同 generation 只接受更大的 sequence。
- 明确 settle 优先于 lease 过期；pending 绑定到真实 session id 是原子迁移，不得重复计数。
- 注册表不写意图、讨论、自动化的持久业务状态。
- Session Runtime 的开始、状态转换、绑定、落定与删除直接更新注册表。自动化 LLM 执行登记为 Runtime 后走同一条路径；总线订阅是补齐，不作为自动化执行日志 id 的第二份计数。
- 注册表可从当前 Runtime 与在途自动化执行会话全量重建；快照只读。

活动状态与会话 Runtime 状态正交：`running`、`awaiting_user`、`paused`、`parked`、`stale`、`idle`。权限等待对应 `awaiting_user`，team 存活对应 `parked`，瞬时重连仍计为 `running`。`idle` 表示活动已结束并从注册表移除。

## Consequences

- 角标投影消费注册表的成员集合，请求时计数入口读投影而非再扫描事实源。WebSocket 快照与增量不在本决策范围（[ADR 0051](0051-badge-projection-from-activity-sets.md)）。
- 注册表与 Runtime / 执行日志必须可对照：快照中的活动 session 集合与现有并集查询一致，不一致时以事实源重建为准。
- generation / sequence 为后续独立于内容流的存活续约留下围栏，本决策不实施 lease 扫频或静默超时替换。

## Compliance

- 注册表只保存实时活动，不拥有持久业务状态机。
- 写入必须带围栏；迟到的旧 generation 或非递增 sequence 被忽略。
- 删除会话或移除工作区必须同时从注册表清除对应活动。
- 进程启动或检测到漂移时，必须能从 Runtime 与在途自动化执行会话重建。

## References

- [0018](0018-event-bus-kernel-layer.md) — 事件总线表达已发生的事实，不保存当前状态
- [0006](0006-decouple-runs-from-connections.md) — 运行活在进程级 Session Runtime
- [0009](0009-unidirectional-boundaries.md) — 注册表属内核当前状态，不反向依赖特性
