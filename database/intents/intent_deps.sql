-- intent_deps — 意图之间的依赖关系 (多对多)
-- dep_type: blocks (硬依赖) / informs (知识依赖) / soft_after (软时序)
-- 所属模块: intents
-- 对应 Store: server/src/features/intents/store.ts


CREATE TABLE IF NOT EXISTS intent_deps (
  intent_id       TEXT NOT NULL,   -- 意图 ID (外键 → intents.id)
  depends_on_id   TEXT NOT NULL,   -- 被依赖的意图 ID (外键 → intents.id)
  dep_type        TEXT NOT NULL DEFAULT 'blocks' CHECK(dep_type IN ('blocks','informs','soft_after')),
  created_at      INTEGER NOT NULL,
  PRIMARY KEY (intent_id, depends_on_id)
);
