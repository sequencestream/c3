-- system_configs — 系统级配置 (原 ~/.c3/settings.json 的顶层字段)
-- 所属模块: config
-- 对应 Store: server/src/kernel/config/config-store.ts + kernel/config/index.ts
-- 迁移: migrate/2026/08/12/038-config-tables.sql
--
-- 一字段一行。config_key 是点分字段路径 (`proxy.enabled`、`agents.<id>.config.model`),
-- config_type 说明 config_value 怎么解码。只有"多值且无稳定身份"的子树才整体落 json
-- (degradationChain、skill 挂载索引), 展开规则集中在 kernel/config/config-schema.ts。
--
-- 为什么细粒度: 整份文档读改写要求写入方带上它并不拥有的字段, 于是需要一套反覆盖合并
-- 逻辑去补救; 一行一字段之后, 保存工作区配置与保存系统配置在存储层就不再相交。
--
-- 本表同时容纳两类不属于 SystemSettings 的键, 它们只是共享这张表:
--   `state.*`   — 原 state.json 的全局部分 (活动会话、skill 挂载索引与 ack)
--   `agentLang` — 服务端 agent 提示词语言 (个性化设置的兄弟键)
-- 整体保存系统设置时以 preservePrefixes 保护它们, 不属于本次写入的 key 才被删除。
--
-- config_type='secret' 的值是 encryption.ts 的 `c3secretv1:` 密文 (agent apiKey、
-- auth 账号口令哈希), 读时解密、写时加密; 内存缓存始终是明文, 落库始终是密文。

CREATE TABLE IF NOT EXISTS system_configs (
  config_key   TEXT PRIMARY KEY,  -- 点分字段路径; 段内的 `.` 以 %2E 转义
  config_value TEXT,              -- 编码后的值; NULL 表示显式空值
  config_type  TEXT NOT NULL,     -- string | number | boolean | json | secret
  updated_at   INTEGER NOT NULL
);
