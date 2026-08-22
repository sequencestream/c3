-- im_robots L0 主动播报配置 + 外发确认哈希
-- 迁移: migrate/2026/08/22/048-im-robot-broadcast-config.sql
--
-- outbound_ack_hash 记录管理员确认时刻的外发配置规范化哈希；变更回复面或 L0
-- 目标后哈希失效，须重新确认方可外发。
-- broadcast_* 列默认关闭，存量机器人不产生主动播报。

ALTER TABLE im_robots ADD COLUMN outbound_ack_hash TEXT;
ALTER TABLE im_robots ADD COLUMN broadcast_event_types TEXT NOT NULL DEFAULT '[]';
ALTER TABLE im_robots ADD COLUMN broadcast_to_bound_users INTEGER NOT NULL DEFAULT 0;
ALTER TABLE im_robots ADD COLUMN broadcast_group_chat_ids TEXT NOT NULL DEFAULT '[]';
