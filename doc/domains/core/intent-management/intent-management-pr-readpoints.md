# intent-management — PR 三字段读写点

> `pr_id/pr_url/pr_status`(SQLite 列,snake_case)与 `prId/prUrl/prStatus`(领域模型
> 字段,camelCase)是同一事实的两面。本清单列出这些字段的当前读写点,供拆表迁移逐项核对;
> 生成方式为人工 `rg` + 沿调用链复核,不覆盖第三方依赖、构建产物与 `.git`。来源事实核查
> 与设计裁决见 [ADR-0034](../../../architecture/adr/0034-intent-pr-fact-base-and-readpoints.md)。
>
> **字段语义(已证实):** `prId` = 仓库内 PR/MR **number**(GitHub 与 GitLab 一致,纯数字);
> `prUrl` = 可跳转链接;`prStatus` = 生命周期状态,运行时取值域
> `'reviewing'|'rejected'|'failed'|'merged'|'closed'`。
>
> **分类约定:** `读`= 从持久化字段读取用于展示或判断;`写`= 把值写入持久化字段;
> `派生`= 由字段计算其它展示值(不落库);`门禁`= 读取字段作为幂等/守卫判断。

## 1. 持久化与迁移

| 文件:符号                                      | 字段                         | 分类   | 用途                                                                 |
| ---------------------------------------------- | ---------------------------- | ------ | -------------------------------------------------------------------- |
| `database/intents/intents.sql:20-22`           | `pr_id`/`pr_url`/`pr_status` | 持久化 | 三列 DDL 定义                                                        |
| `database/migrate/2026/06/20/016-intents.sql`  | `pr_url`                     | 持久化 | `pr_url` 迁移记录(实际由 store 幂等守卫执行)                         |
| `server/src/features/intents/store.ts:320-321` | `pr_id`/`pr_status`          | 持久化 | schema 初始化 `ensureColumn('intents','pr_id','TEXT')` / `pr_status` |
| `server/src/features/intents/store.ts:340`     | `pr_url`                     | 持久化 | schema 初始化 `ensureColumn('intents','pr_url','TEXT')`              |
| `database/tables.md:41`                        | `pr_id`/`pr_url`/`pr_status` | 持久化 | Schema 版本史与 Git 追踪字段说明                                     |

## 2. store 映射与写入

| 文件:符号                                          | 字段                                      | 分类   | 用途                                                             |
| -------------------------------------------------- | ----------------------------------------- | ------ | ---------------------------------------------------------------- |
| `server/src/features/intents/store.ts:62-63,78-80` | `pr_id`/`pr_status`/`created_at` 等       | 持久化 | `Row` 接口的列定义                                               |
| `server/src/features/intents/store.ts:426-428`     | `pr_id`/`pr_url`/`pr_status`              | 持久化 | `IntentRow` 类型三字段声明                                       |
| `server/src/features/intents/store.ts:514-516`     | `prId`/`prUrl`/`prStatus`                 | 读     | `hydrate()` 行映射:`prId: r.pr_id, prUrl: r.pr_url, prStatus`    |
| `server/src/features/intents/store.ts:1136-1139`   | `pr_status`+`updated_at`                  | 写     | `setPrStatus()`:只写状态                                         |
| `server/src/features/intents/store.ts:1179-1194`   | `pr_id`+`pr_status`+`pr_url`+`updated_at` | 写     | `setPrInfo()`:三字段同写(PR 创建/取消收尾唯一写入边界)           |
| `server/src/features/intents/store.ts:1061`        | `pr_id`                                   | 门禁   | 永久删除守卫:`row.pr_id === null` 才允许删除(有 PR 的意图不可删) |

## 3. PR 创建 / 同步 / 关闭

| 文件:符号                                                  | 字段                      | 分类  | 用途                                                                                |
| ---------------------------------------------------------- | ------------------------- | ----- | ----------------------------------------------------------------------------------- |
| `server/src/git.ts:655-693`                                | `prId`                    | 写    | `createGhPr()`:解析 `gh pr create` 输出 `/pull/(\d+)$` 得 number;base 默认 `'main'` |
| `server/src/git.ts:700-740`                                | `prId`                    | 写    | `createGlabMr()`:解析 `glab mr create` 输出 `/merge_requests/(\d+)` 得 number       |
| `server/src/git.ts:746-758`                                | —                         | 派生  | `createForgePr()`:按 forge 路由创建                                                 |
| `server/src/git.ts:801-822,824-839,841-848`                | `prStatus`                | 读    | `getGhPrStatus`/`getGlabMrStatus`/`getForgePrStatus`:远端查状态                     |
| `server/src/git.ts:872-887,893-908,915-922`                | `prId`                    | 写    | `closeGhPr`/`closeGlabMr`/`closeForgePr`:关 PR/MR                                   |
| `server/src/features/intents/write-cores.ts:118`           | `prId`                    | 门禁  | `createPrForIntent()` 幂等守卫:已有 `prId` 拒绝重建                                 |
| `server/src/features/intents/write-cores.ts:179-180`       | `prId`/`prUrl`/`prStatus` | 写    | 手动 create_pr 成功后 `setPrInfo(...,'reviewing',prUrl)` + `pr_created` 日志        |
| `server/src/features/intents/write-cores.ts:184-193`       | `prId`/`prUrl`            | 写    | `runServerSidePrCreate()` 发布 pr:create 事件;返回帧带 `prId`/`prUrl`               |
| `server/src/features/intents/write-cores.ts:257-272`       | `prId`/`prUrl`/`prStatus` | 写    | 意图取消:`closeForgePr` + `setPrInfo(...,'closed',prUrl)`                           |
| `server/src/features/intents/dev-cleanup.ts:191`           | `prId`                    | 门禁  | 手动 Start Dev 收尾:已有 `prId` 跳过重建                                            |
| `server/src/features/intents/dev-cleanup.ts:199-216`       | `prId`/`prUrl`/`prStatus` | 写    | 收尾 `createForgePr` + `setPrInfo(...,'reviewing',...)`                             |
| `server/src/features/intents/dev-cleanup.ts:221-231`       | `prId`/`prUrl`            | 写    | 收尾 `runServerSidePrCreate` 发布事件                                               |
| `server/src/features/intents/queue-dev-actions.ts:388-420` | `prId`/`prUrl`/`prStatus` | 写    | 自动化 `maybeCreatePr()`:`createPrForIntent` + `setPrInfo`                          |
| `server/src/features/intents/queue-dev-actions.ts:422-447` | `prId`/`prUrl`            | 读/写 | 队列 `createPrForIntent()`:调 `createForgePr` 并回传 number/URL                     |
| `server/src/features/intents/pr-status-sync.ts:17-43`      | `prId`/`prStatus`         | 门禁  | `isSyncable()`/`notSyncableResult()`:仅 `done`+`prId`+`reviewing` 可同步            |
| `server/src/features/intents/pr-status-sync.ts:62-95`      | `prId`/`prStatus`         | 读→写 | `syncIntentPrStatus()`:读 `prId` → `getForgePrStatus` → 终态 `setPrStatus`          |
| `server/src/features/intents/pr-status-sync.ts:106-144`    | `prId`/`prStatus`         | 读    | `depsWithUnconfirmedPr()`/`syncUnconfirmedDependencyPrsInBackground()`              |
| `server/src/features/intents/index.ts:1259-1273`           | `prId`/`prStatus`         | 写    | `setIntentGitInfo` handler:`set_pr_info` 经 `setPrInfo` 写入                        |
| `server/src/features/intents/index.ts:1429-1477`           | `prId`/`prUrl`            | 写    | `createPrHandler`:调 `createPrForIntent`,回 `create_pr_response` 帧                 |
| `server/src/features/intents/index.ts:1501-1533`           | `prStatus`                | 写    | `syncIntentPrStatusHandler`:回 `sync_intent_pr_status_response`                     |
| `server/src/features/pr-events/tool-defs.ts:393-425`       | `prId`/`prUrl`            | 读    | `ServerSidePrCreateInput` + `runServerSidePrCreate` 事件载荷                        |

## 4. 队列与事件消费

| 文件:符号                                                     | 字段                      | 分类   | 用途                                                                                        |
| ------------------------------------------------------------- | ------------------------- | ------ | ------------------------------------------------------------------------------------------- |
| `server/src/features/intents/pr-update-consumer.ts:27,59-102` | `prStatus`                | 读→写  | `handlePrUpdateEvent()`:`rejected/failed/closed` 复位 `reviewing`(`RESETTABLE_PR_STATUSES`) |
| `server/src/features/intents/pr-update-consumer.ts:82-83`     | `prStatus`                | 写     | 事件消费 `setPrStatus(intent.id,'reviewing')`                                               |
| `server/src/kernel/queue/reconcile.ts:261`                    | `prStatus`                | 门禁   | worktree 依赖门:`dep.prStatus !== 'merged'` 阻塞(`blocked_dependency_pr_unmerged`)          |
| `server/src/kernel/queue/reconcile.ts:307`                    | `prStatus`                | 读     | 未合并依赖收集 `unmergedDepIds`                                                             |
| `server/src/features/intents/queue-ledger.ts:47`              | `prStatus`                | 读     | `toFact()` 投影到 `QueueIntentFact`                                                         |
| `server/src/kernel/queue/types.ts:83`                         | `prStatus`                | 持久化 | `QueueIntentFact.prStatus` 类型声明                                                         |
| `server/src/features/intents/dependency-gate.ts:34`           | `prStatus`                | 门禁   | 依赖已合并(`==='merged'`)不视为阻塞                                                         |
| `server/src/features/intents/tool-defs.ts:129-133,142`        | `prStatus`                | 读     | MCP `save_intent_pr_info` schema(枚举含 `'closed'`)                                         |
| `server/src/features/intents/tool-defs.ts:286`                | `prStatus`                | 写     | MCP `save_intent_pr_info` → `setPrStatus(intent.id, args.prStatus)`                         |
| `server/src/features/intents/advisor-tools.ts:572-584`        | `prId`/`prUrl`/`prStatus` | 读     | 顾问工具 `sync_intent_pr_status`:同步后回传 `prId`/`prUrl`                                  |
| `server/src/features/intents/advisor-validate.ts:49,87`       | —                         | 读     | 顾问工具名单含 `sync_intent_pr_status`                                                      |
| `server/src/features/register.ts:206`                         | —                         | 读     | WS 消息 `sync_intent_pr_status` 注册                                                        |
| `server/src/wiring/run-domain-subscriptions.ts:209`           | —                         | 读     | 运行域订阅注入 `setPrInfo` 依赖                                                             |
| `server/src/features/intents/session-launcher.ts:171`         | `pr_status`               | 注释   | 说明性注释(启动后同步过期 `pr_status`)                                                      |

## 5. 协议投影与 UI 派生

| 文件:符号                                                                               | 字段                      | 分类   | 用途                                                                          |
| --------------------------------------------------------------------------------------- | ------------------------- | ------ | ----------------------------------------------------------------------------- |
| `shared/src/protocol/intent.ts:100`                                                     | —                         | 持久化 | `IntentPrStatus = 'reviewing'\|'rejected'\|'failed'\|'merged'\|'closed'` 类型 |
| `shared/src/protocol/intent.ts:435-439`                                                 | `prId`/`prUrl`/`prStatus` | 持久化 | `Intent` 模型三字段                                                           |
| `shared/src/protocol/intent-messages.ts:299-300`                                        | `prId?`/`prStatus?`       | 写     | `ClientUpdateIntent` 可选字段(`update_intent` 消息)                           |
| `shared/src/protocol/intent-messages.ts:350`                                            | —                         | 写     | `ClientCreatePr`(手动 `create_pr`)                                            |
| `shared/src/protocol/intent-messages.ts:362`                                            | —                         | 写     | `ClientSyncIntentPrStatus`                                                    |
| `shared/src/protocol/intent-messages.ts:466-478`                                        | `prId`/`prUrl`            | 读     | `create_pr_response` 帧                                                       |
| `shared/src/protocol/intent-messages.ts:499-508`                                        | `prStatus?`               | 读     | `sync_intent_pr_status_response` 帧                                           |
| `web/src/lib/intent-engineering-progress.ts:12-13,51,65-67`                             | `prId`/`prStatus`         | 派生   | 工程进度投影:PR 阶段 gate / merged 完成 / 关闭判定                            |
| `web/src/lib/intent-list-view.ts:152,161,182-183`                                       | `prStatus`/`prId`         | 派生   | 依赖阻塞判定 + 行内 create-pr / PR 链接可见性                                 |
| `web/src/pages/intents/components/IntentDetail/IntentOverviewTab.vue:46-66`             | `prStatus`                | 派生   | `PR_STATUS_OPTIONS`/`prStatusLabel`/`canSyncPrStatus`                         |
| `web/src/pages/intents/components/IntentDetail/IntentOverviewTab.vue:222-238`           | `prId`/`prUrl`/`prStatus` | 读     | PR 行/链接/状态徽标渲染                                                       |
| `web/src/pages/intents/components/IntentDetail/IntentTitleBarActions.vue:62-79,182-197` | `prId`/`prUrl`/`prStatus` | 读     | 主按钮 PR 跳转 / 复制 prId / `canSyncPrStatus`                                |
| `web/src/pages/automations/templates/index.ts:34-36`                                    | `prStatus`/`prUrl`/`prId` | 读     | `PR_STATUS_POLLER_PROMPT` 自动化模板文本                                      |
| `web/src/controls/message-handler.ts:655`                                               | —                         | 读     | `sync_intent_pr_status_response` 分发(不读三字段本身)                         |
| `web/src/controls/intent-actions.ts:346`                                                | —                         | 写     | 发送 `sync_intent_pr_status` 请求                                             |
| `web/src/locales/{en,zh,ja,ko,ru}.json:923-924`                                         | —                         | 读     | `intent.prStatus.*` i18n 文案                                                 |

## 6. 测试与文档

测试夹具(`fixture`)与迁移断言(`migration`)中的三字段引用是迁移验证项而非运行时读点,拆表
后应随之更新断言;按文件列举,同模式重复仅记首行并注 `×N`:

| 文件:符号                                                                                                                                                                                                                                                                                 | 类别              | 说明                                                  |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- | ----------------------------------------------------- |
| `server/src/features/intents/store.test.ts:174,420,469-476,497-530`                                                                                                                                                                                                                       | fixture/migration | schema 夹具、迁移断言、setPrInfo round-trip           |
| `server/src/features/intents/pr-url-migration.test.ts:45-100`                                                                                                                                                                                                                             | migration         | 加 `pr_url` 迁移全断言                                |
| `server/src/features/intents/spec-status-migration.test.ts:51`                                                                                                                                                                                                                            | migration         | 旧 schema 夹具含 pr 三列                              |
| `server/src/features/intents/rename-intents-migration.test.ts:137-138`                                                                                                                                                                                                                    | migration         | 终端 schema 断言 `pr_id`/`pr_status` 列               |
| `server/src/features/intents/rename-workspace-path-migration.test.ts:72,90`                                                                                                                                                                                                               | migration         | 旧 schema 夹具                                        |
| `server/src/features/intents/dev-cleanup.test.ts:44-45,103,163-164,279`                                                                                                                                                                                                                   | fixture           | createForgePr mock 与幂等重清理夹具                   |
| `server/src/features/intents/create-pr-handler.test.ts:161-200,353,647`                                                                                                                                                                                                                   | fixture           | createGhPr mock / 响应帧 / 幂等守卫断言               |
| `server/src/features/intents/cancel-close-pr.test.ts:107-158`                                                                                                                                                                                                                             | fixture           | 取消关闭 PR 断言(`pr_status`→closed)                  |
| `server/src/features/intents/queue-dev-actions.test.ts:223-225,430,479-480`                                                                                                                                                                                                               | fixture           | 队列建 PR 夹具                                        |
| `server/src/features/intents/pr-status-sync.test.ts:77-124`                                                                                                                                                                                                                               | fixture           | sync 合并/关闭/失败断言                               |
| `server/src/features/intents/pr-update-consumer.test.ts:20,70-182`                                                                                                                                                                                                                        | fixture           | 复位事件参数化用例                                    |
| `server/src/features/intents/intent-logs-instrumentation.test.ts:248-407`                                                                                                                                                                                                                 | fixture           | 首次关联 / 空 prId / prStatus-only 日志规则           |
| `server/src/features/intents/workflow.test.ts:262-264,304-353,474-595`                                                                                                                                                                                                                    | fixture           | 依赖 PR 状态门控                                      |
| `server/src/features/intents/action-descriptor.test.ts:74-76,409,438-449`                                                                                                                                                                                                                 | fixture           | makeIntent 夹具 + merged/reviewing 依赖               |
| `server/src/features/intents/dependency-gate.test.ts:62-64,93`                                                                                                                                                                                                                            | fixture           | merged 依赖不阻塞                                     |
| `server/src/kernel/queue/reconcile.test.ts:33,182,267`                                                                                                                                                                                                                                    | fixture           | worktree 依赖 PR 门控                                 |
| `server/src/features/pr-events/pr-compat.integration.test.ts:130-181`                                                                                                                                                                                                                     | fixture           | `runServerSidePrCreate` 入参/断言                     |
| `server/src/wiring/run-domain-subscriptions.test.ts:104`                                                                                                                                                                                                                                  | fixture           | createGhPr mock                                       |
| `server/src/git.test.ts:293-378`                                                                                                                                                                                                                                                          | fixture           | createGlabMr / getGhPrStatus / getGlabMrStatus 期望值 |
| `shared/src/protocol.test.ts:376-384`                                                                                                                                                                                                                                                     | fixture           | `create_pr_response` 消息往返                         |
| `server/src/features/intents/queue-outcome-actions.test.ts:214` `run-status.test.ts:68` `reconcile.test.ts:31` `vendor-block.test.ts:68` `upsert-approval-revoke.test.ts:333` `judge.test.ts:56` `fast-spec.test.ts:57` `advisor-tools.test.ts:135,159` `advisor-validate.test.ts:94,234` | fixture           | makeIntent 基础夹具 trio / 工具名单断言               |
| `database/tables.md` / `doc/domains/core/intent-management/intent-management-{models,design,spec}.md`                                                                                                                                                                                     | 文档              | 领域文档中的三字段描述                                |

> 数据质量观察(存量 `pr_status` 与 forge 真实状态漂移、`pr_status='merged'` 但无 `pr_id`
> 的行等)与回填处理见 [ADR-0034](../../../architecture/adr/0034-intent-pr-fact-base-and-readpoints.md)。
