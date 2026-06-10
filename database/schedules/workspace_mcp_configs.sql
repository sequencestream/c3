-- workspace_mcp_configs — 每个 workspace 的 MCP 服务器配置
-- 所属模块: schedules
-- 对应 Store: server/src/features/schedules/store.ts
-- 存储引擎: SQLite (c3.db)

CREATE TABLE IF NOT EXISTS workspace_mcp_configs (
  workspace_path TEXT PRIMARY KEY,                  -- workspace 绝对路径 (resolve 后), 作为主键
  config_json    TEXT NOT NULL DEFAULT '{}',        -- JSON: { mcpServers: {...}, denylist: [...] }
  updated_at     INTEGER NOT NULL                   -- 最后更新时间 (epoch ms)
);
