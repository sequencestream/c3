-- 外部 MCP 写调用审计: 新增只增审计表 external_mcp_write_audits
--
-- 建表由 server/src/features/external-mcp/audit-store.ts 在首次访问时以 CREATE TABLE IF
-- NOT EXISTS 幂等执行, 启动时另调一次 ensureExternalMcpWriteAuditSchema() 预建; 新库与旧
-- 库同一条路径, 本文件是该 schema 的变更记录。

CREATE TABLE IF NOT EXISTS external_mcp_write_audits (
  id             TEXT PRIMARY KEY,
  occurred_at    INTEGER NOT NULL,
  key_id         TEXT NOT NULL,
  owner_subject  TEXT NOT NULL,
  workspace_name TEXT NOT NULL,
  tool           TEXT NOT NULL,
  result         TEXT NOT NULL CHECK(result IN ('success','failure','rejected'))
);
CREATE INDEX IF NOT EXISTS idx_external_mcp_write_audit_occurred
  ON external_mcp_write_audits(occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_external_mcp_write_audit_key
  ON external_mcp_write_audits(key_id, occurred_at DESC);

-- 无回填, 也不需要 schema_migrations 标记: 本表记录的是「调用发生时」的事实, 上线之前
-- 发生过的调用无从重建, 编造行会让审计轨迹本身不可信。
