-- workspaces — 工作区注册表 (唯一名称 ↔ 磁盘 path)
-- 所属模块: config
-- 对应 Store: server/src/kernel/config/workspace-store.ts
-- 迁移: migrate/2026/08/12/038-config-tables.sql、migrate/2026/08/14/039-workspace-name-identity.sql
--
-- name 是协议对外的工作区身份, 也是 workspace_configs 与各业务表关联所依附的主键。
-- 名称去除首尾空白后长度为 1–64 个 Unicode 字符, 全局唯一、区分大小写且创建后不可修改。因而从
-- 列表移除一个工作区只置 registered=0 而不删行: 删行会让它的配置成为孤儿, 重新添加
-- 同一目录仍恢复原名称与设置。
--
-- registered=0 有两种来源: 用户移除过的工作区, 以及只在旧 settings.json 的
-- projectConfigs 里出现、从未注册过的路径 (历史上积攒了大量 /tmp 临时目录)。两者都
-- 保留配置但不出现在工作区列表里。

CREATE TABLE IF NOT EXISTS workspaces (
  name          TEXT PRIMARY KEY CHECK(length(name) BETWEEN 1 AND 64), -- 唯一且不可变
  path          TEXT NOT NULL UNIQUE,       -- resolve 后的绝对路径
  last_accessed INTEGER NOT NULL,           -- 最近访问 (epoch ms), 侧边栏排序依据
  registered    INTEGER NOT NULL DEFAULT 1, -- 1=在工作区列表中; 0=仅保留配置
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
