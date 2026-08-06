# delivery — 数据模型

以领域术语给出的实体定义;物理接线(SQLite 驱动、schema 迁移)见 [delivery-design.md](delivery-design.md);线上形状统一定义在[共享协议](../../../shared/api-conventions/websocket-protocol.md)与 `@ccc/shared/protocol` 的 delivery 分区,领域文档引用它们而不重新定义消息形状。

## Delivery

一个交付 = 一批意图的 Git 生命周期单元。按工作区隔离。

| 属性                    | 类型                  | 说明                                                                                          |
| ----------------------- | --------------------- | --------------------------------------------------------------------------------------------- |
| `id`                    | `string`(UUID)        | 交付唯一标识                                                                                  |
| `workspaceId`           | `string`              | 所属工作区(不透明 id,与其它域一致)                                                            |
| `title`                 | `string`              | 交付标题(非空)                                                                                |
| `description`           | `string`              | 交付描述                                                                                      |
| `status`                | `DeliveryStatus`      | 六态闭集,见下                                                                                 |
| `startDate`             | `number \| null`      | 用户选择的日历起始日期(epoch ms);空 = 未设                                                    |
| `endDate`               | `number \| null`      | 用户选择的日历结束日期(epoch ms);空 = 未设                                                    |
| `branchName`            | `string \| null`      | 交付分支名;`init_delivery_branch` 成功后置入,`cleanup_delivery_branch`(终态)后清空            |
| `baseBranch`            | `string`              | 建交付时对工作区 `defaultMainBranch` 的快照;之后改配置不回写,保证交付不被合进它从未基于的分支 |
| `branchReady`           | `boolean`             | 交付分支是否就绪;初始 `false`,仅由分支初始化成功/幂等绑定置真,终态手动清理置回假              |
| `integration`           | `DeliveryIntegration` | 实时「集成就熟 N/M」聚合,服务端每次读取时派生,不持久化                                        |
| `createdAt`/`updatedAt` | `number`              | 创建/更新时间(epoch ms)                                                                       |

**状态闭集**(数据库 CHECK 与共享协议同一闭集):`planned`(待集成)/`integrating`(集成中)/`verifying`(验证中)/`verified`(验证通过)/`delivered`(已发布)/`cancelled`(已取消)。无「已完成」态——它等于「所有关联意图的 PR 已合入交付分支」这一可推导事实,只以「集成就熟 N/M」呈现。

## DeliveryStatus

`'planned' | 'integrating' | 'verifying' | 'verified' | 'delivered' | 'cancelled'`。终态为 `delivered`、`cancelled`(无出边)。

## DeliveryIntegration

实时聚合,永不持久化:

| 属性     | 类型     | 说明                                               |
| -------- | -------- | -------------------------------------------------- |
| `merged` | `number` | N——关联意图中「面向本交付的 PR 已 merged」的意图数 |
| `total`  | `number` | M——关联意图数                                      |

M/N 直接由 `intent_prs.delivery_id` 查得:一个意图对同一交付至多一条 PR(唯一索引 `idx_intent_pr_delivery`),故 `COUNT(*)` 即关联意图数、`SUM(status='merged')` 即 N。无关联显示 `0/0`,但**不能**据此通过 `integrating → verifying` 守卫(该守卫要求至少一个关联意图)。

## IntentDelivery(关联边)

意图与交付之间的关联关系。领域上是一条独立的边,**不是** PR 事实的副产品。

| 属性         | 类型     | 说明               |
| ------------ | -------- | ------------------ |
| `deliveryId` | `string` | 交付 id            |
| `intentId`   | `string` | 意图 id            |
| `createdAt`  | `number` | 建边时间(epoch ms) |

**与「PR 落点」的区别。**`intent_prs.delivery_id` 回答「这个意图对某个交付开了哪条 PR」,关联边回答「这个意图属于哪个交付」。二者不能互相代替:关联先于 PR 存在(刚关联时还没提 PR),而解除关联时 PR 行会被删除、关联边的生死要独立判定。用「有没有 PR 行」代表「有没有关联」,会让「已关联但尚未提 PR」这一最常见的中间态无处安放。

**唯一性。**一对(交付, 意图)至多一条边;同一意图对多个交付各一条边是**允许**的——数据层保留多交付关联能力,前端不开放该入口(见 [delivery-spec.md](delivery-spec.md) 的边界)。

**生命周期。**建边由 `link_intent_to_delivery`,删边由 `unlink_intent_from_delivery`(守卫见下)。永久删除意图时同事务清边、**远端 PR 不动**;取消交付**不删边**——终态交付的关联意图仍可查,历史可查优先于表干净。

## AssociatedIntent(交付详情的关联意图行)

交付详情页每一行关联意图的读模型。

| 属性         | 类型                     | 说明                                    |
| ------------ | ------------------------ | --------------------------------------- |
| `id`         | `string`                 | 意图 id                                 |
| `title`      | `string`                 | 意图标题                                |
| `status`     | `IntentStatus`           | 意图自身状态                            |
| `prStatus`   | `IntentPrStatus \| null` | **该意图对本交付的 PR 状态**;无 PR 为空 |
| `headBranch` | `string \| null`         | 该 PR 的 head 分支                      |

`prStatus` 是「对本交付」而**非**意图的全局 PR 聚合。一个意图可对不同交付各持有一条 PR,用全局聚合会把别的交付的状态显示到这里——这是本读模型存在的全部理由。

## 解除关联的守卫

| 守卫                          | 规则                                                                                                                                                                                                                                                                                                  |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **已 merged 禁解**            | 对本交付的 PR 已合并 → 一律拒绝。**双层检查**:先看本地 `IntentPr.status`;本地不是 merged 时向 forge 查实时状态,forge 说 merged 同样拒绝并把本地状态同步为 `merged`(使后续请求命中本地禁解)。理由:代码已在交付分支上,删边会造成「关联没了但代码已在」,集成就绪计数与合并范围全部失真,要撤只能 revert。 |
| **forge 状态不可读 → 阻塞**   | CLI 缺失/未登录/离线导致查不到实时状态时,**拒绝**解除。无法确认「不是 merged」即按「可能 merged」处理,绝不猜。                                                                                                                                                                                        |
| **未合并 → 先关 PR 再删边**   | 确认未合并后关闭该 PR;**PR 已是关闭态视为成功**(期望状态已达成,否则外部已关的 PR 会把用户永久卡死)。关闭成功后**删除**该 `IntentPr` 行,再删关联边。                                                                                                                                                   |
| **关 PR 失败 → 整个解除阻塞** | 关联边与 PR 行都不动,报错给出失败原因。绝不半途生效。                                                                                                                                                                                                                                                 |

**为什么关闭后删 PR 行而不是留 `closed` 行**:留行会让「集成就绪 N/M」继续按交付计数,`total` 永远含着已解除的意图、`merged < total` 永久阻塞交付推进;把 `delivery_id` 清成 NULL 又会撞「每意图至多一条无交付归属 PR」的部分唯一索引。整行删除是唯一不产生孤儿、不撞唯一键、不扭曲聚合的做法。

## 关联时的 diff 膨胀提示

意图先在主线上开发、之后才关联交付时,它提向交付分支的 PR 会把「主线与交付分支的差异」一并算进 diff,显示为巨量改动。关联操作**仍然成功**,只附带一条警告(用户可能是刻意先在主线开发、之后再 rebase)。

判据不是简单的祖先关系,而是**分叉点**:

```
fork = merge-base(主线, 意图 commit)      # 意图从主线离开的位置
膨胀 ⟺ fork 不是交付分支 HEAD 的祖先
```

反例说明为什么不能只看祖先:交付分支在 `M0` 分叉、主线走到 `M5`、意图从 `M5` 分叉时,意图 commit 仍然是 `M0` 的后代(祖先检查判定「没问题」),但它提向交付分支的 PR 确实包含 `M1..M5`。

检测是纯观测且**失败即静默**:交付分支尚未就绪、ref 不存在、非 git 仓库、任何 git 失败一律不报警——给不出依据的警告比不给更糟。交付分支尚未创建时同样不报警:分支将来从当时的主线 HEAD 创建,意图的分叉点届时必然是它的祖先。

## DeliveryGuardReason

一个守卫缺口原因。`code` 是 `delivery.guard.*` locale 叶子;`jumpTo` 指示页面可跳转处(`associated-intents` / `workspace-settings` / `branch`),多数缺口无法人工解决,跳转入口仍前置表达。

| code                                         | 含义                   | 可跳转                 |
| -------------------------------------------- | ---------------------- | ---------------------- |
| `delivery.guard.branchNotReady`              | 分支未就绪             | `branch`(本页初始化区) |
| `delivery.guard.noAssociatedIntents`         | 未关联任何意图         | `associated-intents`   |
| `delivery.guard.prsNotMerged`(params N/M)    | 关联 PR 未全部合入     | `associated-intents`   |
| `delivery.guard.verificationNotConfirmed`    | 需人工确认验证通过     | —(就地确认)            |
| `delivery.guard.mergeNotSucceeded`           | 等待交付合并成功       | —(系统等待)            |
| `delivery.guard.systemOnly` / `humanOnly`    | 写角色不符             | —                      |
| `delivery.guard.mergeConflictReasonRequired` | 系统返工需合并冲突原因 | —                      |

## DeliveryTransitionPlan

服务端为交付当前状态计算的可达性 + 缺口。`targets` 为合法推进/回退目标(非法目标不出现),每个目标带 `humanAction`(是否人工可写)、`guard`(`satisfied`/`failed`)与 `reasons`。页面据此渲染分段选择器与常驻缺口,不复制状态规则。

## 持久化存储(c3.db)

`deliveries` / `intent_deliveries` 表 + 索引见 [delivery-design.md](delivery-design.md) §Schema。`base_branch` 非空快照、`status` CHECK 闭集、活动态 `(workspace_path, branch_name)` 部分唯一索引(`delivered`/`cancelled` 不占位,允许复用历史分支名)。`intent_deliveries` 承载关联边,`(delivery_id, intent_id)` 唯一、两侧各有索引;该表由交付 store 与意图 store **双声明**(意图 store 需在删除意图的同一事务里清边,而一个从未打开过交付页的库里交付 store 尚未初始化)。`intent_prs.delivery_id` 是意图对该交付的 PR 落点(由 intent-management 域 031 迁移预置),与关联边职责分离。
