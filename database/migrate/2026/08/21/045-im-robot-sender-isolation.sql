-- im_robot_threads / im_robot_context_turns / im_robot_turns: 发送者隔离 Conversation + 有界上下文持久化。
--
-- 安全切断: 旧群级共享 im_robot_threads (无 sender_id) 整表改名保留, 不把 session_id 复制到任一
-- 发送者 Conversation。审计行保留并迁入扩展 outcome 的新表, 但不用于重建上下文。
--
-- 建表与幂等收敛由 server/src/features/im/robot-store.ts 的 ensureSchema 执行; 本文件是变更记录。
-- 一次性标记: schema_migrations `robots.sender_isolation.v1` (与数据迁移同事务)。

-- 新 Conversation 表 (四维主键)。若旧表仍无 sender_id, store 会先 RENAME 再 CREATE。
CREATE TABLE IF NOT EXISTS im_robot_threads (
  platform         TEXT NOT NULL,
  robot_id         TEXT NOT NULL,
  thread_key       TEXT NOT NULL,
  sender_id        TEXT NOT NULL,
  chat_id          TEXT NOT NULL,
  session_id       TEXT,
  vendor           TEXT NOT NULL,
  context_revision INTEGER NOT NULL DEFAULT 0,
  turn_count       INTEGER NOT NULL DEFAULT 0,
  created_at       INTEGER NOT NULL,
  last_active_at   INTEGER NOT NULL,
  PRIMARY KEY (platform, robot_id, thread_key, sender_id)
);
CREATE INDEX IF NOT EXISTS idx_im_thread_session ON im_robot_threads(session_id);
CREATE INDEX IF NOT EXISTS idx_im_thread_idle ON im_robot_threads(last_active_at);

CREATE TABLE IF NOT EXISTS im_robot_context_turns (
  id              TEXT PRIMARY KEY,
  platform        TEXT NOT NULL,
  robot_id        TEXT NOT NULL,
  thread_key      TEXT NOT NULL,
  sender_id       TEXT NOT NULL,
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
  ON im_robot_context_turns(platform, robot_id, thread_key, sender_id, status, seq);
CREATE INDEX IF NOT EXISTS idx_im_ctx_committed_at
  ON im_robot_context_turns(committed_at);

-- 审计表终态 (含 input_rejected + reject_reason)。旧 CHECK 无法 ALTER; store 用 RENAME + 回填收敛。
CREATE TABLE IF NOT EXISTS im_robot_turns (
  id             TEXT PRIMARY KEY,
  robot_id       TEXT NOT NULL,
  thread_key     TEXT NOT NULL,
  chat_id        TEXT NOT NULL,
  sender_id      TEXT NOT NULL,
  in_message_id  TEXT NOT NULL,
  session_id     TEXT,
  started_at     INTEGER NOT NULL,
  finished_at    INTEGER,
  outcome        TEXT
                 CHECK(outcome IS NULL OR outcome IN
                   ('complete','error','blocked','timeout','guard_refused','input_rejected')),
  reject_reason  TEXT
                 CHECK(reject_reason IS NULL OR reject_reason IN ('credential','too_long')),
  outbound_chars INTEGER NOT NULL DEFAULT 0,
  out_message_id TEXT,
  error          TEXT
);
CREATE INDEX IF NOT EXISTS idx_im_turn_robot ON im_robot_turns(robot_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_im_turn_thread ON im_robot_turns(robot_id, thread_key, started_at DESC);
