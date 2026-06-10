-- schedules — 定时任务 (cron + event-triggered)
-- 所属模块: schedules
-- 对应 Store: server/src/features/schedules/store.ts


CREATE TABLE IF NOT EXISTS schedules (
  id                  TEXT PRIMARY KEY,                     -- 任务唯一标识 (UUID v4)
  type                TEXT NOT NULL,                        -- 任务类型 (决定 config 结构)
  config              TEXT NOT NULL DEFAULT '{}',           -- JSON, 任务配置 (name/nameSource 为 server-owned)
  workspace_path      TEXT NOT NULL,                        -- 所属 workspace 绝对路径 (resolve 后)
  trigger_type        TEXT NOT NULL DEFAULT 'cron',         -- 触发类型: 'cron' | 'event' (v5 新增)
  cron_expression     TEXT NOT NULL,                        -- cron 表达式 (trigger_type='event' 时为空)
  next_run_at         INTEGER,                             -- 下次执行时间 (epoch ms), event 类型为 null
  event_topic         TEXT,                                -- 事件主题 (v5 新增, trigger_type='event' 时使用)
  event_reason_filter TEXT,                                -- JSON 数组, 事件原因过滤 (v5 新增, 如 ['complete','error','aborted'])
  status              TEXT NOT NULL,                        -- 状态: 'active' | 'paused' | 'error'
  mode                TEXT NOT NULL DEFAULT '',             -- 执行模式: ModeToken 字符串或 CodexPolicy JSON (v7 改名自 mcp_mode)
  tool_allowlist      TEXT NOT NULL DEFAULT '[]',           -- JSON 数组, 允许使用的工具名列表
  tool_denylist       TEXT NOT NULL DEFAULT '[]',           -- JSON 数组, 禁止使用的工具名列表
  vendor              TEXT NOT NULL DEFAULT 'claude',       -- 执行 vendor: 'claude' | 'codex' | 'opencode' (v6 新增)
  created_at          INTEGER NOT NULL,                     -- 创建时间 (epoch ms)
  updated_at          INTEGER NOT NULL                      -- 最后更新时间 (epoch ms)
);
CREATE INDEX IF NOT EXISTS idx_sch_workspace ON schedules(workspace_path);
