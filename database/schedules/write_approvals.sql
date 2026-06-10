-- write_approvals — 定时任务写操作审批 (human-in-the-loop gate)
-- 所属模块: schedules
-- 对应 Store: server/src/features/schedules/store.ts
-- 存储引擎: SQLite (c3.db)

CREATE TABLE IF NOT EXISTS write_approvals (
  id             TEXT PRIMARY KEY,                     -- 审批唯一标识 (UUID v4)
  schedule_id    TEXT NOT NULL,                        -- 所属任务 ID (外键 → schedules.id)
  workspace_path TEXT NOT NULL,                        -- 所属 workspace 绝对路径 (resolve 后)
  tool_name      TEXT NOT NULL,                        -- 待审批的工具名称
  tool_input     TEXT NOT NULL DEFAULT '{}',           -- JSON, 工具输入参数
  diff_preview   TEXT NOT NULL DEFAULT '',             -- diff 预览内容 (人类决策依据)
  created_at     INTEGER NOT NULL,                     -- 创建时间 (epoch ms)
  expires_at     INTEGER NOT NULL,                     -- 过期时间 (epoch ms), 超时后自动视为过期
  status         TEXT NOT NULL DEFAULT 'pending',      -- 审批状态: 'pending' | 'approved' | 'rejected' | 'expired'
  resolved_by    TEXT,                                 -- 审批/拒绝人标识
  resolved_at    INTEGER                               -- 审批/拒绝时间 (epoch ms)
);
CREATE INDEX IF NOT EXISTS idx_wa_workspace ON write_approvals(workspace_path);
CREATE INDEX IF NOT EXISTS idx_wa_status ON write_approvals(status);
