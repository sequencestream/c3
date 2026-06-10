-- tool_sessions — 工具创建的会话 ID 集合 (持久化，跨重启存活)
-- 所属模块: intents
-- 对应 Store: server/src/features/intents/store.ts


CREATE TABLE IF NOT EXISTS tool_sessions (
  session_id    TEXT PRIMARY KEY,    -- 工具创建的会话 ID
  created_at    INTEGER NOT NULL     -- 记录创建时间 (epoch ms)
);
