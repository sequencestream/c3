-- delivery_logs — 交付生命周期变更日志 (操作审计轨迹)
-- 所属模块: deliveries
-- 对应 Store: server/src/features/deliveries/store.ts
-- 迁移: migrate/2026/08/07/036-delivery_logs.sql
-- 新建库时由 store.ts 的 SCHEMA 声明, 存量库由迁移补充, 两者 DDL 保持一致。
--
-- 只增不改不删 (仿 intent_logs)。交付进入 delivered 的状态写与它的日志行在同一
-- 事务内落定, 因此「代码已进主线但台账无痕」不可能出现。

CREATE TABLE IF NOT EXISTS delivery_logs (
  id             TEXT PRIMARY KEY,              -- 行唯一标识 (UUID v4)
  delivery_id    TEXT NOT NULL,                 -- 所属交付
  operation_type TEXT NOT NULL,                 -- 操作类型, 如 delivered / merge_conflict
  summary        TEXT NOT NULL,                 -- 人类可读摘要
  actor          TEXT NOT NULL,                 -- 操作者 (人工用户名, 系统写为 'system')
  created_at     INTEGER NOT NULL               -- 记录时间 (epoch ms)
);

CREATE INDEX IF NOT EXISTS idx_delivery_log_delivery_created
  ON delivery_logs(delivery_id, created_at DESC);
