-- workspace_memories: 新建表 —— 工作区长期记忆 (用户偏好 / 已验证约束 / 事实 / 教训)。
--
-- 纯新增, 不改动也不重写任何既有表。既有库通过 CREATE TABLE IF NOT EXISTS + PRAGMA table_info
-- 列存在性检查收敛, 重复执行是 no-op; 无数据回填, 不从意图/交付台账、仓库文件或厂商会话库导入任何历史。
--
-- 建表与索引由 server/src/features/memory/store.ts 的 ensureSchema 惰性幂等执行, 新库与旧库同一条路径;
-- 本文件是该 schema 的变更记录。表的完整语义 (身份、生命周期、容量与长度边界、拒绝规则) 见
-- database/memory/workspace_memories.sql。

CREATE TABLE IF NOT EXISTS workspace_memories (
  id                TEXT PRIMARY KEY,
  workspace_name    TEXT NOT NULL,
  subject           TEXT,
  type              TEXT NOT NULL
                    CHECK(type IN ('preference','constraint','fact','lesson')),
  title             TEXT NOT NULL,
  title_key         TEXT NOT NULL,
  content           TEXT NOT NULL,
  status            TEXT NOT NULL
                    CHECK(status IN ('active','superseded','deleted')),
  source_session_id TEXT NOT NULL,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  superseded_by     TEXT
);
CREATE INDEX IF NOT EXISTS idx_workspace_memory_scope
  ON workspace_memories(workspace_name, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_workspace_memory_title
  ON workspace_memories(workspace_name, title_key, status);
CREATE INDEX IF NOT EXISTS idx_workspace_memory_inactive
  ON workspace_memories(status, updated_at);
