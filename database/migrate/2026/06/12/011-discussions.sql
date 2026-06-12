-- SCHEMA_VERSION bump: 2 → 3 (discussions store)
-- 新增 discussions.participant_agent_ids: 讨论创建时选定的参与 agent id 集合
-- 旧行 (无字段) 由 ensureColumn 以 DEFAULT '[]' 回填; '[]' 在编排时回退全员 (向后兼容)
--
-- 变更:
--   - discussions 表新增列 participant_agent_ids TEXT NOT NULL DEFAULT '[]'
--
-- 对应 DDL: database/discussions/discussions.sql
-- 运行时回填: server/src/features/discussions/store.ts ensureColumn(...)

ALTER TABLE discussions ADD COLUMN participant_agent_ids TEXT NOT NULL DEFAULT '[]';
