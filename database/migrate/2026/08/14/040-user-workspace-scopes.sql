-- 外部 MCP 权限地基: 账号级工作区范围表 + MCP key 的 owner/secretVersion
--
-- 建表由 server/src/features/auth/scope-store.ts 在首次访问时以 CREATE TABLE IF NOT
-- EXISTS 幂等执行, 新库与旧库同一条路径; 本文件是该 schema 的变更记录。

CREATE TABLE IF NOT EXISTS user_workspace_scopes (
  subject    TEXT PRIMARY KEY,
  mode       TEXT NOT NULL CHECK(mode IN ('all','selected')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS user_workspace_scope_items (
  subject        TEXT NOT NULL,
  workspace_name TEXT NOT NULL,
  created_at     INTEGER NOT NULL,
  PRIMARY KEY (subject, workspace_name)
);
CREATE INDEX IF NOT EXISTS idx_user_workspace_scope_item_workspace
  ON user_workspace_scope_items(workspace_name);

-- mcp_api_keys 不做 ALTER TABLE: 它是 EAV 形状 (key_id, config_key, ...), ownerSubject
-- 与 secretVersion 是两个新的 config_key 行, 由 config-store 的作用域写入落库。
--
-- 历史 key 拿不到可信归属 —— 谁建的没记过, 猜一个管理员就是凭空发放权限。因此启动时
-- server/src/kernel/config/mcp-api-keys.ts 的 revokeUnownedMcpApiKeys 一律删除缺
-- ownerSubject 或 secretVersion 无效的 key 作用域: 不代管理员指派归属, 不保留旧的单工作区
-- 绑定, 也不升级其明文。管理员重建 key 并重新配置客户端。
--
-- 不用 schema_migrations 标记: 改造后没有任何路径能写出无 owner 的记录, 第二遍必然找不到
-- 东西, 每次启动都跑反而能覆盖两次运行之间被手工编辑的库。下面的等价 SQL 仅作记录。
--
-- 同一次迁移引入全局授权 epoch: system_configs 的 auth.policyEpoch 行, 缺行读作 0。

DELETE FROM mcp_api_keys
 WHERE key_id IN (
   SELECT key_id FROM mcp_api_keys
    GROUP BY key_id
   HAVING SUM(CASE WHEN config_key='ownerSubject'  AND COALESCE(config_value,'')<>'' THEN 1 ELSE 0 END)=0
       OR SUM(CASE WHEN config_key='secretVersion' AND CAST(COALESCE(config_value,'0') AS INTEGER)>0 THEN 1 ELSE 0 END)=0
 );
