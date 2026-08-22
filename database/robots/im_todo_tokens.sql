-- im_todo_tokens — 私聊待办一次性令牌 (仅存哈希)
-- 所属模块: robots
-- 对应 Store: server/src/features/im/todo-token-store.ts
--
-- 明文只在受控私聊中出现一次; 数据库绑定 robot/todo/binding/sender/scope 等事实。

CREATE TABLE IF NOT EXISTS im_todo_tokens (
  id                   TEXT PRIMARY KEY,
  token_hash           TEXT NOT NULL UNIQUE,
  robot_id             TEXT NOT NULL,
  todo_id              TEXT NOT NULL,
  binding_id           TEXT NOT NULL,
  actor_sender_id      TEXT NOT NULL,
  actor_subject        TEXT NOT NULL,
  workspace_name       TEXT NOT NULL,
  capability           TEXT NOT NULL,
  todo_fingerprint     TEXT NOT NULL,
  config_hash          TEXT NOT NULL,
  expires_at           INTEGER NOT NULL,
  status               TEXT NOT NULL DEFAULT 'pending'
                       CHECK(status IN ('pending','executing','succeeded','refused','expired','cancelled')),
  answer_id            TEXT,
  idempotency_key      TEXT,
  result_json          TEXT,
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL,
  FOREIGN KEY (robot_id) REFERENCES im_robots(id) ON DELETE CASCADE,
  FOREIGN KEY (todo_id) REFERENCES wait_user_involve_events(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_im_todo_tokens_todo ON im_todo_tokens(todo_id, status);
CREATE INDEX IF NOT EXISTS idx_im_todo_tokens_robot_actor ON im_todo_tokens(robot_id, actor_subject, status);
