-- personalized_configs — 每账号个性化设置 (原 settings.json 的 personalizedSettings)
-- 所属模块: config
-- 对应 Store: server/src/kernel/config/personalized.ts
-- 迁移: migrate/2026/08/12/038-config-tables.sql
--
-- subject 是服务端已验证的连接身份, 客户端无法指定要读写哪个账号。一账号一作用域, 因此
-- 一次个性化保存在存储层就不可能碰到另一个账号的记录, 更碰不到系统设置 —— 从前它们同处
-- 一份 settings.json, 靠写入方"记得把兄弟键挂回去"来保证, 这类保证一旦漏写就是静默丢数据。
--
-- 与之配套的 agentLang (服务端 agent 提示词语言) 是全局值, 落在 system_configs, 不属于
-- 任何账号, 也从不被当作某个人的偏好读回。

CREATE TABLE IF NOT EXISTS personalized_configs (
  subject      TEXT NOT NULL,     -- 已验证身份 (大小写敏感)
  config_key   TEXT NOT NULL,     -- uiLang / theme / fontScale
  config_value TEXT,
  config_type  TEXT NOT NULL,     -- string | number | boolean | json | secret
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (subject, config_key)
);
