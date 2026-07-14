-- automations — 定时任务 (cron + event-triggered)
-- 所属模块: automations
-- 对应 Store: server/src/features/automations/store.ts


CREATE TABLE IF NOT EXISTS automations (
  id                  TEXT PRIMARY KEY,                     -- 任务唯一标识 (UUID v4)
  type                TEXT NOT NULL,                        -- 任务类型 (决定 config 结构)
  config              TEXT NOT NULL DEFAULT '{}',           -- JSON, 任务配置 (name/nameSource 为 server-owned)
  max_wall_clock_ms   INTEGER,                               -- 单次执行最大墙钟时间(ms), NULL=按任务类型默认
  workspace_path      TEXT NOT NULL,                        -- 所属 workspace 绝对路径 (resolve 后)
  trigger_type        TEXT NOT NULL DEFAULT 'cron',         -- 触发类型: 'cron' | 'event' (v5 新增)
  cron_expression     TEXT NOT NULL,                        -- cron 表达式 (trigger_type='event' 时为空)
  next_run_at         INTEGER,                             -- 下次执行时间 (epoch ms), event 类型为 null
  event_topic         TEXT,                                -- 事件主题 (v5 新增, trigger_type='event' 时使用: 'run:started'|'run:settled'|'pr:operation')
  event_reason_filter TEXT,                                -- JSON 数组, run:settled 原因过滤 (v5 新增, 如 ['complete','error','aborted'])
  event_pr_filter     TEXT,                                -- JSON {operations?,results?}, pr:operation 过滤 (v8 新增, NULL=任意)
  event_intent_filter TEXT,                                -- JSON {phases?}, intent:lifecycle 阶段过滤 (v9 新增, NULL=任意阶段)
  event_session_kind_filter TEXT,                          -- JSON 数组, run-lifecycle 事件的 sessionKind 多选 (v11 新增, 非空必填; cron/pr/intent 为 NULL)
  event_metadata_filter     TEXT,                          -- [遗留, v12 起仅作迁移输入] JSON {conditions,combinator}, run-lifecycle 事件 metadata 过滤 (v11)
  event_filter        TEXT,                                -- [遗留, v13 起仅作迁移输入] JSON GenericEventFilter, v12 单一事件过滤 (2026-07-13)
  event_filters       TEXT,                                -- JSON GenericEventFilter[] 订阅行数组, 任一命中即触发 (v13 新增, 2026-07-14; type 为 <大类>:<动作> 或 <大类>:*; 运行时唯一事实源; cron 为 NULL)
  metadata            TEXT NOT NULL DEFAULT '{}',           -- JSON 对象, 自由 key/value 标注 (v11 新增, 仅随该 automation 自身运行事件下发)
  status              TEXT NOT NULL,                        -- 状态: 'active' | 'paused' | 'error' | 'archived'
  mode                TEXT NOT NULL DEFAULT '',             -- 执行模式: ModeToken 字符串或 CodexPolicy JSON (v7 改名自 mcp_mode)
  tool_allowlist      TEXT NOT NULL DEFAULT '[]',           -- JSON 数组, 允许使用的工具名列表
  tool_denylist       TEXT NOT NULL DEFAULT '[]',           -- JSON 数组, 禁止使用的工具名列表
  vendor              TEXT NOT NULL DEFAULT 'claude',       -- 工具清单与执行适配器所属厂商
  agent_id            TEXT,                                 -- LLM 任务指定的执行 Agent；command 为 NULL
  created_at          INTEGER NOT NULL,                     -- 创建时间 (epoch ms)
  updated_at          INTEGER NOT NULL                      -- 最后更新时间 (epoch ms)
);
CREATE INDEX IF NOT EXISTS idx_sch_workspace ON automations(workspace_path);
