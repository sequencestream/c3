-- user_workspace_scope_items — user_workspace_scopes 的选定工作区明细
-- 所属模块: auth
-- 对应 Store: server/src/features/auth/scope-store.ts
-- 迁移: migrate/2026/08/14/040-user-workspace-scopes.sql
--
-- 仅 mode='selected' 时有意义; mode='all' 的 subject 不写明细行。写入是整体替换 (先删后
-- 插), 与 user_workspace_scopes 的 mode 及 policy epoch 同事务提交。
--
-- 不设外键: 工作区注册表移除只置 registered=0 从不删行, 而一个已消失的名称必须退化为
-- 「什么也到不了」, 不能级联删掉管理员仍想看到的配置。解析时按活注册表过滤, 陈旧明细行
-- 因此是惰性的, 不是危险的。

CREATE TABLE IF NOT EXISTS user_workspace_scope_items (
  subject        TEXT NOT NULL,  -- 引用 user_workspace_scopes.subject
  workspace_name TEXT NOT NULL,  -- 引用 workspaces.name (弱引用, 可陈旧)
  created_at     INTEGER NOT NULL,
  PRIMARY KEY (subject, workspace_name)
);
CREATE INDEX IF NOT EXISTS idx_user_workspace_scope_item_workspace
  ON user_workspace_scope_items(workspace_name);
