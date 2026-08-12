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
-- workspace 是密钥被授权的唯一工作区 (canonical 绝对路径); 历史上的 `workspaces` 数组
-- 形态在读取时迁移: 恰好一个工作区的沿用, 多个或零个的一律吊销 —— `/mcp/<api-key>` 只有
-- 一个地址, 猜一个等于悄悄放大或缩小持有者被授予的范围。

CREATE TABLE IF NOT EXISTS mcp_api_keys (
  key_id       TEXT NOT NULL,     -- 密钥的非机密 id (16 位 hex)
  config_key   TEXT NOT NULL,     -- label / workspace / tools / algo / hashVersion / salt / hash / createdAt / lastUsedAt
  config_value TEXT,
  config_type  TEXT NOT NULL,     -- string | number | boolean | json | secret
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (key_id, config_key)
);
