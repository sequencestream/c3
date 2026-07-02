-- intent_logs — 意图生命周期变更日志(操作审计轨迹)
-- 每次生命周期操作(创建/修改/状态流转/spec 创建与审批/PR 创建与合并)追加一行,只增不改
-- 所属模块: intents
-- 对应 Store: server/src/features/intents/store.ts


CREATE TABLE IF NOT EXISTS intent_logs (
  id              TEXT PRIMARY KEY,                 -- uuid
  intent_id       TEXT    NOT NULL,                 -- 意图 ID (外键 → intents.id)
  operation_type  TEXT    NOT NULL,                 -- 操作类型: intent_created/intent_updated/status_changed/spec_created/spec_approved/spec_unapproved/pr_created/pr_merged/pr_closed
  summary         TEXT    NOT NULL,                 -- 操作摘要(如「状态变更: todo → in_progress」)
  actor           TEXT    NOT NULL,                 -- 操作人: 登录用户名 / 'system' / 'automation'
  created_at      INTEGER NOT NULL                  -- 操作时间 (epoch ms)
);
CREATE INDEX IF NOT EXISTS idx_intent_log_intent_created ON intent_logs(intent_id, created_at DESC);
