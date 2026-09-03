# intent-management — PR 事实的读写点

> PR/MR 事实的唯一真实来源是 `intent_prs` 表(字段与聚合规则见
> [intent-management-models.md](intent-management-models.md) 的 Intent PR)。本清单列出全部
> 读写点,供改动 PR 语义时逐项核对;生成方式为人工 `rg` + 沿调用链复核,不覆盖第三方依赖、
> 构建产物与 `.git`。拆表的事实基础见
> [ADR-0034](../../../architecture/adr/0034-intent-pr-fact-base-and-readpoints.md),
> 拆表与迁移标记的裁决见
> [ADR-0035](../../../architecture/adr/0035-intent-pr-table-split-and-migration-markers.md)。
>
> **分类约定:** `读` = 读取 PR 行用于展示或判断;`写` = 经唯一入口写入;`派生` = 由 PR 行
> 计算展示值(不落库);`门禁` = 读取 PR 行作为幂等/守卫判断。

## 1. 持久化与仓储

- `database/intents/intent_prs.sql`(持久化): 表与索引 DDL(唯一键 + 部分唯一索引)
- `database/infra/schema_migrations.sql`(持久化): 一次性数据迁移标记表 DDL
- `server/src/kernel/infra/db.ts`(持久化): `ensureMigrationsTable` / `hasMigration` / `markMigration`
- `store.ts: SCHEMA`(持久化): 新建库的建表 + 索引
- `store.ts: backfillIntentPrs`(写): 从冻结的旧三列一次性回填(事务 + 标记判定幂等)
- `store.ts: upsertIntentPr`(写): **唯一** PR 写入口;身份冲突到别的意图即抛错
- `store.ts: listIntentPrs / listReviewingIntentPrs`(读): 单意图全部 PR / 仅 `reviewing` 行
- `store.ts: hasIntentPrs`(门禁): 永久删除草稿的守卫:有 PR 行即不可删
- `store.ts: hydrate`(读): 按 workspace 批量取行并挂载到 `Intent.prs`
- `store.ts: deleteIntentRecords`(写): 删除意图的同一事务内清理其 PR 行
- `pr-identity.ts: parsePrIdentity`(派生): 从 PR URL 还原 `forge`/`repo`(回填与三条创建路径共用)
- `scripts/rollback-intent-prs.mjs`(读): 回退:每意图最早一条投影回旧三列;只读 `intent_prs`

`intents` 的 `pr_id`/`pr_url`/`pr_status` 三列**已冻结**:除上面的回填(读)与回退脚本(写旧列)
外,运行时不读不写。

## 2. PR 生命周期

- `git.ts: createForgePr / getForgePrStatus / closeForgePr`: forge CLI 出口,按 provider 路由;不接触意图账本
- `pr-target.ts: resolvePrTarget`(读): 三条建 PR 路径共用的目标解析:关联交付 → 意图 `baseBranch`
- `write-cores.ts: createPrForIntent`(门禁→写): 有活跃 PR 拒绝重建;成功后写入编号、来源、head/base、URL
- `dev-cleanup.ts: runManualDevCleanup`(门禁→写): 手动会话收尾:意图为 `done` 且目标解析成功才建 PR 并写入
- `queue-dev-actions.ts: maybeCreatePr`(门禁→写): 自动化队列:`done` 写入后按目标解析建 PR(未关联则向 `baseBranch`)
- `pr-status-sync.ts: syncIntentPrStatus`(读→写): 遍历该意图全部 `reviewing` 行查 forge,终态落库 + 写意图日志;每次同步收尾都求值一次完成派生
- `pr-merge-completion.ts: completeIntentOnPrsMerged`(读→写): 聚合态为 `merged` 时把 `in_progress` 意图置 `done`;由同步、关联外部 PR、交付解绑三处在写完 PR 行后调用
- `pr-status-sync.ts: depsWithUnconfirmedPr`(读): 依赖意图存在 `reviewing` 行即触发后台补同步
- `write-cores.ts: applyIntentStatusChange`(读→写): 取消意图:遍历全部活跃 PR 逐条关闭,全成功才放行
- `pr-update-consumer.ts: handlePrUpdateEvent`(读→写): `pr:update` 事件把指定行从 `rejected`/`failed`/`closed` 复位
- `pr-events/tool-defs.ts: runServerSidePrCreate`: 发布 `pr:create` 事件;载荷取自创建结果,不读账本

## 3. 闸门与工具

- `dependency-gate.ts: findDependencyBlockingMainline`(门禁): 依赖的**聚合态**为 `merged` 才不阻塞
- `queue-ledger.ts: toFact`(派生): 把 PR 行归约为 `QueueIntentFact.prStatus` 聚合态
- `kernel/queue/reconcile.ts`(门禁): 读 `QueueIntentFact.prStatus`(已是聚合态)
- `pr-status-tool-defs.ts: runSyncIntentPrStatus`: 自动化工具(仅 `intentId`,无状态参数)转调 `syncIntentPrStatus` 触发派生
- `advisor-tools.ts: sync_intent_pr_status`: 顾问工具转调 `syncIntentPrStatus`

## 4. 协议与前端

- `shared/src/protocol/intent.ts`(持久化): `IntentPr` / `IntentPrStatus` / `IntentPrForge` 与 `Intent.prs`
- `shared/src/intent-pr-model.ts`(派生): `deriveIntentPrAggregate` / `activeIntentPrs` / `pickPrimaryIntentPr`,服务端与前端共用
- `shared/src/protocol/intent-messages.ts`(读): `create_pr_response`、`sync_intent_pr_status_response`(其 `prStatus` 为聚合态)
- `web/src/lib/intent-engineering-progress.ts`(派生): 进度条 PR 段读聚合态
- `web/src/lib/intent-list-view.ts`(派生): 依赖阻塞判定(聚合态)+ 行内 create-pr / prLink 可见性
- `IntentOverviewTab.vue`(读): 逐条渲染 PR 行与状态徽标;同步按钮看有无 `reviewing` 行
- `IntentTitleBarActions.vue`(读): 建 PR 按钮按目标 pair 看有无活跃/`merged` PR;主按钮取第一条活跃 PR 跳转/复制;同步按钮同上
- `web/src/pages/automations/templates/index.ts`(读): `PR_STATUS_POLLER_PROMPT` 按 `prs` 描述筛选口径;终态对账指引调用 `mcp__c3__sync_intent_pr_status`
- `web/src/locales/*.json`(读): `intent.prStatus.*` 展示文案

## 5. 测试

夹具与断言集中在:`intent-prs.test.ts`(回填 / 唯一键 / upsert 语义 / URL 解析)、
`shared/src/intent-pr-model.test.ts`(聚合态梯子)、`pr-status-sync.test.ts`、
`cancel-close-pr.test.ts`、`pr-update-consumer.test.ts`、`pr-merge-completion.test.ts`、`create-pr-handler.test.ts`、
`dev-cleanup.test.ts`、`queue-dev-actions.test.ts`,以及前端的
`intent-engineering-progress.test.ts` / `intent-list-view.test.ts` / IntentDetail 组件测试。
`intent-pr-fixture.ts`(server 与 web 各一份)构造 `Intent.prs` 夹具。以旧 schema 为夹具的
迁移断言测试(`rename-intents-migration.test.ts` 等)仍持有旧三列,它们验证的是迁移本身。
