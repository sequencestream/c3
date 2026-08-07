-- 新增 delivery_prs: 交付 PR (「交付分支 → 主线」的变更请求)
--
-- 运行时迁移由 server/src/features/deliveries/store.ts 的 schema ensure 幂等执行
-- (`CREATE TABLE IF NOT EXISTS` + 索引创建), 可重复执行; 从不 DROP。
-- 本文件与 database/deliveries/delivery_prs.sql、store.ts 的 SCHEMA 保持同一 DDL。
--
-- 为什么独立成表而不复用 intent_prs: 两者粒度与生命周期都不同。intent_prs 是
-- 「意图 → 交付分支」, 是「集成就绪 N/M」聚合的数据源, 解除关联时整行删除;
-- 本表是「交付分支 → 主线」, 不参与该聚合, 也不随任何意图关联的生死而变。混在
-- 一张表里, integrationAggregate (按 delivery_id 计数) 会把交付自己算成一个关联
-- 意图, 「哪条 PR 表达交付上主线」这个问题也就再没有精确答案。
--
-- 为什么存 base_sha/head_sha: 它们是幂等键的组成。重试建 PR 一律先向 forge 查
-- (head, base) 的开放 PR, 命中即复用落账, 绝不凭本地返回码判定; 唯一索引
-- (delivery_id, base_sha, head_sha) 是并发重试的最后一道。forge 对同一 (head, base)
-- 只保留一条开放 PR (推新提交更新同一条), 所以落账按 PR 身份就地刷新 SHA。
--
-- 为什么 blocked_reason 与 conflict_files 分开: 三类失败必须分层。冲突意味着代码
-- 要改 (交付回退 verifying, 落 conflict_files); CI 失败 / 审批不足意味着代码没问题、
-- 缺的是外部条件 (交付状态不动, 落 blocked_reason); 查询失败什么都不写。混为一类
-- 会在 CI 失败时白白让用户重做一遍验证。
--
-- 存量无数据回填: 交付 PR 是新实体, 未建过 PR 的既有交付不受影响。
CREATE TABLE IF NOT EXISTS delivery_prs (
  id             TEXT PRIMARY KEY,
  delivery_id    TEXT NOT NULL,
  forge          TEXT,
  repo           TEXT,
  number         TEXT NOT NULL,
  url            TEXT,
  head_branch    TEXT NOT NULL,
  base_branch    TEXT NOT NULL,
  base_sha       TEXT NOT NULL,
  head_sha       TEXT NOT NULL,
  status         TEXT NOT NULL CHECK(status IN ('reviewing','merged','closed')),
  blocked_reason TEXT CHECK(blocked_reason IN ('ci_failed','approval')),
  conflict_files TEXT,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_delivery_pr_identity ON delivery_prs(forge, repo, number);
CREATE UNIQUE INDEX IF NOT EXISTS idx_delivery_pr_idempotency
  ON delivery_prs(delivery_id, base_sha, head_sha);
CREATE INDEX IF NOT EXISTS idx_delivery_pr_delivery ON delivery_prs(delivery_id, created_at DESC);
