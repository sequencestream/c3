# 0036 — 交付作为集成单元

- **Status:** proposed
- **Date:** 2026-08-06

## Context

一批意图需要作为整体合入主线时，系统没有任何实体能表达「这几个意图是一批」：每个意图各自提 PR 进主线，无法回答「这批能不能合了、卡在哪」。`intent_prs.delivery_id` 只是预留的关联键（ADR-0035），没有一个承载「批」的状态机、账本或页面。

候选的承载语义有两类，容易混为一谈：

- **Git 生命周期单元**：这批意图集成到哪条分支、PR 是否全部合入交付分支、交付分支是否合并进主线。
- **业务里程碑**：目标、度量、审批、甘特/时间轴。

把两者塞进一个实体，会让「需求砍了但分支已有提交」这类状态变得无解——业务口径与 Git 事实互相绑架。

## Options considered

- **A. 用意图状态派生「批次」**：不建新表，把「同一批」挂在若干意图的一个共享字段上。被否决：批次不是意图的属性，是多个意图的集合；「集合是否可合入」没有状态机，聚合关系要散落在每个意图上重复维护。
- **B. 建 `deliveries` 表 + 受控状态机，本阶段只做本地账本**：交付 = 一批意图的 Git 生命周期单元，`planned → integrating → verifying → verified → delivered` + 任意非终态取消，回退边两条。**采纳。** 状态机是集合级事实，聚合「集成就绪 N/M」实时派生、不持久化。
- **C. 同时承载业务里程碑（Epic/目标/审批）**：被否决，见 Context——业务口径与 Git 生命周期混在一个实体里会互相绑架。
- **D. 建「已完成」状态**：被否决。它等于「所有关联意图的 PR 已合入交付分支」这一可推导事实；留着必然产生「状态说已完成、实际还有 PR 没合」的账实不符，只以只读指标「集成就绪 N/M」呈现。

## Decision

- **交付是 Git 集成单元，不是业务里程碑。** 它是「一批意图共同集成并最终进入主线」的生命周期承载体，用来回答「这批能不能合了、卡在哪」。
- **本阶段只建本地账本 + 状态机 + 一级页面。** 不创建/绑定/探测交付分支，不关联/解除意图，不创建/改 base/关闭/合并任何 PR——对应动作由后续阶段写入，本阶段只提供数据与契约接缝。`deliveries` 表 `base_branch` 在建交付时对工作区 `defaultMainBranch` 快照，防止用户中途改配置导致交付被合进它从未基于的分支。
- **状态机是领域纯函数，服务端是唯一裁决者。** 所有状态写入统一经 `canTransitionDelivery`；客户端只展示服务端给出的可达性与缺口，不复制状态规则。守卫依次为「分支就绪 → 有关联意图且其 PR 全部合入交付分支 → 人工确认验证通过 → 合并成功」。
- **`status` 用数据库 CHECK 闭集。** 新域无 `intents.status` 那种历史遗留越界值，此刻不加以后再也加不上。
- **「已完成」不是状态，只做「集成就熟 N/M」聚合指标。** 实时由 `intent_prs.delivery_id` 派生，不持久化计数、不读冗余列，避免解除关联或 PR 状态变化后的账实不符。
- **`pr:merge` 语义漂移提前知情告知。** 工作区首次创建交付时一次性提示「`pr:merge` 现在可能指向交付分支，请检查自动化订阅」——该漂移无技术回退（事件已发、自动化已执行），提示是唯一防御手段。

## Consequences

- 交付与意图生命周期**解耦**：取消交付不清理关联意图/远端资源；交付状态推进不依赖意图 `status`，只依赖「面向本交付的 PR 是否 merged」这一可复核事实。
- `base_branch` 用快照而非实时配置：配置变更后新旧交付可能指向不同基线——这是避免旧交付被合入未曾基于分支所需的稳定性。
- 一次性告知无法撤回已发送的 `pr:merge`：在语义可能扩展前提前暴露，不尝试用技术回退掩盖。
- 后续阶段的交付分支、意图关联、PR 改投、合并能力将复用本表 `branch_name` / `branch_ready` / `base_branch` 与 `intent_prs.delivery_id` 接缝；`(workspace_path, branch_name)` 活动态部分唯一索引为复用历史分支名留了终态出口。
- 本阶段角标（「需要用户处理」）因无人工可解决缺口、无分支/关联/合并动作，实际恒为 0；代码与状态机口径一致，后续接入对应动作即解锁。

## Compliance

- `database/deliveries/deliveries.sql` 与迁移 `database/migrate/2026/08/06/032-deliveries.sql` 声明 status CHECK 与活动态部分唯一索引；`database/tables.md` 同步。
- `server/src/features/deliveries/state-machine.ts` 是 `canTransitionDelivery` 唯一实现；服务端 feature 所有状态写入经它，客户端只消费 `transitionPlan`。
- 中文状态固定「待集成/集成中/验证中/验证通过/已发布/已取消」，`doc/i18n/i18n-terms.md` 明列禁用词「已完成」「进行中」。

## References

- `database/deliveries/deliveries.sql` — deliveries 表 DDL（status CHECK + base_branch 快照 + 活动态部分唯一索引）
- `server/src/features/deliveries/state-machine.ts` — 交付状态机纯函数与守卫
- `server/src/features/deliveries/store.ts` — deliveries 台账读写 + 集成就绪 N/M 聚合
- `doc/i18n/i18n-terms.md` — Delivery 词条组与中文禁用词
- [0034](0034-intent-pr-fact-base-and-readpoints.md) — `intent_prs` 的事实基础（`delivery_id` 预留）
- [0035](0035-intent-pr-table-split-and-migration-markers.md) — PR 拆表 + `schema_migrations` 迁移标记
