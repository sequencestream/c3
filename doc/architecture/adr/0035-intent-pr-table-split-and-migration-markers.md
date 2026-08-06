# 0035 — PR 拆表为 `intent_prs`(硬切、无双写)+ `schema_migrations` 迁移标记表

- **Status:** accepted
- **Date:** 2026-08-06

## Context

PR 事实平铺在 `intents` 的 `pr_id`/`pr_url`/`pr_status` 三列里,结构上只能表达"一个意图
一条 PR"。交付能力要求同一意图对不同 base 各持有一条 PR,三列模型装不下;继续在旧模型上
迭代,只会让每一处 PR 读写再长一层补丁。

拆表的事实基础(`pr_id` 即仓库内 number、时间戳为 `INTEGER` epoch-ms 且存量有 10 位
epoch-秒异常行、存量 base 全为字面 `main`、`forge`/`repo` 当前都不落库)已在
[ADR-0034](0034-intent-pr-fact-base-and-readpoints.md) 固化并可复核。其中 **GitLab 侧的
多 base 行为仍未在认证环境实测** —— 该结论不影响本决策(唯一键按 number 成立与否只取决于
`pr_id` 语义,已证实),但不得据此宣称两端等同。

## Decision

**PR 是独立关系表 `intent_prs`,不是意图上的字段。** 表结构与索引见
[database/intents/intent_prs.sql](../../../database/intents/intent_prs.sql)。三条唯一性
约束各司其职:`UNIQUE(forge, repo, number)` 是 PR 的真实身份;
`UNIQUE(intent_id, delivery_id)` 是"一意图一交付至多一条";而 `delivery_id` 可空,SQLite
(与标准 SQL 一致)在唯一索引中视 NULL 互不相等,故补部分唯一索引
`UNIQUE(intent_id) WHERE delivery_id IS NULL` —— 没有它,无交付归属的行完全不受约束。
备选的空串哨兵被否决:那会让"无交付归属"在后续交付阶段变成需要专门处理的魔法值。

**硬切,不双写。** 所有读写点一次性切到新表,不保留兼容读路径,线上模型也不留派生的
`prId`/`prUrl`/`prStatus`。双写会让两个事实源长期共存并静默漂移;保留派生字段等于制造
第二条读路径,与"读点全切"直接冲突。代价是切换瞬间任何遗漏的读点立即暴露 —— 这正是防线
所在:从线上模型删除三字段后,遗漏点在 `pnpm typecheck` 处编译失败,而不是运行期静默降级。

**写入收敛到唯一入口 `upsertIntentPr`。** 仓储层不再暴露 `setPrInfo`/`setPrStatus`,任何
位置不得直接 `UPDATE` PR 字段。它是事务内的 look-up-then-write 而非 `ON CONFLICT`——两个
唯一键无法用单条 upsert 语句同时承接。命中 `(forge, repo, number)` 但归属另一个意图时
**抛错**:一条真实 PR 被静默改挂到别的意图上是数据事故,不是便利。

**无来源的 PR 写入口一律删除,而非改造。** `set_intent_git_info` 的 `prId`/`prStatus` 字段
下线(本仓零调用方),MCP `save_intent_pr_info` 收紧为"只更新既有 PR 行,无行即拒绝"。这两个
入口只拿得到编号和状态,拿不到 forge/repo/URL —— 保留它们就是保留唯一一条能造出无来源
PR 行的通道,与唯一键设计自相矛盾。后果需知情:此后不存在"手工把一条已有 PR 关联到意图"的
入口;真要重新提供,应作为独立能力设计成带来源的显式关联。

**状态判定从意图摘到 PR 行。** PR 有它自己的生命周期:同步的闸门是"该行是否 `reviewing`",
与意图处于 `todo`/`in_progress`/`done` 无关。需要"一个意图的 PR 到底怎么样了"这一个答案的
读点(闸门、进度条、队列事实)统一用共享纯函数 `deriveIntentPrAggregate` 归约,服务端与
前端**共用同一份**规则,杜绝两侧漂移。

**一次性数据迁移由 `schema_migrations` 标记表判定,不启用 `PRAGMA user_version`。**
列/表存在性检查只能回答"列在不在",回答不了"表已建好但回填尚未完成"这个中间态;
`INSERT OR IGNORE` 也表达不了"这次回填已完成、永不再跑"。`user_version` 是各 store 共享的
单一整数,用它做判定即要求全局串行编号,反而制造跨域耦合;各 store 自己的版本戳保持原样,
不参与此判定。回填与其标记写入必须在**同一事务**内 —— 回滚才能把标记一并带走,不存在
"回填一半且被标记为已完成"的状态。

**旧三列冻结但从不 DROP。** 它们是回退路径的前提。

## Consequences

- **回退路径。** `scripts/rollback-intent-prs.mjs` 从 `intent_prs` 取每意图**最早一条**
  (按 `created_at`,同值以 `number` 升序定序)写回旧三列。因旧三列从未被删除、也从未被本次
  改动改写,回退即"把新表的事实投影回旧列 + 部署回旧版本"。脚本可重复执行,且**只读**
  `intent_prs`,绝不修改新表。发布前先导出一次 `~/.c3/c3.db` 备份。
- **契约破坏。** 线上模型 `Intent` 的三字段变为 `prs: IntentPr[]`;WS 消息
  `set_intent_git_info` 删除 PR 字段;MCP `find_intents`/`view_intent` 的输出随之变化,
  这是面向 agent 的契约变更,内置自动化模板文案同步改写。本地单体应用前后端同版本发布,
  不需要过渡期。
- **未知来源行。** `forge`/`repo` 为 NULL 的回填行不参与唯一键,理论上可与后来写入的同名
  PR 产生重复行。实际触发需要"存量 PR 无 URL"且"同一 PR 被再次写入"同时成立,且下一次
  upsert 即会补齐。接受该风险,不为它加额外的清理逻辑。
