-- 050 — 机器人 L2 写授权、待办契约、令牌与写审计
-- 对应 DDL: database/robots/im_robot_write_grants.sql
--           database/robots/im_todo_tokens.sql
--           database/robots/im_robot_write_audits.sql
--           database/user-involve/im_todo_answer_contracts.sql
-- 实际迁移逻辑在 robot-store / write-grant-store / todo-token-store / answer-contract-store 的 ensureSchema 中。

-- im_robots.config_revision: 受哈希约束的配置修订号，默认 0。
-- intents.responsible_subject: 意图责任主体，创建后不可由普通编辑改写。
-- intents.spec_human_rework_*: 人工 spec 返工请求事实。
