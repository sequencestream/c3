-- schema_migrations — 已完成的一次性数据迁移标记表
-- 所属模块: infra（跨域基础设施，不绑定任何单一 store）
-- 对应 Store: server/src/kernel/infra/db.ts (hasMigration / markMigration)
-- 迁移: migrate/2026/08/06/031-intent_prs.sql
--
-- 为什么需要它: 各 store 既有的幂等手段是列/表存在性检查（`PRAGMA table_info` /
-- `sqlite_master`），只能回答"列或表在不在"，回答不了"表已建好但数据回填尚未完成"
-- 这个中间态；`INSERT OR IGNORE` 也表达不了"这次回填已完成、永不再跑"。
-- 一条标记 = 一次已完成的数据迁移，由迁移自身与其写入放在同一事务内，异常即回滚且
-- 不写标记，下次启动重跑。
--
-- 刻意不启用 `PRAGMA user_version` 作为判定依据: 它是单一整数、各 store 互不共享，
-- 启用即要求全局串行编号，反而制造耦合。intents store 现有的
-- `PRAGMA user_version=SCHEMA_VERSION` 写入保持原样，只是它自己的版本戳。

CREATE TABLE IF NOT EXISTS schema_migrations (
  id          TEXT PRIMARY KEY,   -- 迁移标识（如 'intents.backfill_intent_prs.v1'）
  applied_at  INTEGER NOT NULL    -- 完成时间 (epoch ms)
);
