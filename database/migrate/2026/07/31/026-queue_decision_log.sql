-- 026: 自动化队列确定性调度内核 — 新增 queue 模块三张表 (queue schema v0 → v1)
--
-- 背景: 自动化队列从「只被 run:settled 事件推动的内存状态机」换成「10s tick 全量对账 +
-- 事件合并标脏」的确定性内核。事实源仍是 intents 账本 + run 存活探测; 本次只落三样东西:
--   1. queue_workspace_state — 用户「启动/暂停」的意愿, 使服务重启后能恢复而非静默变 idle;
--   2. queue_intent_state    — 单意图失败次数 / 退避 / park / 冷却, 支撑失败隔离;
--   3. queue_decision_log    — 逐 tick/intent 的决策审计, 回答「现在为什么不动了」。
--
-- 刻意不建重型 FSM 表: 运行阶段、当前会话、闸门结果全部每轮从事实重推导。
-- 刻意不复用 automation_execution_logs: 那张表按「一次自动化执行」计量, 粒度对不上。
--
-- 兼容性: 纯新增, 不改动任何既有表/列/索引。历史意图没有 queue_intent_state 行,
-- 读取端按「零次失败、未 park、无退避/无冷却」解释, 无需回填; 决策日志从上线时刻开始记录。
-- 幂等: store 以 CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS 惰性建表,
-- 可重复执行。

CREATE TABLE IF NOT EXISTS queue_workspace_state (
  workspace_path TEXT PRIMARY KEY,
  state          TEXT NOT NULL,
  started_at     INTEGER,
  force_skipped  TEXT NOT NULL DEFAULT '[]',
  updated_at     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS queue_intent_state (
  intent_id      TEXT PRIMARY KEY,
  workspace_path TEXT NOT NULL,
  failure_count  INTEGER NOT NULL DEFAULT 0,
  backoff_count  INTEGER NOT NULL DEFAULT 0,
  backoff_until  INTEGER,
  parked         INTEGER NOT NULL DEFAULT 0,
  park_reason    TEXT,
  park_detail    TEXT,
  cooldown_until INTEGER,
  updated_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_queue_intent_workspace ON queue_intent_state(workspace_path);

CREATE TABLE IF NOT EXISTS queue_decision_log (
  id             TEXT PRIMARY KEY,
  tick_id        TEXT NOT NULL,
  workspace_path TEXT NOT NULL,
  intent_id      TEXT NOT NULL,
  decided_at     INTEGER NOT NULL,
  action         TEXT NOT NULL,
  blocked_gate   TEXT,
  reject_reason  TEXT,
  attempt_count  INTEGER NOT NULL DEFAULT 0,
  backoff_count  INTEGER NOT NULL DEFAULT 0,
  next_wakeup_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_queue_decision_workspace ON queue_decision_log(workspace_path, decided_at DESC);
CREATE INDEX IF NOT EXISTS idx_queue_decision_intent ON queue_decision_log(intent_id, decided_at DESC);
