# 领域: delivery

- **分组:** core
- **一句话:** 交付是把「一批意图共同集成并最终进入主线」作为 Git 生命周期单元承载——本地账本 + 受控状态机 + 「集成就熟 N/M」聚合 + 一条真实存在的交付分支,回答「这批能不能合了、卡在哪」。
- **负责人:** maintainer
- **状态:** 活跃
- **依赖:** `intent-management`(读 `intent_prs.delivery_id` 聚合 N/M;解除关联时经 `upsertIntentPr` 同步远端已 merged 的状态、并删除已关闭 PR 的行);一个位于 `~/.c3/c3.db` 的本地 SQLite 存储;`session-registry` 的 workspace 解析(`resolveWorkspaceRoot` / `pathToId`);`git` 助手(`server/src/git.ts` 的 `isMultiRepoWorkspace` / `createDeliveryBranch` / `getForgePrStatus` / `closeForgePr` / `detectDeliveryDiffBloat`,分支初始化与关联/解除均为异步显式动作)。
- **被依赖方:** `web-console`(渲染交付一级页面:列表 + 详情两 Tab + 状态分段选择器 + 分支初始化区);`intent-management` 的 `createPrForIntent`(面向交付的 PR 创建受 `branch_ready` 闸门拦截)与意图详情页(渲染 `Intent.linkedDeliveries` 与按交付分组的 PR)。
- **exposes-api:** true —— 在 WebSocket `/ws` 上有十个客户端到服务端消息(`list_deliveries` / `create_delivery` / `get_delivery_detail` / `update_delivery` / `cancel_delivery` / `transition_delivery` / `init_delivery_branch` / `cleanup_delivery_branch` / `link_intent_to_delivery` / `unlink_intent_from_delivery`)、六个服务端到客户端消息(`deliveries` / `create_delivery_result` / `delivery_detail` / `delivery_transition_failed` / `delivery_branch_init_progress` / `delivery_branch_init_result`)。消息形状定义在共享协议中,不在本文档重复定义。
- **ADRs:** [0036](../../../architecture/adr/0036-delivery-as-integration-unit.md)、[0034](../../../architecture/adr/0034-intent-pr-fact-base-and-readpoints.md)、[0035](../../../architecture/adr/0035-intent-pr-table-split-and-migration-markers.md)

## 索引

- [delivery-spec.md](delivery-spec.md) —— 实体、状态机与守卫、分支生命周期与关联/解除规则、用户场景、业务规则(含角标规则)
- [delivery-design.md](delivery-design.md) —— SQLite 层、store、分支生命周期编排、关联/解除接线、状态机接线、广播、前端
- [delivery-models.md](delivery-models.md) —— Delivery / DeliveryIntegration / IntentDelivery / AssociatedIntent / DeliveryGuardReason / TransitionPlan 等实体,解除守卫与 diff 膨胀判据
