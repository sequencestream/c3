-- queue_decision_log — 自动化队列的逐 tick/intent 调度决策日志
-- 所属模块: queue
-- 对应 Store: server/src/features/intents/queue-store.ts
--
-- 回答「现在为什么不动了」。刻意不复用 automation_execution_logs: 那张表按「一次自动化执行」
-- 计量, 与「一次 tick 对某条意图的取舍」粒度对不上。
-- 只记结构化原因码与摘要, 绝不记录 prompt / 凭据 / 权限请求正文 / transcript。
-- 写入失败不放宽任何闸门、不制造重复 launch, 由后续 tick 继续对账。

CREATE TABLE IF NOT EXISTS queue_decision_log (
  id             TEXT PRIMARY KEY,          -- 决策行唯一标识 (UUID v4)
  tick_id        TEXT NOT NULL,             -- 产生该决策的对账轮次 id (同一轮 tick 的所有行共享)
  workspace_path TEXT NOT NULL,             -- 所属工作区绝对路径 (resolve 后)
  intent_id      TEXT NOT NULL,             -- 意图 id; 空串 = 工作区级决策 (如快照不可读 fail closed)
  decided_at     INTEGER NOT NULL,          -- 决策时间 (epoch ms)
  action         TEXT NOT NULL,             -- 选择的动作: 'launch'|'resume'|'attach'|'wait'|'park'|'block'|'skip'
  blocked_gate   TEXT,                      -- 被哪个闸门挡住 / 结果原因码 (QueueReasonCode)
  reject_reason  TEXT,                      -- 拒绝理由摘要 (可展示, 不含敏感载荷)
  attempt_count  INTEGER NOT NULL DEFAULT 0,-- 决策时的连续失败次数
  backoff_count  INTEGER NOT NULL DEFAULT 0,-- 决策时的累计退避次数
  next_wakeup_at INTEGER                    -- 下次唤醒时间 (epoch ms); NULL=下一次常规 tick
);
CREATE INDEX IF NOT EXISTS idx_queue_decision_workspace ON queue_decision_log(workspace_path, decided_at DESC);
CREATE INDEX IF NOT EXISTS idx_queue_decision_intent ON queue_decision_log(intent_id, decided_at DESC);
