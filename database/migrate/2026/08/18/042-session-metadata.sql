-- session_metadata: 新增 vendor_session_id 索引，支撑「无事实会话」的绑定回退查询。
--
-- 背景：自动化执行只写本表投影行，不写 state.json 的 session→agent 事实，导致
-- resolveSessionAgentBinding 找不到事实时回落到默认 agent —— codex 自动化会话在标题栏
-- 与状态栏显示成 claude。修复后：
-- - 自动化运行绑定真实 session id 时同时冻结事实（server/src/features/automations/dispatcher.ts）；
-- - 历史无事实会话由本表按 vendor_session_id 反查绑定（getBoundByVendorSessionId）。
--
-- 该反查只知道 wire 上的 vendor session id，用不到既有的
-- idx_sm_workspace_vendor(workspace_name, vendor, vendor_session_id) 前缀，故补一条独立索引。
-- 建索引由 server/src/features/sessions/session-metadata-store.ts 的 ensureSchema 幂等执行，
-- 新库与旧库同一条路径；本文件是该 schema 的变更记录。

CREATE INDEX IF NOT EXISTS idx_sm_vendor_session_id
  ON session_metadata(vendor_session_id, bound);
