# Domain: delivery

- **Group:** core
- **One-line:** 一批意图共同集成并进入主线:本地账本、交付分支,以及一条由人在托管平台合并的交付 PR。
- **Owner:** maintainer
- **Status:** active
- **Depends on:** [intent-management](../intent-management/intent-management-spec.md)(意图 PR 事实、基准快照、写入窗口与完成派生);[session-registry](../session-registry/session-registry-spec.md)(工作区身份)。
- **Depended on by:** [web-console](../web-console/web-console-spec.md)(交付页与角标);[intent-management](../intent-management/intent-management-spec.md)(关联边与 PR 落点);[automations](../automations/automations-spec.md)(可订阅生命周期,亦可只读查询)。
- **exposes-api:** true — WebSocket `/ws`。消息形状在[共享协议](../../../shared/api-conventions/websocket-protocol.md)中定义。
- **ADRs:** [0036](../../../architecture/adr/0036-delivery-as-integration-unit.md) 交付作为集成单元、[0039](../../../architecture/adr/0039-delivery-merge-via-delivery-pr.md) 合入主线走交付 PR、[0038](../../../architecture/adr/0038-dependency-gate-base-reachability.md) 依赖闸门读 `delivered`、[0034](../../../architecture/adr/0034-intent-pr-fact-base-and-readpoints.md) / [0035](../../../architecture/adr/0035-intent-pr-table-split-and-migration-markers.md) 意图 PR 事实源

本域拥有交付账本、关联边与交付 PR。意图条目、PR 目标解析与工作树基线由 [intent-management](../intent-management/intent-management-spec.md) 拥有;本域写边、提供写入窗口,不复制 RM-R44 / RM-R41 / RM-R48。

## Index

- [delivery-spec.md](delivery-spec.md) — 写入窗口、工作树、同步主线、账本与守卫、关联、交付 PR、合并结果、降级、事件与只读
- [delivery-design.md](delivery-design.md) — 与意图、注册表、会话运行时、控制台的协作与取舍
- [delivery-models.md](delivery-models.md) — Delivery / Association / Delivery PR
