-- discussion_agent_sessions — 讨论内 agent 到 vendor 会话的持久化映射 (支持 resume)
-- 所属模块: discussions
-- 对应 Store: server/src/features/discussions/store.ts


CREATE TABLE IF NOT EXISTS discussion_agent_sessions (
  discussion_id TEXT NOT NULL,                  -- 讨论 ID (外键 → discussions.id)
  agent_id      TEXT NOT NULL,                  -- agent 角色标识
  session_id    TEXT NOT NULL,                  -- vendor-native 会话 ID
  last_seq      INTEGER NOT NULL DEFAULT 0,    -- 上次同步到的消息序号, 用于增量 prompt
  created_at    INTEGER NOT NULL,              -- 创建时间 (epoch ms)
  PRIMARY KEY (discussion_id, agent_id)
);
