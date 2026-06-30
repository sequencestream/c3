-- intents — 意图 (需求/任务) 台账
-- 所属模块: intents
-- 对应 Store: server/src/features/intents/store.ts


CREATE TABLE IF NOT EXISTS intents (
  id                  TEXT PRIMARY KEY,              -- 意图唯一标识 (UUID v4)
  workspace_path      TEXT NOT NULL,                 -- 所属工作区绝对路径 (resolve 后); v10→v11 由 project_path 改名
  title               TEXT NOT NULL,                 -- 意图标题
  short_en_title      TEXT,                          -- 简短英文 ASCII 短标题, 派生分支/worktree 名的稳定来源 (v11→v12 新增; 文档标注 VARCHAR(128), SQLite 实为 TEXT, 写入侧截断到 128; 历史行为 NULL)
  content             TEXT NOT NULL,                 -- 意图详细描述
  priority            TEXT NOT NULL,                 -- 优先级: 'low' | 'medium' | 'high' | 'critical'
  status              TEXT NOT NULL,                 -- 状态: 'draft' | 'todo' | 'in_progress' | 'done' | 'cancelled'
  module              TEXT NOT NULL DEFAULT '',      -- 所属模块名 (v1→v2 新增)
  last_work_session_id TEXT,                         -- 最近一次由 intent 启动的工作会话 c3SessionId (v14→v15 由 last_dev_session_id 改名)
  automate            INTEGER NOT NULL DEFAULT 0,    -- 是否允许编排器自动选取: 0=否, 1=是 (v3→v4 新增)
  branch_name         TEXT,                          -- 开发分支名 (v7→v8 新增)
  latest_commit_hash  TEXT,                          -- 分支最新 commit hash (v7→v8 新增)
  pr_id               TEXT,                          -- PR / Merge Request 编号 (v7→v8 新增)
  pr_url              TEXT,                          -- PR 可跳转链接 (如 GitHub PR URL); 与 latest_commit_hash 语义不同 (v13→v14 新增; 历史行为 NULL)
  pr_status           TEXT,                          -- PR 状态: 'reviewing' | 'rejected' | 'failed' | 'merged' (v7→v8 新增)
  spec_path           TEXT,                          -- 已撰写的 spec 文档路径 (相对 workspace), spec 质量闸的存在性来源 (v12→v13 新增; 文档标注 VARCHAR(255), SQLite 实为 TEXT; 历史行为 NULL)
  spec_approved       INTEGER NOT NULL DEFAULT 0,    -- spec 是否通过人工审批闸: 0=否, 1=是 (v12→v13 新增; 历史行为 0)
  spec_approve_user   TEXT,                          -- spec 审批人 (用户标识); 未审批为 NULL (v12→v13 新增; 文档标注 VARCHAR(64))
  spec_session_id     TEXT,                          -- 撰写/精炼 spec 的会话 c3SessionId; 与 last_work_session_id 语义不同 (v12→v13 新增; 文档标注 VARCHAR(128))
  intent_session_id   TEXT,                          -- 意图 refine/沟通会话 c3SessionId; 与 last_work_session_id (工作会话) 并存且语义不同 (v12→v13 新增; 文档标注 VARCHAR(128))
  created_at          INTEGER NOT NULL,              -- 创建时间 (epoch ms)
  updated_at          INTEGER NOT NULL,              -- 最后更新时间 (epoch ms)
  completed_at        INTEGER                        -- 完成时间 (epoch ms), status='done' 时打戳
);
CREATE INDEX IF NOT EXISTS idx_intent_workspace_status ON intents(workspace_path, status);
