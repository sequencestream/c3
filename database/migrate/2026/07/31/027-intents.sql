-- intents 新增 spec 审核事实字段 — 只读审核结论、返工轮次与机器批准抑制
--
-- 运行时迁移由 server/src/features/intents/store.ts 的 schema ensure 幂等执行
-- (`PRAGMA table_info` 列存在性检查 + ALTER TABLE ADD COLUMN)，可重复执行；从不 DROP。
-- SCHEMA_VERSION v16 → v17。
--
-- 无历史数据回填：旧行按「无结论、0 轮返工、未被人工否决」解释，已有未批准 spec 可直接
-- 进入审核，无需重新撰写。既有 spec_path / spec_approved / spec_approve_user 一律不改动。
--
-- 结论有效性绑定 spec_review_fingerprint：审核发起时对 spec 内容取指纹，结论只在指纹与
-- spec 实时内容一致时有效。spec 在审核期间或结论产生后被改写，旧结论自然失效，无需额外
-- 的清理任务。spec_review_machine_blocked 由人工撤销批准置 1，使下一 tick 不能把同一条
-- 结论反向覆盖回已批准；新的有效结论或人工批准会将其清零。
--
-- 机器批准写入 spec_approve_user 的是保留常量 'c3:machine-spec-approver'（协议中的
-- MACHINE_SPEC_APPROVER），不冒充任何登录 subject，因此「谁批准的」始终可区分。

ALTER TABLE intents ADD COLUMN spec_review_session_id      TEXT;
ALTER TABLE intents ADD COLUMN spec_review_verdict         TEXT;
ALTER TABLE intents ADD COLUMN spec_review_reason          TEXT;
ALTER TABLE intents ADD COLUMN spec_review_at              INTEGER;
ALTER TABLE intents ADD COLUMN spec_review_fingerprint     TEXT;
ALTER TABLE intents ADD COLUMN spec_review_rework_rounds   INTEGER NOT NULL DEFAULT 0;
ALTER TABLE intents ADD COLUMN spec_review_machine_blocked INTEGER NOT NULL DEFAULT 0;
