-- SCHEMA_VERSION bump: 9 → 10
-- 新增 intent_sessions 表：intent dev session 执行历史审计追踪
-- 每次 intent 启动 dev session 写新行，重跑不覆盖
--
-- 变更:
--   - 新增 intent_sessions 表 (id INTEGER PK, intent_id, session_id, vendor, summary, start_at, end_at, exit_code, agent_id)
--
-- 对应 DDL: database/intents/intent_sessions.sql


CREATE TABLE IF NOT EXISTS intent_sessions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  intent_id     TEXT    NOT NULL,
  session_id    TEXT    NOT NULL,
  vendor        TEXT    NOT NULL,
  summary       TEXT,
  start_at      INTEGER,
  end_at        INTEGER,
  exit_code     TEXT    CHECK(exit_code IN ('success','failure','cancelled')),
  agent_id      TEXT,
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_intent_session_intent ON intent_sessions(intent_id);
