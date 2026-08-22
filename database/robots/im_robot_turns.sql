-- im_robot_turns — 机器人回合审计 (每一次把 agent 产出发往第三方云都留一行)
-- 所属模块: robots
-- 对应 Store: server/src/features/im/robot-store.ts
-- 迁移: migrate/2026/08/20/044-im-robots.sql, migrate/2026/08/21/045-im-robot-turns-busy.sql, migrate/2026/08/21/046-im-robot-sender-isolation.sql
--
-- 存在理由: ADR-0046 的四条授权凭据之一。默认关闭与启用前确认管的是「授权发生过」, 本表管的是
-- 「实际发生了什么」—— 没有它, 一个已启用的机器人对外说过多少话就无从复核。
--
-- 只记元数据, 不记正文。outbound_chars 是长度而非内容, 入站消息也只留 id。IM 可见正文只存在于
-- 受 ADR-0048 约束的 im_robot_context_turns; 审计仍不存正文。
--
-- outcome 覆盖全部结局, 包括没有发出去的那些:
--   guard_refused —— 出站守卫拒绝 (凭据形状命中是其中一种原因); 若改发了固定拦截提示, outbound_chars
--                    记该提示的实际长度
--   blocked —— 回合撞上一个无人能答的权限请求
--   timeout —— 墙钟到点
--   input_rejected —— 入站凭据/超长守卫拒绝 (封闭原因在 reject_reason)
--   busy —— 同 Conversation 已有在途回合, 未启动 agent run, 但发送了忙碌提示
-- 它们同样要留痕。
--
-- error 只存诊断文本, 绝不含密钥, 也不是回帖给用户的那句话。

CREATE TABLE IF NOT EXISTS im_robot_turns (
  id             TEXT PRIMARY KEY,   -- uuid
  robot_id       TEXT NOT NULL,      -- 引用 im_robots.id
  thread_key     TEXT NOT NULL,      -- 与 Conversation.thread_key 同形
  chat_id        TEXT NOT NULL,      -- 平台会话 id
  sender_id      TEXT NOT NULL,      -- 发起提问的平台用户 id
  in_message_id  TEXT NOT NULL,      -- 触发本回合的入站消息 id
  session_id     TEXT,               -- 本回合运行的 agent 会话 id; 启动失败时为空
  started_at     INTEGER NOT NULL,   -- epoch ms
  finished_at    INTEGER,            -- epoch ms; 空 = 仍在进行 (或进程中断)
  outcome        TEXT                -- complete / error / blocked / timeout / guard_refused / input_rejected / busy
                 CHECK(outcome IS NULL OR outcome IN
                   ('complete','error','blocked','timeout','guard_refused','input_rejected','busy')),
  reject_reason  TEXT                -- 仅 input_rejected: credential | too_long
                 CHECK(reject_reason IS NULL OR reject_reason IN ('credential','too_long')),
  outbound_chars INTEGER NOT NULL    -- 实际发往平台的字符数; 0 = 什么都没发出去
                 DEFAULT 0,
  out_message_id TEXT,               -- 平台返回的回帖消息 id
  error          TEXT                -- 诊断文本, 不含凭据
);
CREATE INDEX IF NOT EXISTS idx_im_turn_robot ON im_robot_turns(robot_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_im_turn_thread ON im_robot_turns(robot_id, thread_key, started_at DESC);
