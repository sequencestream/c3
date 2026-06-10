-- discussion_messages — 讨论中的消息
-- 所属模块: discussions
-- 对应 Store: server/src/features/discussions/store.ts


CREATE TABLE IF NOT EXISTS discussion_messages (
  id                TEXT PRIMARY KEY,    -- 消息唯一标识 (UUID v4)
  discussion_id     TEXT NOT NULL,       -- 所属讨论 ID (外键 → discussions.id)
  seq               INTEGER NOT NULL,    -- 讨论内自增序号 (MAX(seq)+1, 保证顺序)
  speaker_kind      TEXT NOT NULL,       -- 发言者类型: 'user' | 'agent' | 'system'
  speaker_agent_id  TEXT,                -- agent 发言者 ID (speaker_kind='agent' 时有值)
  speaker_name      TEXT,                -- 发言者显示名称
  content           TEXT NOT NULL,       -- 消息正文
  created_at        INTEGER NOT NULL     -- 创建时间 (epoch ms)
);
CREATE INDEX IF NOT EXISTS idx_disc_msg_discussion ON discussion_messages(discussion_id, seq);
