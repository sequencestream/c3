-- im_robot_threads — IM 会话线程 ↔ agent 会话映射 (一条线程即一次持续对话)
-- 所属模块: robots
-- 对应 Store: server/src/features/im/robot-store.ts
-- 迁移: migrate/2026/08/20/044-im-robots.sql
--
-- 存在理由: 让群里的一串来回读起来是一次连续对话, 而不是每条消息都从零开始。第二条消息起,
-- 机器人以本表记下的 session_id resume 同一个会话, 上下文因此跨消息保留。
--
-- thread_key 是平台中性的线程身份, 由 provider 归一化得出: 优先用平台原生话题 id, 没有则用回复链
-- 根 id, 都没有则退到会话 id (即「一个群 = 一条长对话」)。没有原生话题概念的平台自然落到最后一档,
-- 不需要为此分支。归一化规则本身是纯函数, 不在本表。
--
-- vendor 是冻结的, agent_id 不是。会话 id 只在产生它的 vendor 内可 resume, 所以线程必须记住自己
-- 属于哪个 vendor; 而具体用哪个 agent 每轮重新解析 —— 机器人可以绑定一个 agent group, 组内故障
-- 转移正是按轮次生效的 (ADR-0029)。
--
-- last_message_id 是幂等的第二道防线。平台通常自己会去重, 但一次重连后的重投递必须落在同一条
-- 线程上被认出来, 否则用户会看到机器人把同一个问题回答两遍。
--
-- session_id 可空: 线程的第一条消息在会话真正绑定前就已存在, 绑定回填后才有值。

CREATE TABLE IF NOT EXISTS im_robot_threads (
  robot_id        TEXT NOT NULL,      -- 引用 im_robots.id
  thread_key      TEXT NOT NULL,      -- 归一化线程身份 (话题 id → 回复链根 id → 会话 id)
  chat_id         TEXT NOT NULL,      -- 平台会话 id, 回帖目标
  session_id      TEXT,               -- 已绑定的 agent 会话 id; 空 = 尚未绑定 (线程首轮)
  vendor          TEXT NOT NULL,      -- 产生 session_id 的 vendor; resume 只在同 vendor 内成立
  turn_count      INTEGER NOT NULL    -- 已完成回合数, 仅用于展示
                  DEFAULT 0,
  last_message_id TEXT,               -- 最近已处理的入站消息 id; 重复投递的第二道防线
  created_at      INTEGER NOT NULL,   -- epoch ms
  last_active_at  INTEGER NOT NULL,   -- epoch ms; 空闲线程回收的依据
  PRIMARY KEY (robot_id, thread_key)
);
CREATE INDEX IF NOT EXISTS idx_im_thread_session ON im_robot_threads(session_id);
CREATE INDEX IF NOT EXISTS idx_im_thread_idle ON im_robot_threads(last_active_at);
