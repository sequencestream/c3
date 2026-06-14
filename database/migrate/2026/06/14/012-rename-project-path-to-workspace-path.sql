-- 012 — DB 工作区主键列 project_path → workspace_path 就地无损改名
-- 日期: 2026-06-14
-- 影响 store / 版本跨度:
--   intents      (intents, intent_chats)        v10 → v11
--   discussions  (discussions)                  v3  → v4
--   user-involve (wait_user_involve_events)     v1  → v2
--
-- 背景: 「工作区多实例」铺路的数据层落地。上述三表的工作区主键列仍叫 project_path,
-- 与新词汇 workspace_path 不一致。本迁移把 DB 列就地改透 (不改语义 —— 仍是工作区绝对
-- 路径主键; 不改 wire 字段 —— 属意图 1)。
--
-- ⚠️ 有意识的分歧 (与 projectConfigs 磁盘键【相反的决策】):
--   settings.json 的 `projectConfigs` 键【故意保留旧名】以保持向后兼容 (改名会让既有
--   配置失效)。而本迁移是用户【主动选择把 DB 列也改透】—— DB 列名仅服务端内部可见、
--   有在位迁移兜底,无外部兼容包袱,故与磁盘键的"留旧名"决策不同。二者是不同约束下的
--   不同取舍,非疏漏。
--
-- 迁移由各 store 的 migrateProjectPathToWorkspacePath() 在 exec(SCHEMA) 之前执行,
-- 幂等且可重入 (每步以 PRAGMA table_info / sqlite_master 守卫)。从不 DROP TABLE:
-- 列用 ALTER ... RENAME COLUMN; 复合索引用 DROP INDEX + SCHEMA 的 CREATE INDEX
-- IF NOT EXISTS 以新名重建。单列索引 idx_chat_project 保留索引名 —— SQLite 的
-- RENAME COLUMN 会自动更新其列引用,无需 drop/rebuild。
-- 下面的等价 DDL 仅作记录,真实迁移在 store.ts 中以幂等守卫执行。

-- intents 模块 (v10 → v11)
ALTER TABLE intents       RENAME COLUMN project_path TO workspace_path;
ALTER TABLE intent_chats  RENAME COLUMN project_path TO workspace_path;
DROP INDEX IF EXISTS idx_intent_project_status;
CREATE INDEX IF NOT EXISTS idx_intent_workspace_status ON intents(workspace_path, status);
-- idx_chat_project 索引名不变, RENAME COLUMN 已把其列引用更新为 workspace_path。

-- discussions 模块 (v3 → v4)
ALTER TABLE discussions RENAME COLUMN project_path TO workspace_path;
DROP INDEX IF EXISTS idx_disc_project_status;
CREATE INDEX IF NOT EXISTS idx_disc_workspace_status ON discussions(workspace_path, status);

-- user-involve 模块 (v1 → v2)
ALTER TABLE wait_user_involve_events RENAME COLUMN project_path TO workspace_path;
DROP INDEX IF EXISTS idx_wui_project_status;
CREATE INDEX IF NOT EXISTS idx_wui_workspace_status ON wait_user_involve_events(workspace_path, status);
-- idx_wui_source_status 不涉及该列, 不动。
