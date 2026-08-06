-- intent_deliveries — 意图 ↔ 交付关联边
-- 所属模块: deliveries
-- 对应 Store: server/src/features/deliveries/store.ts (写入唯一入口)
--             server/src/features/intents/store.ts (仅重复声明建表 + 删意图时清边)
-- 迁移: migrate/2026/08/06/033-intent_deliveries.sql
-- 新建库时由上述两个 store 的 SCHEMA 声明, 存量库由迁移补充, 三者 DDL 保持一致。
--
-- 为什么与 intent_prs.delivery_id 并存, 而不是复用它: 二者职责不同。
--   intent_prs.delivery_id —— 「这个意图对某个交付开了哪条 PR」(PR 事实)
--   intent_deliveries      —— 「这个意图属于哪个交付」(关联事实)
-- 关联先于 PR 存在 (刚关联时还没提 PR), 解除关联时 PR 行会被删除而关联边的生死要
-- 独立判定, 故不能用「有没有 PR 行」代表「有没有关联」。
--
-- 双 store 声明的理由: 永久删除意图要在同一事务里 DELETE 本表, 而一个从未打开过交付
-- 页的库里 delivery store 的 schema ensure 还没跑过, DELETE 会撞 "no such table"。
-- 两处都是 IF NOT EXISTS, 先初始化的那个建表, 互不冲突。
--
-- 生命周期:
--   建边   link_intent_to_delivery (唯一索引冲突 → delivery.intentAlreadyLinked)
--   删边   unlink_intent_from_delivery —— 但对本交付的 PR 已 merged 时一律拒绝
--          (本地 status + forge 实时状态双层检查): 代码已在交付分支上, 删边会造成
--          「关联没了但代码已在」, 只能靠 revert 收场。
--   删意图 同事务清本表 (远端 PR 不动)
--   取消交付 不删边 —— 终态交付的关联意图仍可查, 历史可查优先于表干净。
--
-- 数据模型保留「一个意图关联多个交付」(本表可多行, intent_prs 亦然); 第一版前端
-- 不开放该入口, 是交互层的克制, 不是数据层的限制。

CREATE TABLE IF NOT EXISTS intent_deliveries (
  id          TEXT PRIMARY KEY,   -- 关联边唯一标识 (UUID v4)
  delivery_id TEXT NOT NULL,      -- 交付 id (deliveries.id)
  intent_id   TEXT NOT NULL,      -- 意图 id (intents.id)
  created_at  INTEGER NOT NULL    -- 建边时间 (epoch ms); 意图侧「关联交付」按此排序
);
-- 一对 (交付, 意图) 至多一条边; 重复关联在应用层先判、由本索引兜底。
CREATE UNIQUE INDEX IF NOT EXISTS idx_intent_delivery_unique
  ON intent_deliveries(delivery_id, intent_id);
-- 两侧各建索引: 交付详情按 delivery_id 查关联意图, 意图列表按 intent_id 查关联交付。
CREATE INDEX IF NOT EXISTS idx_intent_delivery_delivery ON intent_deliveries(delivery_id);
CREATE INDEX IF NOT EXISTS idx_intent_delivery_intent ON intent_deliveries(intent_id);
