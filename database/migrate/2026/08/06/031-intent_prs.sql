-- PR 数据拆表：intents 的 pr_id / pr_url / pr_status 三列 → 独立关系表 intent_prs
-- 附带新增跨域的一次性迁移标记表 schema_migrations。
--
-- 运行时迁移由 server/src/features/intents/store.ts 的 schema ensure 幂等执行
-- (建表 + 以 schema_migrations 标记判定的一次性回填)，可重复执行；从不 DROP。
-- SCHEMA_VERSION v19 → v20。
--
-- 为什么拆表：PR 事实平铺在三列里，结构上只能表达"一个意图一条 PR"。交付能力要求同一
-- 意图对不同 base 各持有一条 PR，三列模型装不下；继续在旧模型上迭代只会让每一处 PR
-- 读写再长一层补丁。本次把 PR 提升为独立关系表，一次性把全部读写点切到新表，
-- **不双写、不保留兼容读路径**（裁决见 ADR-0035）。
--
-- 旧三列的处置：冻结但**从不 DROP**。运行时不再读写它们，它们是反向回填脚本
-- (`scripts/rollback-intent-prs.mjs`) 唯一的落点，也是回退路径的前提。
--
-- 唯一性约束：
--   UNIQUE(forge, repo, number)              一条真实 PR 在库里只能有一行
--   UNIQUE(intent_id, delivery_id)           一个意图对同一交付只能有一条 PR
--   UNIQUE(intent_id) WHERE delivery_id IS NULL
--     SQLite（与标准 SQL 一致）在唯一索引中视 NULL 互不相等，而 delivery_id 当前恒为
--     NULL，仅靠上一条完全约束不到任何一行，故补这条部分唯一索引兜住"每意图至多一条
--     无交付归属的 PR"。备选的空串哨兵会让"无交付归属"在后续交付阶段变成需要专门处理
--     的魔法值，故不取。
--
-- 一次性回填规则（事务内，标记 id = 'intents.backfill_intent_prs.v1'）：
--   选行   pr_id IS NOT NULL AND TRIM(pr_id) <> ''
--          （pr_status='merged' 但无 pr_id 的存量行没有 PR 身份，无法回填；这些行今天
--            在 UI 上的 PR 段本就按"无 PR"渲染，不构成行为回退）
--   映射   number ← pr_id;  url ← pr_url;  head_branch ← branch_name;
--          base_branch ← 'main'（存量结论，见 ADR-0034）;
--          created_at/updated_at ← intents.updated_at，10 位 epoch-秒行 ×1000 归一化
--   forge/repo  从 pr_url 解析（host 含 github.com → github，其余 → gitlab；路径中
--          /pull/<n> 或 /-/merge_requests/<n> 之前的段即 repo）。解析不出时写 NULL，
--          含义是"来源未知"，唯一键对这些行天然不生效；后续任何一次 upsert 都会补齐
--   status 取旧 pr_status；为空或不在取值域内时落 'reviewing'——行存在即证明 PR 存在，
--          用可同步的非终态承接，由一次状态同步纠正，而不是丢弃这条 PR

-- 跨域一次性迁移标记表：一条标记 = 一次已完成的数据迁移。列存在性检查回答不了
-- "表已建、回填未完成"的中间态，INSERT OR IGNORE 也表达不了"永不再跑"。
CREATE TABLE IF NOT EXISTS schema_migrations (
  id          TEXT PRIMARY KEY,
  applied_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS intent_prs (
  id            TEXT PRIMARY KEY,
  intent_id     TEXT NOT NULL,
  delivery_id   TEXT,
  forge         TEXT,
  repo          TEXT,
  number        TEXT NOT NULL,
  url           TEXT,
  status        TEXT NOT NULL,
  head_branch   TEXT,
  base_branch   TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_intent_pr_identity ON intent_prs(forge, repo, number);
CREATE UNIQUE INDEX IF NOT EXISTS idx_intent_pr_delivery ON intent_prs(intent_id, delivery_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_intent_pr_intent_nodelivery
  ON intent_prs(intent_id) WHERE delivery_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_intent_pr_intent ON intent_prs(intent_id);
CREATE INDEX IF NOT EXISTS idx_intent_pr_status ON intent_prs(status);

-- 回填由 store.ts 在单事务内执行（forge/repo 需按 URL 解析，纯 SQL 表达不便），
-- 完成后写入标记；异常即回滚且不写标记，下次启动重跑。等价的标记写入为：
--   INSERT INTO schema_migrations (id, applied_at)
--   VALUES ('intents.backfill_intent_prs.v1', <epoch-ms>);
