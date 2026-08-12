-- workspaces — 工作区注册表 (wire 身份 id ↔ 磁盘 path)
-- 所属模块: config
-- 对应 Store: server/src/kernel/config/workspace-store.ts
-- 迁移: migrate/2026/08/12/038-config-tables.sql
--
-- 由 `${CLAUDE_CONFIG_DIR:-~/.claude}/c3/state.json` 的 workspaces 数组迁入。id 是
-- 协议对外的不透明工作区身份, 也是 workspace_configs 挂载配置所依附的主键, 因此从
-- 列表移除一个工作区只置 registered=0 而不删行: 删行会让它的配置成为孤儿, 重新添加
-- 同一目录还会换一个新 id, 用户看到的就是"设置莫名回到默认"。
--
-- registered=0 有两种来源: 用户移除过的工作区, 以及只在旧 settings.json 的
-- projectConfigs 里出现、从未注册过的路径 (历史上积攒了大量 /tmp 临时目录)。两者都
-- 保留配置但不出现在工作区列表里。

CREATE TABLE IF NOT EXISTS workspaces (
  id            TEXT PRIMARY KEY,           -- 不透明 uuid, 协议 workspaceId
  path          TEXT NOT NULL UNIQUE,       -- resolve 后的绝对路径
  name          TEXT NOT NULL,              -- 展示名 (默认取目录名)
  last_accessed INTEGER NOT NULL,           -- 最近访问 (epoch ms), 侧边栏排序依据
  registered    INTEGER NOT NULL DEFAULT 1, -- 1=在工作区列表中; 0=仅保留配置
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
