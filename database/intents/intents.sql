-- intents — 意图 (需求/任务) 台账
-- 所属模块: intents
-- 对应 Store: server/src/features/intents/store.ts


CREATE TABLE IF NOT EXISTS intents (
  id                  TEXT PRIMARY KEY,              -- 意图唯一标识 (UUID v4)
  workspace_path      TEXT NOT NULL,                 -- 所属工作区绝对路径 (resolve 后); v10→v11 由 project_path 改名
  title               TEXT NOT NULL,                 -- 意图标题
  content             TEXT NOT NULL,                 -- 意图详细描述
  priority            TEXT NOT NULL,                 -- 优先级: 'low' | 'medium' | 'high' | 'critical'
  status              TEXT NOT NULL,                 -- 状态: 'draft' | 'todo' | 'in_progress' | 'done' | 'cancelled'
  module              TEXT NOT NULL DEFAULT '',      -- 所属模块名 (v1→v2 新增)
  last_dev_session_id TEXT,                          -- 最近一次开发会话的 c3SessionId
  automate            INTEGER NOT NULL DEFAULT 0,    -- 是否允许编排器自动选取: 0=否, 1=是 (v3→v4 新增)
  branch_name         TEXT,                          -- 开发分支名 (v7→v8 新增)
  latest_commit_hash  TEXT,                          -- 分支最新 commit hash (v7→v8 新增)
  pr_id               TEXT,                          -- PR / Merge Request 编号 (v7→v8 新增)
  pr_status           TEXT,                          -- PR 状态: 'reviewing' | 'rejected' | 'failed' | 'merged' (v7→v8 新增)
  created_at          INTEGER NOT NULL,              -- 创建时间 (epoch ms)
  updated_at          INTEGER NOT NULL,              -- 最后更新时间 (epoch ms)
  completed_at        INTEGER                        -- 完成时间 (epoch ms), status='done' 时打戳
);
CREATE INDEX IF NOT EXISTS idx_intent_workspace_status ON intents(workspace_path, status);
