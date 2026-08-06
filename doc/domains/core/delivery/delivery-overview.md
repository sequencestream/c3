# 领域: delivery

- **分组:** core
- **一句话:** 交付是把「一批意图共同集成并最终进入主线」作为 Git 生命周期单元承载——本地账本 + 受控状态机 + 「集成就熟 N/M」聚合,回答「这批能不能合了、卡在哪」。
- **负责人:** maintainer
- **状态:** 活跃
- **依赖:** `intent-management`(读 `intent_prs.delivery_id` 聚合 N/M,不写);一个位于 `~/.c3/c3.db` 的本地 SQLite 存储;`session-registry` 的 workspace 解析(`resolveWorkspaceRoot` / `pathToId`)。
- **被依赖方:** `web-console`(渲染交付一级页面:列表 + 详情两 Tab + 状态分段选择器)。
- **exposes-api:** true —— 在 WebSocket `/ws` 上有六个客户端到服务端消息(`list_deliveries` / `create_delivery` / `get_delivery_detail` / `update_delivery` / `cancel_delivery` / `transition_delivery`)、四个服务端到客户端消息(`deliveries` / `create_delivery_result` / `delivery_detail` / `delivery_transition_failed`)。消息形状定义在共享协议中,不在本文档重复定义。
- **ADRs:** [0036](../../../architecture/adr/0036-delivery-as-integration-unit.md)、[0034](../../../architecture/adr/0034-intent-pr-fact-base-and-readpoints.md)、[0035](../../../architecture/adr/0035-intent-pr-table-split-and-migration-markers.md)

## 索引

- [delivery-spec.md](delivery-spec.md) —— 实体、状态机与守卫、用户场景 US-1..US-5、业务规则(含角标规则)
- [delivery-design.md](delivery-design.md) —— SQLite 层、store、状态机接线、广播、前端
- [delivery-models.md](delivery-models.md) —— Delivery / DeliveryIntegration / DeliveryGuardReason / TransitionPlan 等实体
