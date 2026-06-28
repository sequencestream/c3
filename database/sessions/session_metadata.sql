-- session_metadata — 多类型会话列表读路径的统一元数据投影表
-- 可重建缓存;事实源仍在各业务表 / vendor native store。

CREATE TABLE IF NOT EXISTS session_metadata (
  c3_id              TEXT PRIMARY KEY,
  workspace_path     TEXT NOT NULL,
  vendor             TEXT NOT NULL,
  vendor_session_id  TEXT,
  agent_id           TEXT NOT NULL,
  title              TEXT NOT NULL,
  last_modified      INTEGER,
  state              TEXT NOT NULL,
  state_updated_at   INTEGER NOT NULL,
  kind               TEXT NOT NULL,
  session_kind       TEXT NOT NULL DEFAULT 'work',
  owner_kind         TEXT,
  owner_id           TEXT,
  bound              INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_sm_workspace_kind_updated
  ON session_metadata(workspace_path, session_kind, bound, last_modified DESC, state_updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_sm_workspace_vendor
  ON session_metadata(workspace_path, vendor, vendor_session_id);

CREATE INDEX IF NOT EXISTS idx_sm_state_age
  ON session_metadata(state, state_updated_at);
