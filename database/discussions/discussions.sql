-- discussions — 讨论线程元数据
-- 所属模块: discussions
-- 对应 Store: server/src/features/discussions/store.ts


CREATE TABLE IF NOT EXISTS discussions (
  id              TEXT PRIMARY KEY,                  -- 讨论唯一标识 (UUID v4)
  workspace_name  TEXT NOT NULL,                     -- 所属工作区绝对路径 (resolve 后); v3→v4 由 project_path 改名
  title           TEXT NOT NULL,                     -- 讨论标题
  type            TEXT NOT NULL,                     -- 讨论类型 (如 'brainstorm' | 'code_review' | ...)
  goal            TEXT NOT NULL DEFAULT '',          -- 讨论目标描述
  context         TEXT NOT NULL DEFAULT '',          -- 用户提供的背景上下文
  research_result TEXT NOT NULL DEFAULT '',          -- 只读研究 agent 的调查结果
  research_session_id TEXT,                          -- 研究会话的 vendor session id; NULL/''=该讨论没有研究会话 (历史行 / 研究在绑定前失败)
  status          TEXT NOT NULL,                     -- 状态: 'draft' | 'active' | 'paused' | 'completed'
  agenda          TEXT NOT NULL DEFAULT '[]',        -- JSON 数组, 有序子议题列表
  agenda_index    INTEGER NOT NULL DEFAULT 0,        -- 当前正在进行的议题 0-based 下标
  participant_agent_ids TEXT NOT NULL DEFAULT '[]',  -- JSON 数组, 创建时选定的参与 agent id 集合; '[]'=未设置→编排时回退全员 (organizer 恒并入)
  organizer_agent_id TEXT,                           -- 指定的组织者 agent id; NULL=使用全局默认; 覆盖 defaultAgentId
  conclusion      TEXT,                              -- 讨论结论文本
  metadata        TEXT NOT NULL DEFAULT '{}',        -- JSON 对象, 扁平 string→string 业务 metadata; 仅由 MCP start_discussion 写入; 随 discussion:start/end 事件发出; 损坏值读取降级为 {}
  created_at      INTEGER NOT NULL,                  -- 创建时间 (epoch ms)
  updated_at      INTEGER NOT NULL,                  -- 最后更新时间 (epoch ms)
  completed_at    INTEGER                            -- 完成时间 (epoch ms), status='completed' 时打戳
);
CREATE INDEX IF NOT EXISTS idx_disc_workspace_status ON discussions(workspace_name, status);
