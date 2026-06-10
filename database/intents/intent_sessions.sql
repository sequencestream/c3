-- intent_sessions — intent 的 dev session 执行记录（审计追踪）
-- 每次 intent 启动 dev session 写新行，重跑不覆盖
-- 所属模块: intents
-- 对应 Store: server/src/features/intents/store.ts


CREATE TABLE IF NOT EXISTS intent_sessions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,  -- 自增主键
  intent_id     TEXT    NOT NULL,                   -- 意图 ID (外键 → intents.id)
  session_id    TEXT    NOT NULL,                   -- dev session ID (c3SessionId)
  vendor        TEXT    NOT NULL,                   -- 执行 vendor
  summary       TEXT,                               -- JSON frontmatter + Markdown 摘要
  start_at      INTEGER,                            -- 开始时间 (epoch ms)
  end_at        INTEGER,                            -- 结束时间 (epoch ms)
  exit_code     TEXT    CHECK(exit_code IN ('success','failure','cancelled')),  -- 退出码
  agent_id      TEXT,                               -- 执行 agent ID
  created_at    INTEGER NOT NULL                    -- 记录创建时间 (epoch ms)
);
CREATE INDEX IF NOT EXISTS idx_intent_session_intent ON intent_sessions(intent_id);
