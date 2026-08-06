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

`deliveries` 表 + 索引见 [delivery-design.md](delivery-design.md) §Schema。`base_branch` 非空快照、`status` CHECK 闭集、活动态 `(workspace_path, branch_name)` 部分唯一索引(`delivered`/`cancelled` 不占位,允许复用历史分支名)。`intent_prs.delivery_id` 是意图→交付关联面(由 intent-management 域 031 迁移预置,本阶段恒 `NULL` 不写)。
