-- im_robot_threads — 绑定主体 + scope_hash 的机器人 Conversation
-- 所属模块: robots
-- 对应 Store: server/src/features/im/robot-context-store.ts
-- 迁移: migrate/2026/08/20/044-im-robots.sql, 046-im-robot-sender-isolation.sql, 047-im-identity-and-call-level-scope.sql
--
-- 会话身份是 (platform, robot_id, thread_key, sender_id, binding_id, subject, scope_hash)。
-- session_id 只是同 Conversation、同 vendor 下的续接缓存。可恢复正文在 im_robot_context_turns。
-- 绑定/撤销/policyEpoch 变化会切断旧上下文; 旧四维行不迁移。

CREATE TABLE IF NOT EXISTS im_robot_threads (
  platform         TEXT NOT NULL,
  robot_id         TEXT NOT NULL,
  thread_key       TEXT NOT NULL,
  sender_id        TEXT NOT NULL,
  binding_id       TEXT NOT NULL,
  subject          TEXT NOT NULL,
  scope_hash       TEXT NOT NULL,
  chat_id          TEXT NOT NULL,
  session_id       TEXT,
  vendor           TEXT NOT NULL,
  context_revision INTEGER NOT NULL DEFAULT 0,
  turn_count       INTEGER NOT NULL DEFAULT 0,
  created_at       INTEGER NOT NULL,
  last_active_at   INTEGER NOT NULL,
  PRIMARY KEY (platform, robot_id, thread_key, sender_id, binding_id, subject, scope_hash)
);
CREATE INDEX IF NOT EXISTS idx_im_thread_session ON im_robot_threads(session_id);
CREATE INDEX IF NOT EXISTS idx_im_thread_idle ON im_robot_threads(last_active_at);
