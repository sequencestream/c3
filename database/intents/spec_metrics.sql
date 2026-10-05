-- spec_metrics — 规格质量度量(基线指标 + 只读分析器告警)
-- 一张表两类行:
--   kind='baseline' —— 四项对照指标的存量聚合(中位评审耗时 / 复述准确率 / 边界遗漏 / 告警误报率)
--   kind='warning' —— 每次只读扫描命中的规则 id / 位置 / 提示语 / 严重级
-- 告警是落库旁路,不参与提示词、不改变会话行为;severity 恒为 warn,本阶段无阻断。
-- 所属模块: intents
-- 对应 Store: server/src/features/intents/spec-metrics-store.ts


CREATE TABLE IF NOT EXISTS spec_metrics (
  id              TEXT PRIMARY KEY,                 -- uuid
  kind            TEXT    NOT NULL CHECK(kind IN ('baseline','warning')),
  intent_id       TEXT,                              -- 告警行:所属意图;基线行:NULL(全工作区聚合)
  rule_id         TEXT,                              -- 告警行:规则集条目 id;基线行:指标名
  detection       TEXT,                              -- 告警行:检测方式;基线行:NULL
  severity        TEXT    NOT NULL DEFAULT 'warn' CHECK(severity = 'warn'),
  location        TEXT,                              -- 告警行:JSON {section,line};基线行:NULL
  message         TEXT,                              -- 告警行:提示语;基线行:口径说明
  spec_fingerprint TEXT,                             -- 告警行:命中时的 spec 内容 sha256
  sample_size     INTEGER,                           -- 基线行:样本量
  value           REAL,                              -- 基线行:指标取值
  created_at      INTEGER NOT NULL                   -- 写入时间 (epoch ms)
);
CREATE INDEX IF NOT EXISTS idx_spec_metrics_kind_created ON spec_metrics(kind, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_spec_metrics_rule ON spec_metrics(kind, rule_id);
CREATE INDEX IF NOT EXISTS idx_spec_metrics_intent ON spec_metrics(intent_id, created_at DESC);
