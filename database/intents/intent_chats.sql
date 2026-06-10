-- intent_chats — 沟通会话映射表 (同时作为隐藏会话集 + 每个 project 的当前会话指针)
-- 所属模块: intents
-- 对应 Store: server/src/features/intents/store.ts
-- 存储引擎: SQLite (c3.db)

CREATE TABLE IF NOT EXISTS intent_chats (
  session_id    TEXT PRIMARY KEY,    -- 会话 ID (c3SessionId 或 pendingId)
  project_path  TEXT NOT NULL,       -- 所属项目绝对路径 (resolve 后)
  is_current    INTEGER NOT NULL,    -- 是否为当前 project 的默认打开会话: 0=否, 1=是
  updated_at    INTEGER NOT NULL,    -- 最后更新时间 (epoch ms)
  title         TEXT                 -- 会话标题 (v6→v7 新增), null 时客户端回退到默认标题
);
CREATE INDEX IF NOT EXISTS idx_chat_project ON intent_chats(project_path);
