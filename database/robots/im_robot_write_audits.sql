-- im_robot_write_audits — IM L2 写尝试审计 (无令牌/消息正文)
-- 所属模块: robots
-- 对应 Store: server/src/features/im/write-audit-store.ts

CREATE TABLE IF NOT EXISTS im_robot_write_audits (
  id                   TEXT PRIMARY KEY,
  robot_id             TEXT NOT NULL,
  todo_id              TEXT,
  binding_subject      TEXT,
  sender_id_redacted   TEXT,
  actor_subject        TEXT,
  object_workspace     TEXT,
  capability           TEXT,
  answer_id            TEXT,
  result               TEXT NOT NULL,
  refuse_reason        TEXT,
  idempotency_key      TEXT,
  created_at           INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_im_robot_write_audits_robot ON im_robot_write_audits(robot_id, created_at);
CREATE INDEX IF NOT EXISTS idx_im_robot_write_audits_todo ON im_robot_write_audits(todo_id);
