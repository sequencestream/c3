-- im_robot_context_turns — 绑定主体 + scope_hash 归属的可恢复 IM 可见上下文
-- 所属模块: robots
-- 对应 Store: server/src/features/im/robot-context-store.ts
-- 迁移: migrate/2026/08/21/046-im-robot-sender-isolation.sql, 047-im-identity-and-call-level-scope.sql
--
-- 只存通过入站守卫的用户文本与平台确认投递的最终 assistant 文本。裁决见 ADR-0048 / ADR-0049。
-- 认领以 (platform, robot_id, in_message_id) 唯一。旧四维正文在 identity 迁移中硬删除。

CREATE TABLE IF NOT EXISTS im_robot_context_turns (
  id              TEXT PRIMARY KEY,
  platform        TEXT NOT NULL,
  robot_id        TEXT NOT NULL,
  thread_key      TEXT NOT NULL,
  sender_id       TEXT NOT NULL,
  binding_id      TEXT NOT NULL,
  subject         TEXT NOT NULL,
  scope_hash      TEXT NOT NULL,
  in_message_id   TEXT NOT NULL,
  status          TEXT NOT NULL
                  CHECK(status IN ('pending','committed','failed')),
  user_text       TEXT NOT NULL DEFAULT '',
  assistant_text  TEXT NOT NULL DEFAULT '',
  seq             INTEGER,
  committed_at    INTEGER,
  created_at      INTEGER NOT NULL,
  UNIQUE (platform, robot_id, in_message_id)
);
CREATE INDEX IF NOT EXISTS idx_im_ctx_conversation
  ON im_robot_context_turns(platform, robot_id, thread_key, sender_id, binding_id, subject, scope_hash, status, seq);
CREATE INDEX IF NOT EXISTS idx_im_ctx_committed_at
  ON im_robot_context_turns(committed_at);
