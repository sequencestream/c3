-- funnel_event — park 状态跃迁的本机观测事件
-- 所属模块: queue
-- 对应 Store: server/src/features/intents/funnel-store.ts
--
-- 只回答一个问题:「意图被 park 之后, 人到底有没有把它捞回来」。据此判断本批 park 指引
-- 是否有效, 以及后续 P1/P2 是否值得投入。
--
-- 硬边界: 六列, 每列不是 id 就是封闭枚举或时间戳, 结构上装不下自由文本。stage 与
-- reason_code 在写入边界按允许集合校验, 因此 park_detail、意图标题、日志摘要即便被误传
-- 也进不来。这条约束是刻意的: 一张装不下散文的表, 日后无法被悄悄改造成遥测。
--
-- 数据只留在本机, 不外传、不导出; 固定滚动保留 90 天, 写事件与读统计两条路径都会做幂等
-- 清理 (删除 at < now - 90 天, 恰好 90 天的保留)。
--
-- 与 queue_intent_state 的关系: 那张表存「当前是否 park」, 本表存「park 发生过几次、
-- 何时被解除」。意图被删除时 queue_intent_state / queue_decision_log 会被清理, 本表不清理
-- —— 观测的是已经发生的事实, 直到滚动过期为止。

CREATE TABLE IF NOT EXISTS funnel_event (
  id           TEXT PRIMARY KEY,          -- 事件唯一 id (uuid)
  workspace_id TEXT NOT NULL,             -- 规范化 (resolve 后) 工作区路径, 即协议 workspaceId 解析所得; 按工作区隔离统计
  intent_id    TEXT NOT NULL,             -- 发生跃迁的意图 id (intents.id); 意图删除后不清理本表
  stage        TEXT NOT NULL,             -- 封闭枚举: 'parked' | 'unparked'; 写入边界校验, 其他值一律拒绝
  reason_code  TEXT NOT NULL,             -- parked=QueueReasonCode; unparked=固定 'manual_unpark'; 写入边界校验, 不接受自由文本
  at           INTEGER NOT NULL           -- 跃迁写入时间 (epoch ms), 服务端时钟
);
CREATE INDEX IF NOT EXISTS idx_funnel_event_workspace_stage_at ON funnel_event(workspace_id, stage, at);
CREATE INDEX IF NOT EXISTS idx_funnel_event_pair ON funnel_event(workspace_id, intent_id, stage);
CREATE INDEX IF NOT EXISTS idx_funnel_event_at ON funnel_event(at);
