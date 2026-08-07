-- intent_prs — 意图的 PR/MR 关系表（一个意图对不同交付各持有一条 PR）
-- 所属模块: intents
-- 对应 Store: server/src/features/intents/store.ts
-- 迁移: migrate/2026/08/06/031-intent_prs.sql (v19→v20)
-- 新建库时由 store.ts 的 SCHEMA 声明, 存量库由迁移补充, 两者 DDL 保持一致。
--
-- 取代 intents 表的 pr_id / pr_url / pr_status 三列平铺模型（三列冻结、从不 DROP，
-- 只作为反向回填脚本的落点）。写入唯一经 store.ts 的 upsertIntentPr。
--
-- forge / repo 可空: 从旧三列回填时若 pr_url 缺失或形态异常则解析不出来源，写 NULL
-- 表示"来源未知"，唯一键对这些行天然不生效，是可接受的降级；后续任何一次经
-- upsertIntentPr 的写入都会补齐。

CREATE TABLE IF NOT EXISTS intent_prs (
  id            TEXT PRIMARY KEY,   -- UUID
  intent_id     TEXT NOT NULL,      -- 所属意图 id（本库不建 FK，与既有表一致）
  delivery_id   TEXT,               -- 归属交付（PR 的 base 即该交付分支）；NULL = 提向主线
  forge         TEXT,               -- 'github' | 'gitlab'；来源未知时为 NULL
  repo          TEXT,               -- 仓库标识 owner/name；来源未知时为 NULL
  number        TEXT NOT NULL,      -- 仓库内 PR/MR 编号（即旧 pr_id 的值）
  url           TEXT,               -- 可跳转链接
  status        TEXT NOT NULL,      -- 'reviewing'|'rejected'|'failed'|'merged'|'closed'
  head_branch   TEXT,               -- 源分支（每行独立记录，不依赖全局假定）
  base_branch   TEXT,               -- 目标分支（每行独立记录）
  created_at    INTEGER NOT NULL,   -- 创建时间 (epoch ms)
  updated_at    INTEGER NOT NULL    -- 最后更新时间 (epoch ms)
);

-- 一条真实 PR 在库里只能有一行（forge/repo 为 NULL 的降级行不受约束）。
CREATE UNIQUE INDEX IF NOT EXISTS idx_intent_pr_identity ON intent_prs(forge, repo, number);
-- 一个意图对同一交付只能有一条 PR —— 这一对也是建 PR 的业务幂等键。
CREATE UNIQUE INDEX IF NOT EXISTS idx_intent_pr_delivery ON intent_prs(intent_id, delivery_id);
-- SQLite（与标准 SQL 一致）在唯一索引中视 NULL 互不相等，故上面那条约束不到提向主线的行，
-- 补一条部分唯一索引兜住"每意图至多一条无交付归属的 PR"。
CREATE UNIQUE INDEX IF NOT EXISTS idx_intent_pr_intent_nodelivery
  ON intent_prs(intent_id) WHERE delivery_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_intent_pr_intent ON intent_prs(intent_id);
CREATE INDEX IF NOT EXISTS idx_intent_pr_status ON intent_prs(status);
