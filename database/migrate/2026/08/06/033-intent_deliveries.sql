-- 新增 delivery 领域关联边表 intent_deliveries (意图 ↔ 交付)
--
-- 运行时迁移由 server/src/features/deliveries/store.ts 与
-- server/src/features/intents/store.ts 的 schema ensure 幂等执行
-- (`CREATE TABLE IF NOT EXISTS` + 索引创建), 可重复执行; 从不 DROP。
-- 本文件与两处 SCHEMA 声明保持同一 DDL, 供存量库与文档参照。
--
-- 为什么加这张表: 032 建交付时, 「意图属于哪个交付」只能从 intent_prs.delivery_id
-- 间接推断 —— 而那是 PR 事实, 不是关联事实。关联先于 PR 存在 (刚关联时还没提 PR),
-- 解除关联时 PR 行会被删除而关联边的生死要独立判定。用「有没有 PR 行」代表「有没有
-- 关联」会让「已关联但尚未提 PR」这个最常见的中间态无处安放。
--
-- 为什么两个 store 都声明: 永久删除意图要在同一事务里 DELETE 本表。一个从未打开过
-- 交付页的库里, delivery store 的 schema ensure 还没跑过, 那条 DELETE 会撞
-- "no such table" 并让整个删除事务回滚。两处都是 IF NOT EXISTS, 先初始化的那个建表。
--
-- 唯一索引此刻不加以后也难加: 重复关联在应用层先判 (返回 delivery.intentAlreadyLinked),
-- 索引是并发下的兜底。同一意图对多个交付各一条边是允许的 (多交付关联的数据能力保留,
-- 第一版前端不开放入口), 故唯一键是 (delivery_id, intent_id) 而不是 intent_id。
--
-- 存量无数据回填: 交付是 032 之后的新实体, 不存在需要回填的历史关联。

CREATE TABLE IF NOT EXISTS intent_deliveries (
  id          TEXT PRIMARY KEY,
  delivery_id TEXT NOT NULL,
  intent_id   TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_intent_delivery_unique
  ON intent_deliveries(delivery_id, intent_id);
CREATE INDEX IF NOT EXISTS idx_intent_delivery_delivery ON intent_deliveries(delivery_id);
CREATE INDEX IF NOT EXISTS idx_intent_delivery_intent ON intent_deliveries(intent_id);
