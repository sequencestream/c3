-- 提供方上游模型清单缓存表 (2026-10-09-001)
--
-- 新增 `provider_model_caches`：一个 provider 一行，存运行时抓到的上游模型清单与抓取状态。
-- 新库与旧库都由 store 惰性 `CREATE TABLE IF NOT EXISTS` 建立，无需 ALTER，故本文件只是变更
-- 记录（结构定义见 database/config/provider_model_caches.sql）。
--
-- 不回填、不迁移数据：缓存按需自然建立 —— 某条 provider 第一次被读取清单时才产生第一行，
-- 没有缓存时回落写死的厂商目录，功能与本次变更之前完全一致（内置目录仍在，仍可离线工作）。
--
-- 为什么单独一张表而不是复用 system_configs 的展开行：provider 的展开行属于 SystemSettings，
-- 整份系统设置保存时会删掉它没有提到的 config_key，把缓存挂在那里要么每次保存被清掉、要么
-- 得把整个 modelProviders 前缀列为保留前缀 —— 那样被删除的 provider 会靠残留的缓存行重新
-- 物化出一个只有缓存字段的幽灵记录。缓存是配置的派生物，不是配置本身，所以它有自己的一张表。

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
