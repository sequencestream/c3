-- 提供方上游模型清单缓存：一个 provider 一行
--
-- provider 的「上游模型清单」不再是随版本发布的常量：c3 按方言请求 provider 自己的模型清单
-- 接口，把结果缓存到这里。解析顺序固定为「抓取结果 → 本表缓存 → 写死的厂商目录」，本表是
-- 中间那一环，也是「抓取失败不清空、旧数据继续可用」的落点。
--
-- provider_id 是**弱引用**：无外键、无级联、读时不 JOIN 配置(provider 本身是 system_configs
-- 里的展开行，不是一张表)。删除一条 provider 不会连带删掉它的缓存行，孤儿行永远读不到 ——
-- 缓存的身份就是 id，新建一条恰好重名的 provider 不继承任何东西。provider 增删随配置走，
-- 缓存行不需要单独的生命周期。
--
-- models_json 存 ModelProviderModel[] (只含 id；能力元数据由用户声明，不从上游抓)。
-- 一次成功抓取写入清单并把 cached_at 前移；失败/不可能抓取(无 URL、无 key)时该列保持
-- 原值且**不写 null 覆盖**，这就是「失败不清空旧缓存」在存储层的表达。
--
-- 三个时间戳各司其职，不可互相替代：
--   created_at      行诞生时间，任何后续写入都不动它
--   updated_at      最近一次写入时间(成功与失败都前移)
--   cached_at       最近一次**成功**抓取时间，TTL(默认 24h)只认它 ——
--                   否则一次失败就会让一天前的旧清单重新显得「新鲜」
--   last_fetched_at 最近一次抓取**尝试**时间，负缓存退避(默认 5min)只认它
-- last_fetch_result 记录该次尝试的结局：ok / failed / skipped(没有可拨的 URL 或没有 key)。
--
-- 无 PRAGMA user_version：建表由 provider-model-cache.ts 惰性 CREATE TABLE IF NOT EXISTS
-- 覆盖新库与旧库(全局共享整数无法作为本模块的迁移判据，见 database/tables.md infra 一节)。

CREATE TABLE IF NOT EXISTS provider_model_caches (
  provider_id       TEXT    PRIMARY KEY,
  models_json       TEXT,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  cached_at         INTEGER,
  last_fetched_at   INTEGER,
  last_fetch_result TEXT    NOT NULL CHECK(last_fetch_result IN ('ok','failed','skipped')),
  last_fetch_error  TEXT
);
