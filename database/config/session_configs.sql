-- session_configs — 每会话的持久化事实 (原两份 state.json 的 session 维度)
-- 所属模块: config
-- 对应 Store: server/src/kernel/config/index.ts (绑定空间) + server/src/state.ts (模式)
-- 迁移: migrate/2026/08/12/038-config-tables.sql
--
-- 一会话一作用域, 容纳两类互不重叠的键, 各由自己的模块写入:
--   绑定空间 (ADR-0015): agentId / vendor / storeScope / groupCursor / pendingCreatedAt
--   会话设置:            mode / codexPolicy.sandboxMode / codexPolicy.approvalPolicy
--
-- 意图 (intent) 与事实 (fact) 靠键区分而不是靠两张表: 带 pendingCreatedAt 的是尚未绑定
-- 的意图 (session_id 形如 `pending:<uuid>`), 带 vendor 的是已绑定的事实。vendor 是事实
-- 的不可变半边 —— 会话记录只存在于该 vendor 自己的 transcript 存储里, 换 vendor 就等于
-- 换了一份不存在的历史。
--
-- 写入按会话进行: 绑定变更只写这一个会话的绑定键, 不触碰它的 mode/codexPolicy, 反之亦然。

CREATE TABLE IF NOT EXISTS session_configs (
  session_id   TEXT NOT NULL,     -- 真实 vendor 会话 id, 或 `pending:<uuid>`
  config_key   TEXT NOT NULL,
  config_value TEXT,
  config_type  TEXT NOT NULL,     -- string | number | boolean | json | secret
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (session_id, config_key)
);
