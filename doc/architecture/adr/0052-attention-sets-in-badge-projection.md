# 0052 — 角标投影用独立成员集合维护 attention

- **Status:** accepted
- **Date:** 2026-10-01

## Context

角标投影已从活动事实维护运行中会话、种类与 owner 索引，但摘要里的 attention 仍为零。待用户处理角标来自前端已加载的 `wait_user_events` 列表：分页只带回一页，广播又不带 Workspace 身份，切换工作区或后台创建待办会把别的工作区条目混进当前角标。

权限请求、普通待办和交付可行动作是三种不同的注意状态。把它们加总成一个数字会失去语义。交付域已经有「用户现在可采取行动」的判定；投影不应重写该判定。

## Options considered

- **A. 前端继续从列表过滤 todo** — 被否决。分页、跨工作区广播和未打开过的页面都会得到错误数字。
- **B. 把权限、待办、交付合成一个 attention 总数** — 被否决。口径互相覆盖，无法分别验收。
- **C. 投影为三类 attention 各保存一份成员 ID 集合，权威源在事实变化时替换受影响工作区的集合** — 采纳。

## Decision

角标投影增加三类互不合并的成员索引：

- `permission`：当前仍可回答的权限请求 ID。权限登记表在等待、作答、中止时同步。
- `todo`：待用户处理台账中 `status='todo'` 的事件 ID。创建、完成、取消后按工作区替换该集合。
- `delivery`：交付域判定为可立即行动的交付 ID。投影只消费 ID，不拥有判定。

聚合读 Set 大小。revision 仅在某一工作区摘要实际变化时增加。活动事实重建只重建运行中索引，不清空 attention。删除工作区时三类 attention 一并清除。

`wait_user_events` 携带 `workspaceName` 与权威 `todoCount`。列表分页只影响 `items`。前端工作台角标读 `todoCount`，不扫描已加载列表。非当前工作区的列表帧不写入当前列表。

## Consequences

- 超过一页、切换工作区、后台创建待办都不再污染工作台角标。
- 交付入口继续消费交付域的 `needsActionCount`；投影中的 `actionableDeliveries` 与之同源。
- 全量快照 / delta 推送仍不在本决策范围。

## Compliance

- 三类 attention 不得合并为一个无语义总数。
- 投影不是待办或交付的第二真源，必须能从台账与权限登记表重建。
- 交付 actionable 判定仍只在交付域。

## References

- [0051](0051-badge-projection-from-activity-sets.md) — 活动成员集合投影
- [0039](0039-delivery-merge-via-delivery-pr.md) — 交付角标判定
- [0009](0009-unidirectional-boundaries.md) — 投影属内核，权威源在特征层写入
