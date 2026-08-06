# 0034 — intents PR 拆表的事实基础:时间戳编码 / pr_id 语义 / 存量 base / 多 base 行为

- **Status:** accepted
- **Date:** 2026-08-06

## Context

M1 将单条意图上的 `pr_id/pr_url/pr_status` 拆为多 PR 关系(`intent_prs`)。拆表、回填
SQL 与唯一键必须建立在可复核的现状事实上,而不是字段名、DDL 注释或口头清单。核查结论
(证据见读点清单
[../../domains/core/intent-management/intent-management-pr-readpoints.md] 与验证脚本
`scripts/verify-multi-base-pr.mjs`):

- **时间戳编码。** `intents.created_at/updated_at/completed_at` 以 SQLite `INTEGER`
  存 epoch-ms,受控写入一律 `Date.now()`。存量存在少量 10 位 epoch-秒异常行(由外部批量
  导入产生,仓库内写路径不可能产生 10 位值),回填需归一化。
- **`pr_id` 语义。** `pr_id` = 仓库(project)内 PR/MR number:创建 PR 的 CLI 输出
  (`gh pr create` 的 `/pull/<n>`、`glab mr create` 的 `/merge_requests/<n>`)提取 number,
  `setPrInfo` 原样落库;存量非空 `pr_id` 全部为纯 ASCII 数字,且与 `pr_url` 尾部 `<N>`
  一一对应。
- **存量 base。** 全部可核查的真实 PR base 均为字面 `main`,head 均为 `intent/<slug>` 形态。
- **多 base 行为。** GitHub 允许同一 head 对两个不同 base 同时保持开放 PR(脚本在隔离
  测试仓库实测);GitLab 本机 glab 未认证,结论留待认证后在同一脚本下补验。
- **`pr_status` 取值域。** 运行时为 `reviewing|rejected|failed|merged|closed`;DDL 注释
  (`database/intents/intents.sql`)缺 `'closed'`。
- **用户手填日期。** `start_date/end_date/startDate/endDate` 全库零命中,当前模型与 M1
  目标模型均无此类字段,非 M1 设计字段。

## Decision

- **时间戳:** `intent_prs` 目标时间戳沿用 `INTEGER` epoch-ms(列名 `_at` 后缀),不引入
  ISO-8601 TEXT;回填对 10 位 epoch-秒异常行归一化到 epoch-ms。
- **唯一键:** `UNIQUE(forge, repo, number)` 成立,`number` 即当前 `pr_id` 的值。若未来
  出现非 number 语义,改判 `UNIQUE(forge, repo, forge_pr_id)` —— `forge_pr_id` 原样保存
  forge 标识,`number` 由 API/URL 独立取得且不得冒充唯一键。
- **`forge`/`repo` 显式落库。** 两者当前不落库(`detectForge` 按 git origin 实时判定,
  `repo` 从 `pr_url` 或 origin 解析);`intent_prs` 建表时必须显式持久化,唯一键才有意义。
- **base 每行独立记录。** 存量回填可假定 base=`main`;新能力引入非 main base 后该假定
  失效,故 `intent_prs` 每行独立记录 base,不依赖全局假定。
- **修正 DDL 注释:** `pr_status` 注释补 `'closed'`,取值域与共享协议类型一致。

## Consequences

- 回填 SQL 需处理:10 位 epoch-秒异常行的归一化、`pr_status` 与 forge 真实状态的漂移、
  以及 `pr_status='merged'` 但无 `pr_id` 的行(无法按 `pr_id` 关联 PR)。
- GitLab 线上样本未证实:唯一键对 GitLab 的成立目前依赖代码路径与单元测试,回填 SQL
  落地前需在认证环境补验,不得据此宣称两端均支持。
- 多 base 行为结论可由脚本复验(`node scripts/verify-multi-base-pr.mjs ...`),换 CLI
  版本后仍可重跑,不依赖一次性人工手测。

## References

- `scripts/verify-multi-base-pr.mjs` — 多 base 建 PR 可重跑验证脚本
- `doc/domains/core/intent-management/intent-management-pr-readpoints.md` — PR 三字段读写点
