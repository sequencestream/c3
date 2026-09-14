-- queue_intent_state — 自动化队列的单意图调度元数据
-- 所属模块: queue
-- 对应 Store: server/src/features/intents/queue-store.ts
--
-- 这里只保存「无法从意图账本 + run 存活探测重新推导」的那一点点状态: 连续失败次数、
-- 退避截止、park 标记与原因、防自激冷却, 以及评审认领/合并授权凭据 (见下)。运行阶段、
-- 当前会话、闸门结果一律每轮重推导, 因此本表不是 FSM 表, 丢一行最多多重试一次, 不会让队列卡死。
-- 历史意图没有行 = 零次失败、未 park、无退避/冷却、无认领/凭据 (无需回填)。
--
-- 合并凭据五列: 队列评审通过后自动合并活跃 PR 的事实依据。review_claim 记「哪个会话以哪一组 PR
-- 的哪一版 head SHA 认领了评审」, merge_grant 记「服务端认定那次评审会话给出 approved 后签发的
-- 合并授权」; merge_phase/merge_detail/merge_started_at 记合并编排的当前阶段与摘要。凭据只由
-- 服务端签发、任何失效条件置 NULL, 不读 MCP 参数里的 session id。

CREATE TABLE IF NOT EXISTS queue_intent_state (
  intent_id        TEXT PRIMARY KEY,          -- 意图 id (intents.id)
  workspace_name   TEXT NOT NULL,             -- 所属工作区绝对路径 (resolve 后)
  failure_count    INTEGER NOT NULL DEFAULT 0,-- 自上次真实推进以来的连续失败次数; 达到 3 次进入 park
  backoff_count    INTEGER NOT NULL DEFAULT 0,-- 累计退避次数 (审计计数器, unpark 不清零)
  backoff_until    INTEGER,                   -- 退避截止 (epoch ms); NULL=不在退避中
  parked           INTEGER NOT NULL DEFAULT 0,-- 0/1; 1=已 park, 不再自动启动, 但仍非 done, 下游依赖照常被挡
  park_reason      TEXT,                      -- park 原因码 (QueueReasonCode), 结构化可展示, 不含敏感载荷
  park_detail      TEXT,                      -- park 原因摘要 (可展示文本, 不含 prompt/凭据/权限正文/transcript)
  cooldown_until   INTEGER,                   -- 防自激冷却截止 (epoch ms); 内核刚为该意图发起 run 后设置
  review_claim     TEXT,                      -- 评审认领 JSON { sessionId, prs[], claimedAt }; 新认领覆盖旧认领
  merge_grant      TEXT,                      -- 合并授权凭据 JSON { reviewSessionId, prs[], grantedAt }; 失效置 NULL
  merge_phase      TEXT NOT NULL DEFAULT 'none', -- 合并编排阶段 none/pending/running/awaiting_sync/handed_back/completed
  merge_detail     TEXT,                      -- 合并阶段摘要 (可展示文本, 不含 prompt/凭据/权限正文/transcript)
  merge_started_at INTEGER,                   -- 开始合并的 epoch-ms
  updated_at       INTEGER NOT NULL           -- 最后更新时间 (epoch ms)
);
CREATE INDEX IF NOT EXISTS idx_queue_intent_workspace ON queue_intent_state(workspace_name);
