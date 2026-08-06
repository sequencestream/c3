# delivery — 设计

实现 [delivery-spec.md](delivery-spec.md)。该能力由 `server/src/features/deliveries/`(store + 状态机 + handlers)、`server/src/git.ts`(交付分支 git 助手)、`shared/src/protocol/delivery*.ts`(线契约)与 `web/src/pages/deliveries/`(一级页面)构成,并挂钩到 `wiring/broadcasts.ts` 的广播。

**复用基线。** 复用共享 `Db`(单文件 SQLite,`PRAGMA user_version` 只是各 store 自有的信息戳)、`resolveWorkspaceRoot`/`pathToId` 工作区解析、`HandlerMap` 穷尽注册门(ADR-0009)、既有 `ConfirmDialog`/`MobileStack`/i18n 类型安全 `t`。真正全新的是:deliveries 台账表、交付状态机纯函数、`delivery_transition_failed` 结构化缺口帧、按工作区计算角标、以及交付分支生命周期(create/bind 初始化 + 孤儿防御 + 多仓拒绝 + 终态清理)。

## 职责

| 关注点            | 说明                                                                                                                                                                                                                                           |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 台账读写          | `store.ts`:`listDeliveries`/`getDelivery`/`createDelivery`/`updateDelivery`/`setDeliveryStatus`/`integrationAggregate`/`setDeliveryBranch`/`clearDeliveryBranch`/`activeDeliveryHoldsBranch`                                                   |
| 状态机            | `state-machine.ts`:`canTransitionDelivery`(唯一写状态门)/`deliveryTargets`/`computeTransitionPlan`/`deliveryRequiresAction`/`countDeliveriesNeedingAction`                                                                                     |
| 分支生命周期      | `git.ts`:`isMultiRepoWorkspace`/`fetchRemoteBaseAsync`/`remoteBranchHead`/`resolveRefHead`/`createDeliveryBranch`/`deleteLocalBranch`;handler 端 `initDeliveryBranchHandler` 编排 fetch → 期望起点 → 远端探测 → create/bind/孤儿判定 → DB 写入 |
| 工作区隔离 + 广播 | handlers 经 `resolveWorkspaceRoot` 解析路径、校验 `delivery.workspaceId` 归属;变更后 `broadcastDeliveries` 全量重读并带角标                                                                                                                    |
| 页面              | `web/src/pages/deliveries/`:列表 + 详情两 Tab + 分段选择器 + 常驻缺口 + 分支初始化区,只消费服务端 `transitionPlan`                                                                                                                             |

## SQLite 层

- 位置:`server/src/features/deliveries/store.ts`。单文件 `~/.c3/c3.db`,惰性建表,`CREATE TABLE IF NOT EXISTS` 幂等;软失败:库不可用时读返回空/null、写抛错。
- 版本戳:`SCHEMA_VERSION=1`,写 `PRAGMA user_version=1`(仅信息性,与其它 store 互相覆盖无妨)。
- `intent_prs` 由 intent-management 域拥有;`integrationAggregate` 直接查该表,表未建时对 `sqlite_master` 判定降级 `0/0`(boot 期意图库可能尚未初始化)。

## Schema(PRAGMA user_version 迁移)

`deliveries` 表 + 索引(新库与迁移 `database/migrate/2026/08/06/032-deliveries.sql` 同构):

- `id` PK / `workspace_path` NOT NULL / `title` NOT NULL / `description` DEFAULT '' / `status` NOT NULL CHECK 六态 / `start_date` / `end_date` / `branch_name` / `base_branch` NOT NULL / `branch_ready` DEFAULT 0 / `created_at` / `updated_at`
- `idx_delivery_workspace_status(workspace_path, status)`
- `idx_delivery_workspace_active_branch` 部分唯一:`ON (workspace_path, branch_name) WHERE branch_name IS NOT NULL AND status NOT IN ('delivered','cancelled')`

Schema 版本历史:v1 纯新增(无存量回填)。

## Store

`createDelivery` 在单事务内:先 `COUNT(*)` 该工作区已有交付行判定首次 → `INSERT` → 返回 `{ delivery, prMergeNotice }`。`toDelivery` 每次读取附加 `integrationAggregate`(实时派生,永不落库)。`setDeliveryStatus` 只写库,**不做状态机校验**——调用方(handler)必须先过 `canTransitionDelivery`,该门在 feature 层唯一。

分支生命周期写入:`setDeliveryBranch(id, branchName, ready)` 一次性写 `branch_name` + `branch_ready`(仅 git 侧成功后调用);`clearDeliveryBranch(id)` 清空两者(仅终态手动清理);`activeDeliveryHoldsBranch(workspacePath, branchName, excludeId)` 供 `bind` 的占用检测(`excludeId` 排除自身重试),DB 层 `idx_delivery_workspace_active_branch` 部分唯一索引兜底。

## 分支生命周期(init_delivery_branch)

- **handler 编排** `initDeliveryBranchHandler`:多仓检测(`isMultiRepoWorkspace`,先于任何 git 命令)→ `fetch origin <base_branch>`(`fetchRemoteBaseAsync` 的异步等价,不取本地 ref)→ 以 `origin/<base_branch>` HEAD(`resolveRefHead`)为期望起点 → `remoteBranchHead` 探测远端同名分支 → 分派:
  - `create` + 远端不存在 → `createDeliveryBranch`(fetch → `git branch <name> <remote>/<base>` → `git push -u`),push 成功后才写 DB;
  - `create` + 远端存在且 HEAD == 期望起点 → 孤儿(上次 push 成功但 DB 写失败)幂等绑定,不重新 push;
  - `create` + 远端存在且 HEAD != 期望起点 → `delivery.branchConflict`,**绝不覆盖**;
  - `bind` + 远端不存在 → `delivery.branchNotFound`;
  - `bind` + 远端存在 → 占用检测(`activeDeliveryHoldsBranch`)→ 写 DB;HEAD 与基线不一致时结果帧携带 `warning: 'delivery.branchBehindMain'`(只警告不拒绝)。
- **git.ts 复用**:`isMultiRepoWorkspace`/`fetchRemoteBaseAsync`/`remoteBranchHead`/`resolveRefHead`/`createDeliveryBranch`/`deleteLocalBranch` 均为异步(与 `createWorktree` 的同步 `execFileSync` 区分——分支初始化是独立用户动作,不阻塞自动化 FSM);`createDeliveryBranch` 的 push 拒绝(`non-fast-forward`/`fetch first`)映射 `errorKind:'branchConflict'`。
- **进度**:`delivery_branch_init_progress` 按 `fetching → creating → pushing`(create 路径)或单个 `binding`(bind/孤儿幂等)推送请求连接;成功发 `delivery_branch_init_result` 并广播 `deliveries`。
- **清理**:`cleanupDeliveryBranchHandler` 仅接受终态(`delivered`/`cancelled`),`deleteLocalBranch` 尽力删本地引用(缺失即无事可删),随后 `clearDeliveryBranch`;远端分支永不触碰。

## 状态机接线

- `state-machine.ts` 是纯函数模块(无 DB/WS 依赖),表驱动 `EDGES` 定义六态边 + 角色 + 守卫序列;`canTransitionDelivery` 对非法边返回 `delivery.invalidStatusTransition`,对角色/原因/守卫不满足返回 `delivery.transitionGuardFailed` + 缺口列表。
- handler 的 `applyTransition` 统一服务 `transition_delivery` 与 `cancel_delivery`:从当前事实(分支就绪、聚合)重新计算守卫,失败发 `delivery_transition_failed`(含 `currentStatus` + `to` + 缺口),成功写库并回 `delivery_detail` + 广播。
- 系统专属边(`verified → delivered`、`verified → verifying`)在本阶段无写入口,仅契约 + 测试接缝;`canTransitionDelivery` 以 `role:'system'` 支持之。
- `branchNotReady` 缺口的 `jumpTo` 为 `branch`(本页分支初始化区),不再是 `workspace-settings`;`branch_ready` 变为可写后,`branchNotReady` 守卫真正生效。

## 角标

`countDeliveriesNeedingAction` 对工作区每个交付求 `deliveryRequiresAction`(可执行人工推进/返工动作存在,或存在人工可解决缺口)之和;`HUMAN_SOLVABLE_GAPS` 本阶段为空集(分支初始化/意图关联/PR 合并属后续阶段),故实际恒为 0,代码口径与状态机一致,后续接入对应动作即解锁。角标随 `deliveries` 帧下发(`needsActionCount`),前端不重算。

## 广播

`wiring/broadcasts.ts` 新增 `broadcastDeliveries(workspacePath)`:库可用时重读 `listDeliveries` + `countDeliveriesNeedingAction`,以 `ServerDeliveries` 帧推所有连接。`KernelContext` 挂 `broadcastDeliveries`,`server.ts` 装配。

## 前端

`web/src/pages/deliveries/` 容器经 `App.vue` 注入 `currentDeliveries`/`activeDelivery`/`activeDeliveryPlan`/`activeDeliveryBranchInit`/`workspaceGitBranchMode`。页面只消费服务端 `transitionPlan` 渲染分段选择器(非法目标不出现、守卫未满足置灰)与常驻缺口(`delivery.guard.*` 文案 + 跳转 + N/M)。`current-branch` 模式显示「仅聚合视图」说明文案,动作区不渲染分支/PR/合并动作。角标 `HEADER_TABS` 取 `deliveriesNeedsAction[currentWorkspace]`。

**分支初始化区**(概览 tab,`worktree` 模式):未就绪时显示 create/bind 切换 + 分支名输入框(默认 `delivery/<short-id>-<slug>`,由 `defaultDeliveryBranchName` 生成)+「初始化分支」按钮 + 进度行(`delivery_branch_init_progress` 相位文案);就绪后显示分支名;终态且持有分支时显示「清理分支」入口(danger ConfirmDialog 二次确认)。`branchNotReady` 缺口跳转 `branch` 会切到概览并聚焦该区。`message-handler` 处理 `delivery_branch_init_progress`/`delivery_branch_init_result`(成功清 in-flight + 采纳模型 + 重取详情 + 落后警告 toast),并在 init 错误码时清 in-flight + toast。

## 依赖

`intent-management`(读 `intent_prs`)、`session-registry` 的工作区解析、`wiring/broadcasts`。不 import `transport/`(ADR-0009 R1 的 kernel 边界)。
