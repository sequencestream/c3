-- intent_sessions 新增 delivery_id (可空) —— 会话的交付上下文
--
-- 运行时迁移由 server/src/features/intents/store.ts 的 schema ensure 幂等执行
-- (ensureColumn: PRAGMA table_info 判缺再 ALTER),可重复执行;从不 DROP。
-- 本文件与 database/intents/intent_sessions.sql 的声明保持同一 DDL,供存量库参照。
--
-- 为什么加这一列: 交付引入后,「我的 base 是什么」不再由意图唯一决定 —— 一个意图可
-- 关联多个交付,每个交付是一条不同的分支。worktree 基线与依赖闸门判据都要读这个上下
-- 文,因此它必须是「会话」的属性而不是「意图」的属性,并且要在 fresh 启动时定下、由
-- resume/attach 原样复用,而不是每次恢复重新猜一遍。
--
-- 为什么可空且不回填: NULL 表示「本次会话没有交付上下文」,这正是未关联交付的意图与
-- 交付能力上线前所有历史会话的真实情况。给历史行补一个交付等于把它们的基线与闸门口径
-- 追认到一个它们从未开发过的交付上,属于凭空发明事实。

ALTER TABLE intent_sessions ADD COLUMN delivery_id TEXT;
