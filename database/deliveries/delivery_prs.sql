-- delivery_prs — 交付 PR (「交付分支 → 主线」的变更请求)
-- 所属模块: deliveries
-- 对应 Store: server/src/features/deliveries/store.ts
-- 迁移: migrate/2026/08/07/035-delivery_prs.sql
-- 新建库时由 store.ts 的 SCHEMA 声明, 存量库由迁移补充, 两者 DDL 保持一致。
--
-- 与 intent_prs 分表而非共表: intent_prs 是「意图 → 交付分支」, 喂「集成就绪 N/M」
-- 聚合; 本表是「交付分支 → 主线」, 不参与该聚合。共表会让 integrationAggregate
-- (按 delivery_id 计数) 把交付自己算成一个关联意图, 也让「哪条 PR 表达交付上主线」
-- 无法精确回答; 解除意图关联删 intent_prs 行时, 也绝不能碰本表。
--
-- 幂等: 应用层重试一律先向 forge 查 (head, base) 的开放 PR, 命中即复用落账, 从不
-- 凭本地返回码判定; (delivery_id, base_sha, head_sha) 唯一索引是并发重试的兜底。
-- forge 对同一 (head, base) 只保留一条开放 PR (推新提交是更新同一条而非新开一条),
-- 因此落账按 PR 身份 (forge, repo, number) 就地刷新 SHA, 而不是每个 SHA 对插一行。
--
-- 三类失败分层落在这里: 冲突 → conflict_files + 交付回退 verifying;
-- CI 失败 / 审批不足 → blocked_reason, 交付状态不动 (代码没问题, 等外部条件);
-- 查询失败 → 什么都不写。

CREATE TABLE IF NOT EXISTS delivery_prs (
  id             TEXT PRIMARY KEY,              -- 行唯一标识 (UUID v4)
  delivery_id    TEXT NOT NULL,                 -- 所属交付
  forge          TEXT,                          -- 'github' | 'gitlab'; 来源未知为 NULL
  repo           TEXT,                          -- owner/name; 来源未知为 NULL
  number         TEXT NOT NULL,                 -- 仓内 PR / MR 号
  url            TEXT,                          -- 可点击链接
  head_branch    TEXT NOT NULL,                 -- 交付分支
  base_branch    TEXT NOT NULL,                 -- 主线 (交付的 base_branch 快照)
  base_sha       TEXT NOT NULL,                 -- 最近一次建/同步时的 origin/<base> HEAD
  head_sha       TEXT NOT NULL,                 -- 最近一次建/同步时的 origin/<head> HEAD
  status         TEXT NOT NULL                  -- 沿用意图 PR 口径, 本表只出现三值
                 CHECK(status IN ('reviewing','merged','closed')),
  blocked_reason TEXT                           -- 开放但合并受阻的原因; 无阻塞为 NULL
                 CHECK(blocked_reason IN ('ci_failed','approval')),
  conflict_files TEXT,                          -- JSON 字符串数组; 未枚举到为 NULL
  created_at     INTEGER NOT NULL,              -- 创建时间 (epoch ms)
  updated_at     INTEGER NOT NULL               -- 更新时间 (epoch ms)
);

-- 一条真实 PR 一行 (forge/repo 为 NULL 的行不参与约束, 与 intent_prs 同口径)。
CREATE UNIQUE INDEX IF NOT EXISTS idx_delivery_pr_identity ON delivery_prs(forge, repo, number);
-- 幂等键兜底。
CREATE UNIQUE INDEX IF NOT EXISTS idx_delivery_pr_idempotency
  ON delivery_prs(delivery_id, base_sha, head_sha);
-- 详情页只渲染该交付的最新一行, 旧行留作历史。
CREATE INDEX IF NOT EXISTS idx_delivery_pr_delivery ON delivery_prs(delivery_id, created_at DESC);
