-- 新增 intent_logs 表 — 意图生命周期变更日志(操作审计轨迹)
--
-- 运行时迁移由 server/src/features/intents/store.ts 的 schema ensure 幂等执行:
-- 新表随 SCHEMA 的 CREATE TABLE IF NOT EXISTS 创建,无历史数据迁移(旧意图无日志,
-- 从上线时刻开始记录);从不 DROP。SCHEMA_VERSION v15 → v16。

CREATE TABLE IF NOT EXISTS intent_logs (
  id              TEXT PRIMARY KEY,                 -- uuid
  intent_id       TEXT    NOT NULL,                 -- 意图 ID (外键 → intents.id)
  operation_type  TEXT    NOT NULL,                 -- 操作类型: intent_created/intent_updated/status_changed/spec_created/spec_approved/spec_unapproved/pr_created/pr_merged/pr_closed
  summary         TEXT    NOT NULL,                 -- 操作摘要(如「状态变更: todo → in_progress」)
  actor           TEXT    NOT NULL,                 -- 操作人: 登录用户名 / 'system' / 'automation'
  created_at      INTEGER NOT NULL                  -- 操作时间 (epoch ms)
);
CREATE INDEX IF NOT EXISTS idx_intent_log_intent_created ON intent_logs(intent_id, created_at DESC);
