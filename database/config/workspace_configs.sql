-- workspace_configs — 每工作区配置 (原 settings.json 的 projectConfigs[path])
-- 所属模块: config
-- 对应 Store: server/src/kernel/config/config-store.ts + kernel/config/index.ts
-- 迁移: migrate/2026/08/12/038-config-tables.sql
--
-- 一工作区一作用域、一字段一行 (defaultMode.claude、consensus.enabled、sandbox.enabled…)。
-- 键是 workspaces.name 而不是路径: 路径会因目录移动而改变, 而配置应当跟着工作区
-- 的身份走。展开规则见 WORKSPACE_RULES (kernel/config/config-schema.ts): 多值集合
-- (consensus.agentIds、sandbox.extraMounts、sandbox.sandboxSessionKinds) 整体落 json。
--
-- 与业务表一致,所有工作区关联都使用 workspace_name。

CREATE TABLE IF NOT EXISTS workspace_configs (
  workspace_name TEXT NOT NULL,     -- workspaces.name
  config_key   TEXT NOT NULL,
  config_value TEXT,
  config_type  TEXT NOT NULL,     -- string | number | boolean | json | secret
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (workspace_name, config_key)
);
