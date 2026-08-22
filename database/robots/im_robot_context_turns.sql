-- im_robot_context_turns — 发送者隔离 Conversation 的可恢复 IM 可见上下文
-- 所属模块: robots
-- 对应 Store: server/src/features/im/robot-store.ts
-- 迁移: migrate/2026/08/21/045-im-robot-sender-isolation.sql
--
-- 存在理由: 连续对话的事实源。只存通过入站守卫的用户文本与平台确认投递的最终 assistant 文本;
-- 思考、工具调用/结果、文件内容、被出站守卫拦截的回答不落库。裁决见 ADR-0048。
--
-- 认领以 (platform, robot_id, in_message_id) 唯一; 待处理行只存标识与状态, 正文在投递成功后
-- 同事务写入并转为 committed。失败行正文保持空。只有 committed 进入恢复上下文。
--
-- 保留: 每 Conversation 最近 50 个 committed 回合; 自 committed_at 起 30 天; 超出即硬删除整对,
-- 不软删、不摘要、不拆对。

CREATE TABLE IF NOT EXISTS im_robot_context_turns (
  id              TEXT PRIMARY KEY,   -- uuid
  platform        TEXT NOT NULL,
  robot_id        TEXT NOT NULL,
  thread_key      TEXT NOT NULL,
  sender_id       TEXT NOT NULL,
  in_message_id   TEXT NOT NULL,      -- 触发本回合的入站消息 id
  status          TEXT NOT NULL
                  CHECK(status IN ('pending','committed','failed')),
  user_text       TEXT NOT NULL DEFAULT '',  -- 仅 committed 非空
  assistant_text  TEXT NOT NULL DEFAULT '',  -- 仅 committed 非空; ≤4000 码点
  seq             INTEGER,            -- 提交顺序; pending/failed 为空
  committed_at    INTEGER,            -- epoch ms; 仅 committed
  created_at      INTEGER NOT NULL,   -- epoch ms
  UNIQUE (platform, robot_id, in_message_id)
);
CREATE INDEX IF NOT EXISTS idx_im_ctx_conversation
  ON im_robot_context_turns(platform, robot_id, thread_key, sender_id, status, seq);
CREATE INDEX IF NOT EXISTS idx_im_ctx_committed_at
  ON im_robot_context_turns(committed_at);
