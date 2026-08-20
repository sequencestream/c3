-- im_robot_turns — 机器人回合审计 (每一次把 agent 产出发往第三方云都留一行)
-- 所属模块: robots
-- 对应 Store: server/src/features/im/robot-store.ts
-- 迁移: migrate/2026/08/20/044-im-robots.sql
--
-- 存在理由: ADR-0046 的四条授权凭据之一。默认关闭与启用前确认管的是「授权发生过」, 本表管的是
-- 「实际发生了什么」—— 没有它, 一个已启用的机器人对外说过多少话就无从复核。
--
-- 只记元数据, 不记正文。outbound_chars 是长度而非内容, 入站消息也只留 id。这不是节省空间:
-- ADR-0045 已经裁定不得把对话转录、代码或工具输入输出作为磁盘日志持久化, 而一份「外发内容副本」
-- 恰恰就是那个东西。审计要回答的是何时、对谁、发了多长、结果如何, 这些都不需要正文。
--
-- outcome 覆盖全部结局, 包括没有发出去的那些: guard_refused 是出站守卫在内容里认出凭据形状而
-- 拒发, blocked 是回合撞上一个无人能答的权限请求, timeout 是墙钟到点。它们同样要留痕 —— 一次
-- 没发出去的外发尝试, 和一次成功的外发一样值得被看见。
--
-- error 只存诊断文本, 绝不含密钥, 也不是回帖给用户的那句话。

CREATE TABLE IF NOT EXISTS im_robot_turns (
  id             TEXT PRIMARY KEY,   -- uuid
  robot_id       TEXT NOT NULL,      -- 引用 im_robots.id
  thread_key     TEXT NOT NULL,      -- 引用 im_robot_threads.thread_key (同 robot_id 下)
  chat_id        TEXT NOT NULL,      -- 平台会话 id
  sender_id      TEXT NOT NULL,      -- 发起提问的平台用户 id
  in_message_id  TEXT NOT NULL,      -- 触发本回合的入站消息 id
  session_id     TEXT,               -- 本回合运行的 agent 会话 id; 启动失败时为空
  started_at     INTEGER NOT NULL,   -- epoch ms
  finished_at    INTEGER,            -- epoch ms; 空 = 仍在进行 (或进程中断)
  outcome        TEXT                -- complete=已回答 / error=运行出错 / blocked=撞上无人能答的权限请求
                 CHECK(outcome IS NULL OR outcome IN
                   ('complete','error','blocked','timeout','guard_refused')),
  outbound_chars INTEGER NOT NULL    -- 实际发往平台的字符数; 0 = 什么都没发出去
                 DEFAULT 0,
  out_message_id TEXT,               -- 平台返回的回帖消息 id
  error          TEXT                -- 诊断文本, 不含凭据
);
CREATE INDEX IF NOT EXISTS idx_im_turn_robot ON im_robot_turns(robot_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_im_turn_thread ON im_robot_turns(robot_id, thread_key, started_at DESC);
