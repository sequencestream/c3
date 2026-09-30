# delivery — 设计

实现[规格](delivery-spec.md)。本域拥有交付账本、关联边与交付 PR,不拥有意图条目、运行循环或工作区目录。

## 协作

**intent-management.** 关联边由本域写入;该域读取以解析基准、PR 目标与依赖闸门。建 PR 与开发共用该域基准快照,本域不另推一条推导。写入窗口与完成派生见 [RM-R41](../intent-management/intent-management-spec.md) / [RM-R48](../intent-management/intent-management-spec.md);基准写入时机见 [RM-R44](../intent-management/intent-management-spec.md)。`delivered` 后触发跨交付闸门重算,判据在该域([ADR 0038](../../../architecture/adr/0038-dependency-gate-base-reachability.md))。

**session-registry.** 工作区名称是账本键;路径只用于 Git 与托管。

**agent-session.** 本域不启动运行。写入窗口由开新会话的路径求值;已在跑的挂接不受限。

**web-console.** 渲染列表、详情、角标与动作。可达目标与缺口是窗口;状态机仍以服务端为准。`current-branch` 下隐藏的 Git 动作前后端一致拒绝。独立交付复用既有创建、关联与初始化,无专属协议;失败不回滚已完成步。

## 关键取舍

**从不代合主线。** 合入走交付 PR,人在托管平台点合并;同步主线也只由人触发。后台静默改写共享分支且失败无人看,正是要防的。决策见 [ADR 0039](../../../architecture/adr/0039-delivery-merge-via-delivery-pr.md)。

**台账记录托管事实,不伪造来源。** 开放 PR 先问托管再落账;问不出不等于没有。已关闭的行不改写成 `merged`。交付状态以本域账本为准,合并是否发生以托管为准。

**关联不改投已有 PR。** 建边只建立归属;改一条开着的 PR 的目标不该由一次关联代劳。

**交付是 Git 集成单元,不是里程碑。** 不承载目标、度量或审批。决策见 [ADR 0036](../../../architecture/adr/0036-delivery-as-integration-unit.md)。

## 非功能

账本不可用则交付入口降级,工作台其余部分仍可启动。错误必须对人可见。不后台轮询托管。
