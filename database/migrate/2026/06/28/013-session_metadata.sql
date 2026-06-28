-- 013 — work_session_metadata 泛化为 session_metadata
-- 日期: 2026-06-28
--
-- 真实迁移由 server/src/features/sessions/session-metadata-store.ts 的 lazy schema
-- 以 sqlite_master / PRAGMA table_info 守卫执行:仅旧表存在时 RENAME;仅新表存在时补列;
-- 两表同时存在时报可诊断错误,不静默 DROP / merge。下面是等价 DDL 记录,不能脱离守卫
-- 直接盲跑。

ALTER TABLE work_session_metadata RENAME TO session_metadata;

ALTER TABLE session_metadata ADD COLUMN session_kind TEXT NOT NULL DEFAULT 'work';
ALTER TABLE session_metadata ADD COLUMN owner_kind TEXT;
ALTER TABLE session_metadata ADD COLUMN owner_id TEXT;
ALTER TABLE session_metadata ADD COLUMN bound INTEGER NOT NULL DEFAULT 1;

UPDATE session_metadata
   SET session_kind = 'work'
 WHERE session_kind IS NULL OR session_kind = '';

UPDATE session_metadata
   SET bound = 0
 WHERE kind = 'pending';

UPDATE session_metadata
   SET bound = 1
 WHERE kind IS NULL OR kind != 'pending';

CREATE INDEX IF NOT EXISTS idx_sm_workspace_kind_updated
  ON session_metadata(workspace_path, session_kind, bound, last_modified DESC, state_updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_sm_workspace_vendor
  ON session_metadata(workspace_path, vendor, vendor_session_id);

CREATE INDEX IF NOT EXISTS idx_sm_state_age
  ON session_metadata(state, state_updated_at);
