-- 新增 delivery_logs: 交付生命周期变更日志 (操作审计轨迹)
--
-- 运行时迁移由 server/src/features/deliveries/store.ts 的 schema ensure 幂等执行
-- (`CREATE TABLE IF NOT EXISTS` + 索引创建), 可重复执行; 从不 DROP。
-- 本文件与 database/deliveries/delivery_logs.sql、store.ts 的 SCHEMA 保持同一 DDL。
--
-- 为什么要这张表: 交付进入 delivered 是「代码已经在主线上」这一不可撤销事实的
-- 落定, 它由系统在感知到交付 PR 被合并时写入, 而不是人再点一次。状态写与日志行
-- 必须在同一事务内完成, 否则会出现「状态已发布但台账没有任何痕迹」, 事后无从
-- 回答「谁、什么时候、凭哪条 PR 把它发布的」。仿 intent_logs, 只增不改不删。
--
-- 存量无数据回填: 历史交付的过往操作没有留痕可追认, 凭空补一行等于发明事实。
CREATE TABLE IF NOT EXISTS delivery_logs (
  id             TEXT PRIMARY KEY,
  delivery_id    TEXT NOT NULL,
  operation_type TEXT NOT NULL,
  summary        TEXT NOT NULL,
  actor          TEXT NOT NULL,
  created_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_delivery_log_delivery_created
  ON delivery_logs(delivery_id, created_at DESC);
