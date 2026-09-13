-- 055 — intents 新增 PR 评审/修复结果字段
-- 实际迁移逻辑在 intents store 的惰性 schema ensure(PRAGMA table_info 判列后 ALTER TABLE ADD COLUMN + user_version 24→25)。
-- 新库直接由 SCHEMA 建列; 旧库按列存在性检查幂等加列, 可重复执行, 从不 DROP。
--
-- Work 产出 PR 后的 AI 评审与修复结果此前无人持久, 用户与后续自动化只能从执行日志或
-- 事件里猜结论。这一层意图级快照承载「当前/最近一次 Review 会话与结论、闭环复审轮次、
-- 当前/最近一次 Fix 会话与结论」, 使读点得到明确结果而非推断。它不表达逐 PR/逐交付/逐
-- 提交的批准证明, 也不把结果复制到 intent_prs 行。
--
-- 五列: review_session_id / review_status / review_fix_rounds / fix_session_id / fix_status。
-- 四个可空字段历史行为 NULL, 轮次为 0; 不回填 —— 不扫描执行日志、PR 事件或会话来补猜
-- 结论。review_status/fix_status 以 CHECK 约束封闭取值, 与共享协议 INTENT_REVIEW_STATUSES /
-- INTENT_FIX_STATUSES 同源; 读模型对未知/越界值窄化为 NULL, 写入侧拒绝非法枚举。
--
-- 本次只加列, 不安装任何状态推进触发器: pending 的设置、下一轮重置、轮次递增、上限与
-- park 均由后续接力编排负责(意图 703e4795); 同步回填 MCP 只写终态及对应会话。
ALTER TABLE intents ADD COLUMN review_session_id  TEXT;
ALTER TABLE intents ADD COLUMN review_status      TEXT CHECK(review_status IN ('pending','approved','rejected'));
ALTER TABLE intents ADD COLUMN review_fix_rounds  INTEGER NOT NULL DEFAULT 0;
ALTER TABLE intents ADD COLUMN fix_session_id     TEXT;
ALTER TABLE intents ADD COLUMN fix_status         TEXT CHECK(fix_status IN ('pending','fixed'));
