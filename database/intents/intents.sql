-- intents — 意图 (需求/任务) 台账
-- 所属模块: intents
-- 对应 Store: server/src/features/intents/store.ts
-- 永久删除由 Store 事务同时清理双向 intent_deps、intent_sessions、intent_logs。


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
  base_branch         TEXT,                          -- 意图的基准分支快照: 创建时取工作区 defaultMainBranch, 缺失则 origin/HEAD 探测, 再兜底 main/master; 首次关联到分支已就绪的交付时改为该交付分支, 该交付分支由未就绪变就绪时追平一次, 失去最后一条关联时回退主分支; 多交付关联保持已设值。快照不追随交付分支后续推进/改名。PR 目标与 worktree 基线共读此列。磁盘可空 (存量加列瞬间), 所有写入路径保证非空, 读模型对空值派生主分支回退且不回写 (v21→v22 新增)
  latest_commit_hash  TEXT,                          -- 分支最新 commit hash (v7→v8 新增)
  pr_id               TEXT,                          -- PR / Merge Request 编号 (v7→v8 新增)
  pr_url              TEXT,                          -- PR 可跳转链接 (如 GitHub PR URL); 与 latest_commit_hash 语义不同 (v13→v14 新增; 历史行为 NULL)
  pr_status           TEXT,                          -- PR 状态: 'reviewing' | 'rejected' | 'failed' | 'merged' (v7→v8 新增)
  spec_path           TEXT,                          -- 已撰写的 spec 文档路径 (相对 workspace), spec 质量闸的存在性来源 (v12→v13 新增; 文档标注 VARCHAR(255), SQLite 实为 TEXT; 历史行为 NULL)
  spec_status         TEXT NOT NULL DEFAULT 'raw'
                      CHECK(spec_status IN ('raw','pending','approved')),  -- spec 文档状态, 闸门/待批准提示的唯一事实源: raw=无 spec 或仅服务端播种的 seed (不算待批准); pending=已有偏离 seed 的真实内容且未批准; approved=已批准 (v17→v18 新增; 存量按 spec_approved=1→approved / 有 spec_path 未批准→pending / 其余→raw 回填)
  spec_mode           TEXT CHECK(spec_mode IN ('sdd','fast')),  -- 每意图级 spec 模式三态: NULL=继承工作区(sddEnabled=true⇒sdd, false⇒fast); 'sdd'=显式固定规格先行; 'fast'=显式固定规格延后(仅手动 start_development 跳过 spec 准入闸门, 自动化不变) (v18→v19 新增; 存量不回填, 继续继承工作区)
  spec_approved       INTEGER NOT NULL DEFAULT 0,    -- spec 是否通过人工审批闸: 0=否, 1=是 (v12→v13 新增; 历史行为 0); 兼容字段, 与 spec_status 同事务双写 (approved ⇔ 1), 读路径以 spec_status 为准
  spec_approve_user   TEXT,                          -- spec 审批人 (用户标识); 未审批为 NULL (v12→v13 新增; 文档标注 VARCHAR(64))
  spec_session_id     TEXT,                          -- 撰写/精炼 spec 的会话 c3SessionId; 与 last_work_session_id 语义不同 (v12→v13 新增; 文档标注 VARCHAR(128))
  spec_review_session_id      TEXT,                  -- 只读审核会话 c3SessionId; 与 spec_session_id (撰写方) 分属不同权限域 (v16→v17 新增; 历史行为 NULL)
  spec_review_verdict         TEXT,                  -- 当前审核结论: 'pass' | 'changes_requested'; 无有效结论为 NULL (v16→v17 新增)
  spec_review_reason          TEXT,                  -- 审核结论理由 (v16→v17 新增)
  spec_review_at              INTEGER,               -- 结论产生时间 (epoch ms) (v16→v17 新增)
  spec_review_fingerprint     TEXT,                  -- 结论所绑定的 spec 内容指纹; 与 spec 实时指纹不符即结论失效 (v16→v17 新增)
  spec_review_rework_rounds   INTEGER NOT NULL DEFAULT 0, -- 已发生的返工轮次, 达上限后升级人工待办 (v16→v17 新增; 历史行为 0)
  spec_review_machine_blocked INTEGER NOT NULL DEFAULT 0, -- 当前结论是否已被人工撤销否决: 1=同一结论不得再次机器批准 (v16→v17 新增; 历史行为 0)
  intent_session_id   TEXT,                        -- 意图 refine/沟通会话 c3SessionId; 与 last_work_session_id (工作会话) 并存且语义不同 (v12→v13 新增; 文档标注 VARCHAR(128))
  created_at          INTEGER NOT NULL,              -- 创建时间 (epoch ms)
  updated_at          INTEGER NOT NULL,              -- 最后更新时间 (epoch ms)
  completed_at        INTEGER                        -- 完成时间 (epoch ms), status='done' 时打戳
);
CREATE INDEX IF NOT EXISTS idx_intent_workspace_status ON intents(workspace_path, status);
