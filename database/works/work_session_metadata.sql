-- work_session_metadata — 会话列表读路径的核心元数据投影表
-- 所属模块: works
-- 对应 Store: server/src/features/works/work-session-store.ts

--
-- 说明: 不存储 transcript / prompt / tool_use / tool_result 内容。
-- native 存储才是 SoT；本表是可重建的缓存。
-- kind 分 'real' (已 bind) 和 'pending' (未 bind 的意图)。

CREATE TABLE IF NOT EXISTS work_session_metadata (
  c3_id              TEXT PRIMARY KEY,       -- opaque c3 session ID (由 vendor + vendor_session_id 派生)
  workspace_path     TEXT NOT NULL,           -- 所属 workspace 绝对路径
  vendor_session_id  TEXT,                    -- vendor-native 会话 ID (pending 行时为 null)
  agent_id           TEXT NOT NULL,           -- 当前绑定的 agent ID
  title              TEXT NOT NULL,           -- 会话标题
  last_modified      INTEGER,                -- native 存储中 transcript 的最后修改时间 (epoch ms)
  state              TEXT NOT NULL,           -- 生命周期状态: 'born' | 'alive' | 'stale' | 'orphaned' | 'ghost'
  state_updated_at   INTEGER NOT NULL,        -- 状态最后变更时间 (epoch ms)
  kind               TEXT NOT NULL            -- 行类型: 'real' (已 bind 的会话) | 'pending' (未 bind 的意图)
);
CREATE INDEX IF NOT EXISTS idx_wsm_workspace_vendor
  ON work_session_metadata(workspace_path, vendor, vendor_session_id);
CREATE INDEX IF NOT EXISTS idx_wsm_state_age
  ON work_session_metadata(state, state_updated_at);
