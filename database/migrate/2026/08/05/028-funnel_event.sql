-- 028: 本机基线观测 — 新增 queue 模块 funnel_event 表 (queue schema v1 → v2)
--
-- 背景: 队列已经能持久化 park 状态并允许人工 unpark, 但 queue_decision_log 按工作区只留最近
-- 2000 条, 无法稳定还原一段时间内的 park→恢复漏斗。要判断本批 park 指引是否真的有效、后续
-- P1/P2 是否值得投入, 需要一份严格限域的状态跃迁记录。
--
-- 只记跃迁, 不记内容: 六列全是 id / 封闭枚举 / 时间戳。stage ∈ {parked, unparked},
-- reason_code 在 parked 侧复用 QueueReasonCode、在 unparked 侧固定为 'manual_unpark',
-- 两者都在写入边界按允许集合校验。因此 queue_intent_state.park_detail、意图标题、日志摘要
-- 结构上无法进入本表 —— 这是刻意的, 一张装不下自由文本的表无法被改造成遥测。
--
-- 采集接在队列 park 标记的四个写入口之后 (recordFailure 的失败爬梯 / applyPark /
-- clearPark / applyHumanOverride), 且严格在状态持久化成功之后: 状态没写成不产生事件,
-- 事件没写成也不回滚已经成功的 park/unpark。
--
-- 保留: 固定滚动 90 天, 追加事件与读取统计两条路径都会幂等清理 (删除 at < now - 90 天,
-- 恰好 90 天的保留), 所以长期无跃迁的库在用户打开统计时也不会读到超期数据。
--
-- 兼容性: 纯新增, 不改动任何既有表/列/索引。不回填 queue_decision_log —— 它限量保留,
-- 无法可靠证明所有历史 park/unpark 的配对关系, 上线前的历史一律不计入基线。旧库首次使用时
-- 建空表, 统计从「暂无足够样本」开始, 不推断也不伪造历史。
-- 幂等: store 以 CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS 惰性建表,
-- 可重复执行。

CREATE TABLE IF NOT EXISTS funnel_event (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  intent_id    TEXT NOT NULL,
  stage        TEXT NOT NULL,
  reason_code  TEXT NOT NULL,
  at           INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_funnel_event_workspace_stage_at ON funnel_event(workspace_id, stage, at);
CREATE INDEX IF NOT EXISTS idx_funnel_event_pair ON funnel_event(workspace_id, intent_id, stage);
CREATE INDEX IF NOT EXISTS idx_funnel_event_at ON funnel_event(at);
