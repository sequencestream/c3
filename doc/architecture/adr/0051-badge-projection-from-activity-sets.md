# 0051 — 角标投影由活动成员集合增量维护

- **Status:** accepted
- **Date:** 2026-10-01

## Context

活动状态注册表已经保存当前活动事实，但角标入口仍在请求时扫描 Session Runtime、会话目录与自动化执行日志。扫描得到的是正确的并集口径，却无法给出「哪些 Workspace 刚变了」，也不能保证全量重建与任意合法增量序列得到同一份摘要。

角标需要的是成员集合的大小，不是可漂移的加减计数。子节点向父节点发送 `+1/−1` 会在重复、乱序和重连下出错。

## Options considered

- **A. 继续请求时全量扫描** — 被否决。每次计数都走并集查询，无法为后续增量推送提供受影响范围，也无法证明重建与增量等价。
- **B. 在消费者侧累加 +1/−1** — 被否决。与注册表同一条理由：集合投影才能抵抗重放。
- **C. 从活动事实维护 Workspace、SessionKind、owner 三类成员索引，聚合值为 Set 大小，并记录 revision** — 采纳。

## Decision

引入进程内 **角标投影**：订阅活动注册表的变更，只更新受影响 Workspace 的索引。

- 索引是成员集合：Workspace → 活动 Session；Workspace × SessionKind → 活动 Session；Workspace × owner 种类 → 活动 owner。聚合读 Set 大小，不保存独立计数器。
- 计入 running 角标的状态与注册表相同：`running`、`awaiting_user`、`parked`。`paused` 与 `stale` 保留活动记录但不进入这些集合。
- 同一 owner 下多个活动 Session 只使该 owner 出现一次。owner 变更是原子的移出旧集合、加入新集合。
- 自动化条目 owner 只来自可展示的在途 llm 执行，不因「会话归属自动化」而点亮；会话页 automation 分类则是同一活动集合按种类分桶，与工作区运行中总数同源。
- revision 仅在某一 Workspace 的摘要实际变化时增加。lease 续约、running 族内部的状态转换不增加 revision。
- 投影可从注册表快照全量重建；任意合法增量序列与全量重建必须得到相同摘要。
- 删除 Workspace 时注册表与投影一并清除该工作区的全部成员。
- `get_session_counts` 读投影再映射到线协议：`spec` 聚合撰写与评审，`spec_review` 线字段为 0，`tool` 随显示开关，`consensus` / `robot` 不进会话页分类但仍计入工作区总数。
- 待用户处理与交付 attention 仍不在本投影内，摘要里的 attention 字段保持为零，待后续阶段接入。
- 快照 / delta 推送协议仍不在本决策范围。

## Consequences

- 会话页分类、条目去重与工作区运行中总数都从同一份活动集合派生，不再各自扫描。
- 注册表写入必须带上当前 owner，投影才能在增量路径上维护条目角标；缺失时由重建补齐。
- 兼容期仍保留旧的扫描函数，供对照测试；发现摘要不一致时以事实源重建为准。

## Compliance

- 投影不是第二业务真源，必须能从活动事实重建。
- 不把意图、讨论、自动化的持久生命周期写进投影。
- revision 不得在摘要未变时增加。
- 删除 Workspace 必须清空该工作区的全部索引。

## References

- [0050](0050-activity-registry-as-current-state.md) — 活动注册表提供当前活动事实
- [0009](0009-unidirectional-boundaries.md) — 投影属内核当前状态，不反向依赖特性
- [0018](0018-event-bus-kernel-layer.md) — 总线不保存当前成员集合
