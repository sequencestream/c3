-- im_group_workspace_scopes — 群聊工作区明细白名单 (默认空 = 零明细权限)
-- 所属模块: robots (auth 边界)
-- 对应 Store: server/src/features/im/identity-store.ts
-- 迁移: migrate/2026/08/22/047-im-identity-and-call-level-scope.sql
--
-- chatAllowlist 只决定是否响应, 不是本表。工作区名是注册表弱引用; 求解时惰性失效。

CREATE TABLE IF NOT EXISTS im_group_workspace_scopes (
  platform              TEXT NOT NULL,
  provider_account_key  TEXT NOT NULL,
  chat_id               TEXT NOT NULL,
  workspace_name        TEXT NOT NULL,
  granted_by            TEXT NOT NULL,
  granted_at            INTEGER NOT NULL,
  PRIMARY KEY (platform, provider_account_key, chat_id, workspace_name)
);
CREATE INDEX IF NOT EXISTS idx_im_group_scope_chat
  ON im_group_workspace_scopes(platform, provider_account_key, chat_id);
