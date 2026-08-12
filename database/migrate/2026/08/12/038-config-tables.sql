-- 配置入库: settings.json / state.json → c3.db 的六张配置表
--
-- 运行时迁移由 server/src/kernel/config/config-store.ts 的 schema ensure 幂等执行 (新库
-- 与旧库都由 CREATE TABLE IF NOT EXISTS 建表); 旧 JSON 的一次性导入由
-- server/src/kernel/config/import-legacy.ts 完成, 以 schema_migrations 的三条标记判定,
-- 数据写入与标记同事务, 异常即回滚且不写标记。可重复执行; 从不 DROP。
--
-- 为什么要这次改动: 配置此前被劈成三份 JSON 文件加一个数据库, 边界还互相错位 ——
--   1. 路径解析两套且不重合: `--settings` 只改配置目录, `C3_DB_PATH` 只改数据库,
--      隔离一个 c3 实例必须同时给两个覆盖, e2e 因此长期背着双覆盖约定;
--   2. 整份文档读改写: 保存一个工作区开关要读回 70KB JSON、合并、整体落盘, 并靠手写的
--      反覆盖合并去补救"写入方带上了它并不拥有的字段"这件事 —— 一处漏写就是静默丢数据
--      (saveWorkspaceSetting 曾因此抹掉 personalizedSettings/agentLang/mcpApiKeys);
--   3. 并发靠自造锁: mkdirSync 目录锁 + 陈旧锁回收 + 超时降级, 模拟的正是 SQLite 事务
--      与 WAL 本就提供的东西。
-- 一字段一行之后, 三者一并消失: 一个 `--db` 覆盖搬走整个实例, 写入只触及本次改动的字段,
-- 原子性由事务保证。

-- 工作区注册表: wire 身份 ↔ 磁盘路径。从列表移除只置 registered=0, 不删行 —— 删行会让
-- 该工作区的配置成为孤儿, 重新添加同一目录还会换一个新 id。
CREATE TABLE IF NOT EXISTS workspaces (
  id            TEXT PRIMARY KEY,
  path          TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  last_accessed INTEGER NOT NULL,
  registered    INTEGER NOT NULL DEFAULT 1,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS system_configs (
  config_key   TEXT PRIMARY KEY,
  config_value TEXT,
  config_type  TEXT NOT NULL,
  updated_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS workspace_configs (
  workspace_id TEXT NOT NULL,
  config_key   TEXT NOT NULL,
  config_value TEXT,
  config_type  TEXT NOT NULL,
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, config_key)
);

CREATE TABLE IF NOT EXISTS personalized_configs (
  subject      TEXT NOT NULL,
  config_key   TEXT NOT NULL,
  config_value TEXT,
  config_type  TEXT NOT NULL,
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (subject, config_key)
);

CREATE TABLE IF NOT EXISTS session_configs (
  session_id   TEXT NOT NULL,
  config_key   TEXT NOT NULL,
  config_value TEXT,
  config_type  TEXT NOT NULL,
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (session_id, config_key)
);

CREATE TABLE IF NOT EXISTS mcp_api_keys (
  key_id       TEXT NOT NULL,
  config_key   TEXT NOT NULL,
  config_value TEXT,
  config_type  TEXT NOT NULL,
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (key_id, config_key)
);

-- 一次性导入 (纯 SQL 表达不了: 数据源是三份 JSON 文件, 且 apiKey 需先解密再按 secret
-- 重新加密)。由 import-legacy.ts 执行, 三条标记各自幂等:
--   config.import_workspaces.v1     ← ${CLAUDE_CONFIG_DIR:-~/.claude}/c3/state.json
--                                     (工作区注册表 + 会话模式 + skill 挂载状态)
--   config.import_settings.v1       ← ~/.c3/settings.json
--                                     (系统设置 + projectConfigs + 个性化 + mcpApiKeys)
--   config.import_session_state.v1  ← ~/.c3/state.json (会话↔agent 绑定与待定意图)
--
-- 顺序固定: 先工作区 (workspace_configs 需要 id), 再 settings, 最后会话状态。settings.json
-- 里出现但未注册的工作区路径建 registered=0 的行, 配置照样迁入而不污染工作区列表。
-- 导入成功后旧文件重命名为 `<name>.migrated-<epoch>`: 它是迁移前状态的唯一副本, 留在磁盘上,
-- 但不再是一份用户可以编辑却不生效的配置。重命名发生在事务提交之后 —— 事务内改名会在回滚
-- 后幸存, 把唯一的配置副本一起带走。
--
-- 导入只由启动中的服务端触发 (server.ts), 读路径一律不隐式触发: 否则任何只是读一下设置的
-- 进程 (单测、一次性脚本) 都会改写并弃用用户的真实文件。
INSERT OR REPLACE INTO schema_migrations (id, applied_at) VALUES
  ('config.import_workspaces.v1', 0),
  ('config.import_settings.v1', 0),
  ('config.import_session_state.v1', 0);
