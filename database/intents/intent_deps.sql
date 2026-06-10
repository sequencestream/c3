-- intent_deps — 意图之间的依赖关系 (多对多)
-- 所属模块: intents
-- 对应 Store: server/src/features/intents/store.ts
-- 存储引擎: SQLite (c3.db)

CREATE TABLE IF NOT EXISTS intent_deps (
  intent_id       TEXT NOT NULL,   -- 意图 ID (外键 → intents.id)
  depends_on_id   TEXT NOT NULL,   -- 被依赖的意图 ID (外键 → intents.id)
  PRIMARY KEY (intent_id, depends_on_id)
);
