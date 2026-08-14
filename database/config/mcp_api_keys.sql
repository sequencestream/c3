-- mcp_api_keys — 外部 MCP 访问密钥 (原 settings.json 的 mcpApiKeys 数组)
-- 所属模块: config
-- 对应 Store: server/src/kernel/config/mcp-api-keys.ts
-- 迁移: migrate/2026/08/12/038-config-tables.sql
--
-- 一密钥一作用域 (key_id 即密钥的非机密 id, 明文密钥形如 `c3k_<id>_<secret>`)。吊销一
-- 把密钥就是删掉它的作用域, 更新 lastUsedAt 就是改一行 —— 从前每次都要重写整个集合。
--
-- 只存 scrypt 摘要, 从不存明文: `hash` 以 config_type='secret' 落库 (encryption.ts 的
-- `c3secretv1:` 密文), 与之配套的 `salt` 不是秘密, 保持可读。校验时按 id 定位记录, 只做
-- 一次密钥派生, 再以常数时间比较。
--
-- ownerSubject 与 secretVersion 是可用记录的 NOT NULL 不变量, 且都是普通 config_key 行 ——
-- EAV 形状让它们无需 ALTER TABLE。缺任一项的记录不是可用密钥: 没有归属就没有可求交的权限,
-- 没有版本就无法把轮换前后的会话区分开; 这类记录由启动时的幂等清理直接删除。
--
-- workspaceName 只回答「这把密钥归档在哪」, **不授予任何访问权**。密钥能到达哪些工作区由
-- ownerSubject 在 user_workspace_scopes 里的范围决定。该字段**可空**: JSON null 是合法且
-- 有意的取值 —— 自助创建的密钥属于它的持有者而非任何页面, 一律归档为 null (既不写空字符串,
-- 也不虚构一个工作区名), 因而不出现在任何工作区寻址的名册与改动里。非空的名称仍须解析到已
-- 注册工作区, 解析不到的记录保持 fail-closed 丢弃: 声明了名字却指向空, 是损坏而不是「不归档」。

CREATE TABLE IF NOT EXISTS mcp_api_keys (
  key_id       TEXT NOT NULL,     -- 密钥的非机密 id (16 位 hex)
  config_key   TEXT NOT NULL,     -- label / ownerSubject / secretVersion / workspaceName / tools / algo / hashVersion / salt / hash / createdAt / lastUsedAt
  config_value TEXT,
  config_type  TEXT NOT NULL,     -- string | number | boolean | json | secret
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (key_id, config_key)
);
