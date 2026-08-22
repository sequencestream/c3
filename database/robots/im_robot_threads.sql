-- im_robot_threads — 发送者隔离的机器人 Conversation (四维身份 ↔ 可选原生会话缓存)
-- 所属模块: robots
-- 对应 Store: server/src/features/im/robot-store.ts
-- 迁移: migrate/2026/08/20/044-im-robots.sql, migrate/2026/08/21/045-im-robot-sender-isolation.sql
--
-- 存在理由: 同一 IM 线程内不同发送者不得共享上下文。会话身份是
-- (platform, robot_id, thread_key, sender_id); session_id 只是同 Conversation、同 vendor 下的
-- 续接缓存, 不是恢复事实源。可恢复正文在 im_robot_context_turns。
--
-- thread_key 仍是平台中性的线程身份 (话题 → 回复链根 → 会话), 由 provider 归一化得出。
-- sender_id 是平台提供的不透明外部标识, 只在所属平台/机器人/线程内有意义, 不是 c3 用户。
--
-- 旧群级共享行 (无 sender_id) 在迁移中安全切断: 不复制 session_id 到任一发送者 Conversation。

CREATE TABLE IF NOT EXISTS im_robot_threads (
  platform         TEXT NOT NULL,      -- IM 平台; 与 robot 绑定, 参与唯一身份
  robot_id         TEXT NOT NULL,      -- 引用 im_robots.id
  thread_key       TEXT NOT NULL,      -- 归一化线程身份
  sender_id        TEXT NOT NULL,      -- 平台发送者 id (非空)
  chat_id          TEXT NOT NULL,      -- 平台会话 id, 回帖目标
  session_id       TEXT,               -- 可选原生会话缓存; 空 = 从数据库上下文恢复
  vendor           TEXT NOT NULL,      -- 产生 session_id 的 vendor; 不匹配则不得恢复
  context_revision INTEGER NOT NULL    -- 已提交上下文修订号; 缓存与修订不一致时舍弃缓存
                   DEFAULT 0,
  turn_count       INTEGER NOT NULL    -- 已提交 Context Turn 数
                   DEFAULT 0,
  created_at       INTEGER NOT NULL,   -- epoch ms
  last_active_at   INTEGER NOT NULL,   -- epoch ms
  PRIMARY KEY (platform, robot_id, thread_key, sender_id)
);
CREATE INDEX IF NOT EXISTS idx_im_thread_session ON im_robot_threads(session_id);
CREATE INDEX IF NOT EXISTS idx_im_thread_idle ON im_robot_threads(last_active_at);
