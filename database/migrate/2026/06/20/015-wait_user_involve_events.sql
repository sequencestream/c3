-- 015 — wait_user_involve_events 新增共识自动决策审计列
-- 日期: 2026-06-20
-- 影响 store / 版本跨度:
--   user-involve (wait_user_involve_events)  v2 → v3
--
-- 背景: 多 Agent 共识自动决议(consensus_auto)此前只发 wire 帧、不留任何可追溯记录。
-- 本意图让网控在自动决议时记录一条 status='auto' 的非阻塞 WaitUserInvolveEvent,
-- 使「自动决策可追溯但不阻塞」(不计待处理徽章、不阻断续跑)。
--   - outcome : JSON, 仅 status='auto' 记录携带 (AnyConsensusOutcome —— 投票/裁决/摘要),
--               人类决策的事件为 NULL。可空,历史行保持 NULL。
--
-- 同时 status 取值域扩展: 'todo' | 'done' | 'canceled' | 'auto' (= WaitUserInvolveStatus)。
-- 'auto' 是新增的非阻塞审计态;无需迁移既有行(旧行仍是三态之一)。
--
-- 迁移由 store 的 ensureColumn(d, 'wait_user_involve_events', 'outcome', 'TEXT') 在
-- exec(SCHEMA) 之后执行,幂等且可重入(以 PRAGMA table_info 守卫,缺列才 ADD)。
-- 从不 DROP、不丢数据。下面的等价 DDL 仅作记录,真实迁移在 store.ts 中以幂等守卫执行。

ALTER TABLE wait_user_involve_events ADD COLUMN outcome TEXT;
